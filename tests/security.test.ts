import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { testStore, textFixture } from "./helpers.ts";
import { createApi } from "../lib/api.ts";
import { checkThreat } from "../lib/threats.ts";
import { validateMedia, enqueueMedia } from "../lib/media.ts";
import { sha256, session, denyNavigation } from "../lib/http.ts";
import { withThreat } from "../lib/report.ts";
import { evaluate, normalizeInput } from "../lib/scanner.ts";
import { LruCache, SingleFlight } from "../lib/cache.ts";
import {
  resolvePublic,
  safeDownload,
} from "../services/analyzer/safe-download.ts";
import { scanBytes } from "../services/analyzer/clamav.ts";
const capability = {
  detector: "text-ai" as const,
  version: "a".repeat(64),
  languages: ["en" as const],
};
const completed = {
  status: "completed" as const,
  scoreKind: "uncalibrated_model_score" as const,
  result: {
    isAI: true,
    confidence: 81.3,
    modality: "text" as const,
    details: "Fixture model result, not measured accuracy.",
  },
};
const request = (
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
) =>
  new Request("https://prizma.test" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
const cleanProviders = (async (input: RequestInfo | URL) =>
  String(input).includes("urlhaus")
    ? Response.json({ query_status: "no_results" })
    : Response.json({})) as typeof fetch;
const settings = {
  WEBRISK_API_KEY: "fixture",
  URLHAUS_AUTH_KEY: "fixture",
  WORKER_SERVICE_TOKEN: "s".repeat(64),
};

test("media validation rejects short text, wrong language, SVG and oversized images", () => {
  assert.throws(() =>
    validateMedia({ detector: "text-ai", language: "en", text: "short" }),
  );
  assert.throws(() =>
    validateMedia({
      detector: "text-ai",
      language: "en",
      text: "Очень длинный русский текст. ".repeat(90),
    }),
  );
  assert.throws(() =>
    validateMedia({
      detector: "image-ai",
      imageBase64: Buffer.from("<svg/>").toString("base64"),
    }),
  );
  assert.throws(() =>
    validateMedia({ detector: "image-ai", imageBase64: "A".repeat(3000000) }),
  );
  assert.equal(
    validateMedia({ detector: "text-ai", language: "en", text: textFixture })
      .detector,
    "text-ai",
  );
});
test("absent model is unavailable, never a fabricated 0% human result", async () => {
  const { store } = testStore();
  await assert.rejects(
    enqueueMedia(store, "owner", {
      detector: "text-ai",
      language: "en",
      text: textFixture,
    }),
    /не подключена/,
  );
});
test("durable queue deduplicates, checks ownership, fences leases, removes input, and caches by owner/version", async () => {
  let now = 1000000;
  const { store, objects } = testStore(() => now);
  await store.heartbeat("worker", [capability]);
  const input = {
    detector: "text-ai" as const,
    language: "en" as const,
    text: textFixture,
  };
  const first = await enqueueMedia(store, "owner-a", input),
    duplicate = await enqueueMedia(store, "owner-a", input);
  assert.equal(first.id, duplicate.id);
  assert.equal(await store.job(first.id, "owner-b"), null);
  const lease1 = await store.claim([capability]);
  assert(lease1);
  assert.equal(await store.claim([capability]), null);
  now += 91000;
  const lease2 = await store.claim([capability]);
  assert(lease2);
  assert.notEqual(lease1.lease, lease2.lease);
  await assert.rejects(
    store.complete(first.id, lease1.lease, completed),
    /истёк|завершено/,
  );
  await store.complete(first.id, lease2.lease, completed);
  assert.equal(objects.size, 0);
  assert.deepEqual((await store.job(first.id, "owner-a"))?.outcome, completed);
  await store.heartbeat("worker", [capability]);
  const cached = await enqueueMedia(store, "owner-a", input);
  assert.equal(cached.cached, true);
  const privateCopy = await enqueueMedia(store, "owner-b", input);
  assert.equal(privateCopy.cached, false);
  await store.heartbeat("worker", [{ ...capability, version: "b".repeat(64) }]);
  const changed = await enqueueMedia(store, "owner-a", input);
  assert.equal(changed.cached, false);
});
test("cache write is fenced if another worker takes the lease between read and commit", async () => {
  let now = 1000000;
  const { store, sql } = testStore(() => now);
  await store.heartbeat("worker", [capability]);
  const job = await enqueueMedia(store, "owner", {
      detector: "text-ai",
      language: "en",
      text: textFixture,
    }),
    lease = await store.claim([capability]);
  assert(lease);
  const original = store.db.batch.bind(store.db);
  store.db.batch = async (statements) => {
    sql
      .prepare("UPDATE analysis_jobs SET lease='replacement' WHERE id=?")
      .run(job.id);
    return original(statements);
  };
  await assert.rejects(
    store.complete(job.id, lease.lease, completed),
    /другому/,
  );
  assert.equal(
    sql.prepare("SELECT count(*) AS n FROM runtime_cache").get()?.n,
    0,
  );
});
test("reputation outages and malformed responses fail closed", async () => {
  const { store } = testStore();
  const result = await checkThreat(
    "https://example.com/",
    store,
    {},
    cleanProviders,
  );
  assert.equal(result.status, "hold");
  assert.equal(result.navigationAllowed, false);
  const malformed = await checkThreat(
    "https://example.org/",
    store,
    settings,
    (async () => Response.json({ unexpected: "shape" })) as typeof fetch,
  );
  assert.equal(malformed.navigationAllowed, false);
});
test("malware match stays blocked when provider later returns clean or goes offline", async () => {
  const { store } = testStore();
  const malicious = (async (input: RequestInfo | URL) =>
    String(input).includes("urlhaus")
      ? Response.json({ query_status: "no_results" })
      : Response.json({
          threat: { threatTypes: ["MALWARE"] },
        })) as typeof fetch;
  const initial = await checkThreat(
    "https://example.com/malware",
    store,
    settings,
    malicious,
  );
  assert.equal(initial.status, "blocked");
  const again = await checkThreat(
    "https://example.com/malware#other",
    store,
    {},
    cleanProviders,
    true,
  );
  assert.equal(again.status, "blocked");
});
test("navigation cannot be authorized by a forged allow flag or by unknown results", async () => {
  const { store } = testStore();
  const api = createApi({ store, settings: {} });
  assert.equal(
    (
      await api.out(
        request("/api/out", {
          url: "https://example.com/",
          navigationAllowed: true,
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await api.out(request("/api/out", { url: "https://example.com/" })))
      .status,
    409,
  );
  assert.equal(
    (
      await api.out(
        request("/api/out", {
          url: "https://instagram.com@security-check.example/",
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api.out(
        request(
          "/api/out",
          { url: "https://example.com/" },
          { Origin: "https://attacker.example" },
        ),
      )
    ).status,
    403,
  );
});
test("only complete fresh checks allow redirect; revocation defeats previously clean cache", async () => {
  const { store } = testStore();
  const url = "https://example.com/",
    hash = await sha256(url);
  await store.cacheSet(
    "signature:" + hash,
    {
      status: "completed",
      signature: {
        status: "clean",
        signature: null,
        engine: "fixture",
        bytes: 100,
        finalUrlHash: hash,
        redirectCount: 0,
      },
    },
    60000,
  );
  const api = createApi({ store, settings, fetcher: cleanProviders });
  const response = await api.out(request("/api/out", { url }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), url);
  await store.block(hash, "Revoked");
  assert.equal((await api.out(request("/api/out", { url }))).status, 403);
});
test("the main report follows a block and form denial escapes provider text without a target link", async () => {
  const { store } = testStore();
  const url = "https://instagram.com@security-check.example/";
  const report = evaluate(url, normalizeInput(url), {
    a: null,
    aaaa: null,
    mx: null,
    txt: null,
    dmarc: null,
    ns: null,
    rdap: null,
    apple: null,
    rdapSource: "",
  });
  const threat = await checkThreat(url, store, {});
  const merged = withThreat(report, threat);
  assert.equal(merged.level, "high");
  assert.equal(merged.verdict, "Переход заблокирован");
  assert.equal(merged.summary, threat.reason);
  assert.equal(merged.signals.filter((s) => s.id === "reputation").length, 0);
  const form = new Request("https://prizma.test/api/out", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "url=https%3A%2F%2Fexample.com",
  });
  const denied = denyNavigation(form, '<script>alert("unsafe")</script>', 403),
    html = await denied.text();
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.has("location"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|Всё равно перейти|href="https:/);
});
test("worker endpoint requires a secret; anonymous sessions cannot read another result", async () => {
  const { store } = testStore();
  const api = createApi({ store, settings });
  assert.equal(
    (
      await api.claim(
        request("/api/internal/claim", {
          workerId: "test",
          capabilities: [capability],
        }),
      )
    ).status,
    401,
  );
  const cookie = "__Host-prizma_session=" + "a".repeat(64),
    identity = await session(
      new Request("https://prizma.test", { headers: { cookie } }),
    );
  const job = await store.enqueue(
    identity.owner,
    capability,
    { detector: "text-ai", language: "en", text: textFixture },
    "key",
  );
  assert.equal(
    (await api.job(new Request("https://prizma.test/api/jobs/" + job.id)))
      .status,
    404,
  );
  const response = await api.job(
    new Request("https://prizma.test/api/jobs/" + job.id, {
      headers: { cookie },
    }),
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("cache-control") || "",
    /private, no-store/,
  );
});
test("shared rate limit spans API instances", async () => {
  const { store } = testStore();
  for (let i = 0; i < 10; i++) await store.rate("same", 10);
  await assert.rejects(store.rate("same", 10), /Слишком/);
});
test("downloader refuses private/mixed DNS results, rebinding targets, metadata IPs and unsupported ports", async () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "10.1.2.3",
    "::1",
    "::ffff:127.0.0.1",
    "2001:20::1",
  ])
    await assert.rejects(
      resolvePublic("public.example", async () => [
        { address, family: address.includes(":") ? 6 : 4 },
      ]),
      /PRIVATE/,
    );
  await assert.rejects(
    resolvePublic("public.example", async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    /PRIVATE/,
  );
  await assert.rejects(safeDownload("https://example.com:444/"), /UNSAFE/);
});
test("ClamAV wire adapter distinguishes detection from clean and refuses partial/error results", async () => {
  let reply = "stream: Eicar-Signature FOUND\0";
  const server = net.createServer((socket) =>
    socket.once("data", () => socket.end(reply)),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as net.AddressInfo,
    connection = { host: "127.0.0.1", port: address.port };
  try {
    assert.equal(
      (await scanBytes(connection, Buffer.from("harmless protocol fixture")))
        .status,
      "malicious",
    );
    reply = "stream: OK\0";
    assert.equal(
      (await scanBytes(connection, Buffer.from("fixture"))).status,
      "clean",
    );
    reply = "stream: Size limit exceeded ERROR\0";
    await assert.rejects(
      scanBytes(connection, Buffer.from("fixture")),
      /INCOMPLETE/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("bounded cache expiry and single-flight recover after provider failure", async () => {
  let now = 0;
  const cache = new LruCache<number>(2, () => now);
  cache.set("a", 1, 10);
  cache.set("b", 2, 10);
  cache.get("a");
  cache.set("c", 3, 10);
  assert.equal(cache.get("b"), undefined);
  now = 11;
  assert.equal(cache.get("a"), undefined);
  const flight = new SingleFlight<number>();
  let calls = 0;
  const work = () => {
    calls++;
    return Promise.resolve(7);
  };
  assert.deepEqual(
    await Promise.all([flight.run("x", work), flight.run("x", work)]),
    [7, 7],
  );
  assert.equal(calls, 1);
  await assert.rejects(
    flight.run("e", async () => {
      throw new Error("offline");
    }),
  );
  assert.equal(await flight.run("e", work), 7);
});
