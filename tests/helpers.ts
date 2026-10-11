import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Store } from "../lib/store.ts";
import { openStore } from "../services/web/storage.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
const cleanup: (() => void)[] = [];
after(() => { for (const close of cleanup.reverse()) close(); });
/** Real SQLite statements and transactions, with a small D1/R2 transport adapter for local QA. */
export function testStore(clock = Date.now) {
  if (process.env.PRIZMA_TEST_STORAGE === "disk") {
    const directory = mkdtempSync(join(tmpdir(), "prizma-security-"));
    const path = join(directory, "app.sqlite"), app = openStore(path, clock), sql = new DatabaseSync(path);
    cleanup.push(() => { sql.close(); app.close(); rmSync(directory, { recursive: true, force: true }); });
    return { store: app.store, sql, objects: { get size() { return Number(sql.prepare("SELECT count(*) n FROM input_objects").get()!.n); } } };
  }
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    readFileSync(
      new URL("../drizzle/0000_big_expediter.sql", import.meta.url),
      "utf8",
    ),
  );
  const wrap = (query: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => wrap(query, values),
    first: async () => sql.prepare(query).get(...(args as never[])) ?? null,
    all: async () => ({
      results: sql.prepare(query).all(...(args as never[])),
    }),
    run: async () => {
      const r = sql.prepare(query).run(...(args as never[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  const db = {
    prepare: wrap,
    batch: async (statements: ReturnType<typeof wrap>[]) => {
      sql.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sql.exec("COMMIT");
        return result;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const objects = new Map<string, { body: string; uploaded: Date }>();
  const bucket = {
    put: async (key: string, body: string) =>
      objects.set(key, { body, uploaded: new Date(clock()) }),
    get: async (key: string) => {
      const v = objects.get(key);
      return v ? { text: async () => v.body } : null;
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    list: async () => ({
      objects: [...objects].map(([key, v]) => ({ key, uploaded: v.uploaded })),
      truncated: false,
    }),
  };
  return {
    store: new Store(
      db as unknown as D1Database,
      bucket as unknown as R2Bucket,
      clock,
    ),
    sql,
    objects,
  };
}
export const textFixture =
  "The community garden opened on a rainy Saturday morning. Neighbours brought wooden boxes, seeds, and a pot of hot tea. We spent the first hour clearing the path beside the old wall, then measured the beds and wrote a planting schedule. I had never grown carrots before, so one of the volunteers showed me how shallow the rows should be. By noon the rain had stopped. Two children counted the worms we found in the soil, while their grandfather repaired a broken bench. We agreed to meet again next weekend and see which seeds had started to grow.";
