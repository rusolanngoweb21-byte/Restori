import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../services/web/storage.ts";

const cap = { detector: "text-ai" as const, version: "a".repeat(64), languages: ["en" as const] };
const input = { detector: "text-ai" as const, language: "en" as const, text: "private input" };
const completed = { status: "completed" as const, scoreKind: "uncalibrated_model_score" as const,
  result: { isAI: false, confidence: 70, modality: "text" as const, details: "Test only" } };
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "prizma-storage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "data", "prizma.sqlite");
}

test("disk restart retains a pending job, private input and permanent deny with private permissions", async t => {
  const path = fixture(t);
  let app = openStore(path);
  const job = await app.store.enqueue("owner", cap, input, "key");
  await app.store.block("hash", "sticky denial");
  app.close();
  app = openStore(path);
  t.after(() => app.close());
  assert.equal((await app.store.job(job.id, "owner"))?.state, "queued");
  assert.equal(await app.store.job(job.id, "other"), null);
  assert.equal((await app.store.blocked("hash"))?.reason, "sticky denial");
  assert.deepEqual((await app.store.claim([cap]))?.input, input);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
});

test("SQLite batch rolls back every write when a later statement fails", async t => {
  const app = openStore(fixture(t)); t.after(() => app.close());
  const db = app.store.db;
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO threat_blocks VALUES (?,?,?)").bind("hash", "reason", 0),
    db.prepare("INSERT INTO missing_table VALUES (?)").bind("failure"),
  ]));
  assert.equal(await app.store.blocked("hash"), null);
  await app.store.block("later", "transaction is usable after rollback");
  assert(await app.store.blocked("later"));
});

test("two connections deduplicate and claim once; stale leases cannot publish or remove current input", async t => {
  let now = 1_000_000;
  const path = fixture(t), a = openStore(path, () => now), b = openStore(path, () => now);
  t.after(() => { b.close(); a.close(); });
  const jobs = await Promise.all([a, b].map(x => x.store.enqueue("owner", cap, input, "key")));
  assert.equal(jobs[0].id, jobs[1].id);
  const claims = await Promise.all([a, b].map(x => x.store.claim([cap])));
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean)!;
  now += 91_000;
  const next = await b.store.claim([cap]); assert(next);
  await assert.rejects(a.store.complete(first.id, first.lease, completed), /истёк|завершено/);
  assert.equal(await a.store.cacheGet("key"), null);
  assert(await a.store.bucket.get("inputs/" + first.id));
  await b.store.complete(next.id, next.lease, completed);
  assert.equal(await a.store.bucket.get("inputs/" + first.id), null);
  assert.deepEqual((await a.store.job(first.id, "owner"))?.outcome, completed);
});

test("completion failure rolls back cache and permanent deny; a retry commits both before input deletion", async t => {
  const path = fixture(t), app = openStore(path); t.after(() => app.close());
  const cap = { detector: "url-signature" as const, version: "b".repeat(64), languages: [] };
  const job = await app.store.enqueue("owner", cap, { detector: "url-signature", url: "https://example.com/" }, "signature:hash");
  const lease = await app.store.claim([cap]); assert(lease);
  const outcome = { status: "completed" as const, signature: { status: "malicious" as const,
    signature: "fixture", engine: "fixture", bytes: 1, finalUrlHash: "c".repeat(64), redirectCount: 0 } };
  const sql = new DatabaseSync(path); t.after(() => sql.close());
  sql.exec("CREATE TRIGGER fail_completion BEFORE UPDATE OF state ON analysis_jobs WHEN NEW.state='finished' BEGIN SELECT RAISE(ABORT,'simulated crash'); END");
  await assert.rejects(app.store.complete(job.id, lease.lease, outcome), /simulated crash/);
  assert.equal(await app.store.cacheGet("signature:hash"), null);
  assert.equal(await app.store.blocked("hash"), null);
  assert(await app.store.bucket.get("inputs/" + job.id));
  sql.exec("DROP TRIGGER fail_completion");
  await app.store.complete(job.id, lease.lease, outcome);
  assert(await app.store.blocked("hash"));
  assert.deepEqual(await app.store.cacheGet("signature:hash"), outcome);
  assert.equal(await app.store.bucket.get("inputs/" + job.id), null);
});

test("bounded cursor cleanup removes old orphans over multiple pages but preserves a recent live upload", async t => {
  let now = 1_000_000;
  const app = openStore(fixture(t), () => now); t.after(() => app.close());
  for (let i = 0; i < 205; i++) await app.store.bucket.put("inputs/orphan-" + String(i).padStart(3, "0"), "private");
  now += 601_000;
  const job = await app.store.enqueue("owner", cap, input, "live");
  for (let i = 0; i < 4; i++) await app.store.cleanup();
  const left = await app.store.bucket.list({ prefix: "inputs/", limit: 100 });
  assert.deepEqual(left.objects.map(x => x.key), ["inputs/" + job.id]);
});
