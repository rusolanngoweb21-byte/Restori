import { MAX_CAPABILITIES } from "./languages.ts";
import {
  capabilitySchema,
  outcomeSchema,
  type Capability,
  type Detector,
  type JobInput,
  type JobView,
  type Outcome,
} from "./contracts.ts";
import { ApiError, randomToken } from "./http.ts";

type JobRow = {
  id: string;
  owner: string;
  detector: Detector;
  version: string;
  cache_key: string;
  payload_key: string;
  state: "queued" | "running" | "finished";
  outcome: string | null;
  created_at: number;
  expires_at: number;
  attempts: number;
  lease: string | null;
  lease_until: number;
};
export class Store {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly now: () => number;
  constructor(db: D1Database, bucket: R2Bucket, now = Date.now) {
    this.db = db;
    this.bucket = bucket;
    this.now = now;
  }
  async cacheGet<T>(key: string): Promise<T | null> {
    const row = await this.db
      .prepare(
        "SELECT value FROM runtime_cache WHERE key = ? AND expires_at > ?",
      )
      .bind(key, this.now())
      .first<{ value: string }>();
    return row ? (JSON.parse(row.value) as T) : null;
  }
  async cacheSet(key: string, value: unknown, ttl: number) {
    await this.db
      .prepare(
        "INSERT INTO runtime_cache (key,value,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
      )
      .bind(key, JSON.stringify(value), this.now() + ttl)
      .run();
  }
  async rate(key: string, maximum: number, ttl = 60000) {
    const now = this.now();
    const row = await this.db
      .prepare(
        "INSERT INTO rate_windows (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count",
      )
      .bind(key, now + ttl, now, now)
      .first<{ count: number }>();
    if (!row || row.count > maximum)
      throw new ApiError(
        429,
        "RATE_LIMIT",
        "Слишком много запросов. Подождите минуту.",
      );
  }
  async blocked(hash: string) {
    return this.db
      .prepare("SELECT reason FROM threat_blocks WHERE hash=?")
      .bind(hash)
      .first<{ reason: string }>();
  }
  async block(hash: string, reason: string) {
    // Sticky deny. There is intentionally no public API to clear it.
    await this.db
      .prepare(
        "INSERT INTO threat_blocks (hash,reason,created_at) VALUES (?,?,?) ON CONFLICT(hash) DO NOTHING",
      )
      .bind(hash, reason, this.now())
      .run();
  }
  async capabilities(): Promise<Capability[]> {
    const rows = await this.db
      .prepare(
        "SELECT capabilities FROM analysis_workers WHERE expires_at > ? LIMIT 32",
      )
      .bind(this.now())
      .all<{ capabilities: string }>();
    const unique = new Map<string, Capability>();
    for (const row of rows.results)
      for (const cap of capabilitySchema
        .array()
        .max(MAX_CAPABILITIES)
        .parse(JSON.parse(row.capabilities)))
        unique.set(cap.detector + cap.version, cap);
    return [...unique.values()];
  }
  async heartbeat(id: string, capabilities: Capability[]) {
    await this.db
      .prepare(
        "INSERT INTO analysis_workers (id,capabilities,expires_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET capabilities=excluded.capabilities,expires_at=excluded.expires_at",
      )
      .bind(id, JSON.stringify(capabilities), this.now() + 45000)
      .run();
  }
  private view(row: JobRow, cached = false): JobView {
    return {
      id: row.id,
      detector: row.detector,
      version: row.version,
      state: row.state,
      outcome: row.outcome
        ? outcomeSchema.parse(JSON.parse(row.outcome))
        : null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      cached,
    };
  }
  async job(id: string, owner: string): Promise<JobView | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM analysis_jobs WHERE id=? AND owner=? AND expires_at>?",
      )
      .bind(id, owner, this.now())
      .first<JobRow>();
    return row ? this.view(row) : null;
  }
  async enqueue(
    owner: string,
    capability: Capability,
    input: JobInput,
    cacheKey: string,
  ): Promise<JobView> {
    const cached = await this.cacheGet<Outcome>(cacheKey);
    const outcome = cached ? outcomeSchema.parse(cached) : null;
    const id = crypto.randomUUID(),
      now = this.now(),
      payloadKey = `inputs/${id}`;
    const count = await this.db
      .prepare(
        "SELECT count(*) AS n FROM analysis_jobs WHERE state!='finished' AND expires_at>?",
      )
      .bind(now)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 1000)
      throw new ApiError(
        503,
        "QUEUE_FULL",
        "Очередь заполнена. Попробуйте позже.",
      );
    if (!outcome)
      await this.bucket.put(payloadKey, JSON.stringify(input), {
        httpMetadata: { contentType: "application/json" },
      });
    try {
      // One SQLite statement makes deduplication atomic across Worker isolates.
      const row = await this.db
        .prepare(
          "INSERT INTO analysis_jobs (id,owner,detector,version,cache_key,payload_key,state,outcome,created_at,expires_at,attempts,lease_until) SELECT ?,?,?,?,?,?,?,?,?,?,0,0 WHERE (SELECT count(*) FROM analysis_jobs WHERE state!='finished' AND expires_at>?)<1000 AND NOT EXISTS (SELECT 1 FROM analysis_jobs WHERE owner=? AND cache_key=? AND state!='finished' AND expires_at>?) RETURNING *",
        )
        .bind(
          id,
          owner,
          capability.detector,
          capability.version,
          cacheKey,
          outcome ? "" : payloadKey,
          outcome ? "finished" : "queued",
          outcome ? JSON.stringify(outcome) : null,
          now,
          now + 86400000,
          now,
          owner,
          cacheKey,
          now,
        )
        .first<JobRow>();
      if (row) return this.view(row, !!outcome);
      const existing = await this.db
        .prepare(
          "SELECT * FROM analysis_jobs WHERE owner=? AND cache_key=? AND state!='finished' AND expires_at>? LIMIT 1",
        )
        .bind(owner, cacheKey, now)
        .first<JobRow>();
      if (!outcome) await this.bucket.delete(payloadKey);
      if (!existing) throw new Error("QUEUE_RACE");
      return this.view(existing);
    } catch (error) {
      if (!outcome) await this.bucket.delete(payloadKey);
      throw error;
    }
  }
  async claim(capabilities: Capability[]) {
    if (!capabilities.length) return null;
    const lease = randomToken(),
      now = this.now();
    const predicates = capabilities
      .map(() => "(detector=? AND version=?)")
      .join(" OR ");
    const row = await this.db
      .prepare(
        `UPDATE analysis_jobs SET state='running',lease=?,lease_until=?,attempts=attempts+1 WHERE id=(SELECT id FROM analysis_jobs WHERE expires_at>? AND attempts<2 AND (state='queued' OR (state='running' AND lease_until<=?)) AND (${predicates}) ORDER BY created_at LIMIT 1) RETURNING *`,
      )
      .bind(
        lease,
        now + 90000,
        now,
        now,
        ...capabilities.flatMap((c) => [c.detector, c.version]),
      )
      .first<JobRow>();
    if (!row) return null;
    const payload = await this.bucket.get(row.payload_key);
    if (!payload) {
      await this.complete(row.id, lease, {
        status: "failed",
        code: "INPUT_MISSING",
        details: "Исходные данные недоступны. Повторите проверку.",
      });
      return null;
    }
    return {
      id: row.id,
      lease,
      version: row.version,
      createdAt: row.created_at,
      input: JSON.parse(await payload.text()) as JobInput,
    };
  }
  async complete(id: string, lease: string, supplied: Outcome) {
    const outcome = outcomeSchema.parse(supplied),
      now = this.now();
    const row = await this.db
      .prepare(
        "SELECT * FROM analysis_jobs WHERE id=? AND lease=? AND state='running' AND lease_until>? AND expires_at>?",
      )
      .bind(id, lease, now, now)
      .first<JobRow>();
    if (!row)
      throw new ApiError(
        409,
        "LEASE_EXPIRED",
        "Задание уже завершено или срок обработки истёк.",
      );
    if (outcome.status === "completed") {
      if ((row.detector === "url-signature") !== "signature" in outcome)
        throw new ApiError(400, "RESULT_TYPE", "Неверный тип результата.");
      if (
        "result" in outcome &&
        outcome.result.modality !==
          (row.detector === "text-ai" ? "text" : "image")
      )
        throw new ApiError(400, "RESULT_TYPE", "Неверная модальность.");
    }
    const statements: D1PreparedStatement[] = [];
    const live =
      "EXISTS (SELECT 1 FROM analysis_jobs WHERE id=? AND lease=? AND state='running' AND lease_until>? AND expires_at>?)";
    const guard = [id, lease, now, now];
    if (outcome.status === "completed") {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO runtime_cache (key,value,expires_at) SELECT ?,?,? WHERE ${live} ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`,
          )
          .bind(
            row.cache_key,
            JSON.stringify(outcome),
            now + (row.detector === "url-signature" ? 60000 : 21600000),
            ...guard,
          ),
      );
      if ("signature" in outcome && outcome.signature.status === "malicious")
        statements.push(
          this.db
            .prepare(
              `INSERT INTO threat_blocks (hash,reason,created_at) SELECT ?,?,? WHERE ${live} ON CONFLICT(hash) DO NOTHING`,
            )
            .bind(
              row.cache_key.replace(/^signature:/, ""),
              `Антивирус обнаружил: ${outcome.signature.signature || "вредоносное содержимое"}.`,
              now,
              ...guard,
            ),
        );
    }
    statements.push(
      this.db
        .prepare(
          "UPDATE analysis_jobs SET state='finished',outcome=?,lease=NULL,lease_until=0 WHERE id=? AND lease=? AND state='running' AND lease_until>? AND expires_at>?",
        )
        .bind(JSON.stringify(outcome), ...guard),
    );
    // Result and sticky deny commit atomically before the raw input is deleted.
    const committed = await this.db.batch(statements);
    if (!committed[committed.length - 1].meta.changes)
      throw new ApiError(
        409,
        "LEASE_EXPIRED",
        "Задание уже передано другому обработчику.",
      );
    if (row.payload_key) await this.bucket.delete(row.payload_key);
  }
  async cleanup() {
    const now = this.now();
    const expired = await this.db
      .prepare(
        "SELECT id,payload_key FROM analysis_jobs WHERE expires_at<=? OR (state!='finished' AND created_at<?) LIMIT 100",
      )
      .bind(now, now - 600000)
      .all<{ id: string; payload_key: string }>();
    for (const row of expired.results) {
      if (row.payload_key) await this.bucket.delete(row.payload_key);
      await this.db
        .prepare("DELETE FROM analysis_jobs WHERE id=?")
        .bind(row.id)
        .run();
    }
    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM runtime_cache WHERE key IN (SELECT key FROM runtime_cache WHERE expires_at<=? LIMIT 500)",
        )
        .bind(now),
      this.db
        .prepare(
          "DELETE FROM rate_windows WHERE key IN (SELECT key FROM rate_windows WHERE expires_at<=? LIMIT 10000)",
        )
        .bind(now),
      this.db
        .prepare("DELETE FROM analysis_workers WHERE expires_at<=?")
        .bind(now),
      this.db
        .prepare(
          "UPDATE analysis_jobs SET state='finished',outcome=?,lease=NULL WHERE state='running' AND attempts>=2 AND lease_until<=?",
        )
        .bind(
          JSON.stringify({
            status: "failed",
            code: "WORKER_TIMEOUT",
            details: "Обработка не завершилась вовремя. Повторите проверку.",
          }),
          now,
        ),
    ]);
    // Repair orphaned uploads left by a process crash between R2 put and SQL insert.
    const cursor = await this.cacheGet<string>("maintenance:r2-cursor");
    const objects = await this.bucket.list({
      prefix: "inputs/",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of objects.objects) {
      if (object.uploaded.getTime() > now - 600000) continue;
      const job = await this.db
        .prepare(
          "SELECT state,expires_at FROM analysis_jobs WHERE payload_key=? LIMIT 1",
        )
        .bind(object.key)
        .first<{ state: string; expires_at: number }>();
      if (!job || job.state === "finished" || job.expires_at <= now)
        await this.bucket.delete(object.key);
    }
    await this.cacheSet(
      "maintenance:r2-cursor",
      objects.truncated ? objects.cursor : "",
      3600000,
    );
  }
}
