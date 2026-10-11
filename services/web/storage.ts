import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Store } from "../../lib/store.ts";

/** A local transport for the existing Store; application decisions stay in lib/store.ts. */
export function openStore(filename: string, clock = Date.now) {
  const path = resolve(filename), directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error("DATA_DIRECTORY_REQUIRED");
  chmodSync(directory, 0o700);
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  if (!lstatSync(path).isFile()) throw new Error("DATA_FILE_REQUIRED");
  chmodSync(path, 0o600);
  const sql = new DatabaseSync(path);
  try {
    sql.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;");
    sql.exec("BEGIN IMMEDIATE");
    const version = Number(sql.prepare("PRAGMA user_version").get()!.user_version);
    if (version === 0) {
      sql.exec(readFileSync(new URL("../../drizzle/0000_big_expediter.sql", import.meta.url), "utf8"));
      sql.exec("CREATE TABLE input_objects (key TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL, uploaded INTEGER NOT NULL); PRAGMA user_version=1;");
    } else if (version !== 1) throw new Error("UNKNOWN_DATABASE_VERSION");
    sql.exec("COMMIT");
  } catch (error) {
    try { sql.exec("ROLLBACK"); } catch { /* No transaction if initialization failed first. */ }
    sql.close();
    throw error;
  }

  const operations = new WeakMap<object, () => { success: boolean; meta: { changes: number } }>();
  function prepare(query: string, args: SQLInputValue[] = []) {
    const run = () => {
      const result = sql.prepare(query).run(...args);
      return { success: true, meta: { changes: Number(result.changes) } };
    };
    const statement = {
      bind: (...values: SQLInputValue[]) => prepare(query, values),
      first: async () => sql.prepare(query).get(...args) ?? null,
      all: async () => ({ results: sql.prepare(query).all(...args) }),
      run: async () => run(),
    };
    operations.set(statement, run);
    return statement;
  }
  const db = {
    prepare,
    batch: async (statements: object[]) => {
      // No await inside this transaction: unrelated handlers cannot join its commit.
      sql.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(statement => {
          const run = operations.get(statement);
          if (!run) throw new Error("FOREIGN_STATEMENT");
          return run();
        });
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const bucket = {
    put: async (key: string, body: string) => {
      if (key.length > 256 || Buffer.byteLength(body) > 2_850_000) throw new Error("INPUT_LIMIT");
      sql.prepare("INSERT INTO input_objects VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,uploaded=excluded.uploaded")
        .run(key, body, clock());
    },
    get: async (key: string) => {
      const row = sql.prepare("SELECT body FROM input_objects WHERE key=?").get(key);
      return row ? { text: async () => String(row.body) } : null;
    },
    delete: async (key: string) => { sql.prepare("DELETE FROM input_objects WHERE key=?").run(key); },
    list: async ({ prefix = "", limit = 100, cursor = "" } = {}) => {
      const count = Math.min(1000, Math.max(1, Math.floor(limit)));
      if (cursor.length > 1500 || !/^[\w-]*$/.test(cursor)) throw new Error("INVALID_CURSOR");
      const after = Buffer.from(cursor, "base64url").toString("utf8");
      const rows = sql.prepare("SELECT key,uploaded FROM input_objects WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
        .all(prefix.length, prefix, after, count + 1);
      const objects = rows.slice(0, count).map(row => ({ key: String(row.key), uploaded: new Date(Number(row.uploaded)) }));
      const truncated = rows.length > count;
      return { objects, truncated, ...(truncated ? { cursor: Buffer.from(objects.at(-1)!.key).toString("base64url") } : {}) };
    },
  };
  let closed = false;
  return {
    store: new Store(db as unknown as D1Database, bucket as unknown as R2Bucket, clock),
    close() {
      if (closed) return;
      // A second connection may be busy; SQLite still keeps its durable WAL on close.
      try { sql.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { sql.close(); closed = true; }
    },
  };
}
