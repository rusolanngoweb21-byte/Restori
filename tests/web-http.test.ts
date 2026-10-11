import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { openStore } from "../services/web/storage.ts";
import { createWebServer } from "../services/web/server.ts";
import { textFixture } from "./helpers.ts";

const secret = "c".repeat(64), origin = "https://prizma.example";
const cap = { detector: "text-ai" as const, version: "a".repeat(64), languages: ["en" as const] };
async function fixture(t: { after: (fn: () => void | Promise<void>) => void }, kind: "public" | "worker" = "public", trustedProxy?: string) {
  const dir = mkdtempSync(join(tmpdir(), "prizma-http-"));
  const app = openStore(join(dir, "db", "app.sqlite"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "index.html"), "<!doctype html><title>Prizma</title>");
  writeFileSync(join(dir, "secret.env"), "never public");
  const server = createWebServer({ publicOrigin: origin, store: app.store,
    settings: { WORKER_SERVICE_TOKEN: secret }, kind, trustedProxy,
    assetsDir: join(dir, "assets"), bodyTimeoutMs: 50 });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    app.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { ...app, server };
}
function send(server: Server, path: string, body?: string, headers: Record<string, string> = {}, end = true) {
  return new Promise<{ status: number; headers: Record<string, any>; text: string }>((resolve, reject) => {
    const address = server.address() as { port: number };
    const req = httpRequest({ hostname: "127.0.0.1", port: address.port, path,
      method: body === undefined ? "GET" : "POST", headers: { host: "prizma.example", "content-type": "application/json", ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (end) req.end(body); else req.write(body);
  });
}

test("public listener never exposes worker routes; private listener requires auth and hides the website", async t => {
  const pub = await fixture(t), worker = await fixture(t, "worker");
  const body = JSON.stringify({ workerId: "fixture", capabilities: [cap], claim: false });
  assert.equal((await send(pub.server, "/api/internal/claim", body, { authorization: "Bearer " + secret })).status, 404);
  assert.equal((await send(worker.server, "/api/internal/claim", body)).status, 401);
  assert.equal((await send(worker.server, "/api/internal/claim", body, { authorization: "Bearer " + secret })).status, 200);
  assert.equal((await send(worker.server, "/")).status, 404);
});

test("pinned HTTPS origin produces Secure cookies; hostile Host, Origin and Fetch Metadata fail", async t => {
  const { server } = await fixture(t);
  const res = await send(server, "/api/capabilities");
  assert.equal(res.status, 200);
  assert.match(res.headers["set-cookie"][0], /__Host-prizma_session=.*; Secure/);
  assert.equal((await send(server, "/api/capabilities", undefined, { host: "attacker.example", "x-forwarded-host": "prizma.example" })).status, 421);
  const body = JSON.stringify({ url: "https://example.com/" });
  assert.equal((await send(server, "/api/out", body, { origin: "https://attacker.example" })).status, 403);
  assert.equal((await send(server, "/api/out", body, { "sec-fetch-site": "cross-site" })).status, 403);
});

test("untrusted forwarded IP headers cannot split rate limits; configured ingress requires one valid IP", async t => {
  const app = await fixture(t);
  const body = JSON.stringify({ url: "https://example.org/" });
  for (let i = 0; i < 3; i++) assert.equal((await send(app.server, "/api/out", body,
    { "cf-connecting-ip": "spoof" + i, "x-forwarded-for": "1.1.1." + i, "x-real-ip": "8.8.8." + i })).status, 409);
  const rows = await app.store.db.prepare("SELECT count(*) n FROM rate_windows").first<{ n: number }>();
  assert.equal(rows?.n, 1);
  const proxy = await fixture(t, "public", "127.0.0.1");
  assert.equal((await send(proxy.server, "/api/capabilities")).status, 400);
  assert.equal((await send(proxy.server, "/api/capabilities", undefined, { "x-real-ip": "1.1.1.1, 2.2.2.2" })).status, 400);
  assert.equal((await send(proxy.server, "/api/capabilities", undefined, { "x-real-ip": "1.1.1.1" })).status, 200);
});

test("real HTTP queue keeps sessions separate, and unavailable reputation cannot allow navigation", async t => {
  const { server, store } = await fixture(t);
  await store.heartbeat("fixture", [cap]);
  const response = await send(server, "/api/media", JSON.stringify({ detector: "text-ai", language: "en", text: textFixture }));
  assert.equal(response.status, 202);
  const id = JSON.parse(response.text).id;
  const cookie = response.headers["set-cookie"][0].split(";")[0];
  assert.equal((await send(server, "/api/jobs/" + id)).status, 404);
  const owned = await send(server, "/api/jobs/" + id, undefined, { cookie });
  assert.equal(owned.status, 200); assert.match(owned.headers["cache-control"], /private, no-store/);
  const held = await send(server, "/api/out", JSON.stringify({ url: "https://example.net/" }));
  assert.equal(held.status, 409); assert.equal(held.headers.location, undefined);
});

test("request size, slow body, absolute targets and static traversal are bounded", async t => {
  const { server } = await fixture(t);
  assert.equal((await send(server, "/api/out", "{}", { "content-length": "9999999" })).status, 413);
  assert.equal((await send(server, "/api/out", "x".repeat(9000))).status, 413);
  assert.equal((await send(server, "/api/out", "{", { "transfer-encoding": "chunked" }, false)).status, 408);
  assert.equal((await send(server, "http://attacker.example/api/capabilities")).status, 400);
  for (const path of ["/secret.env", "/../secret.env", "/%2e%2e/secret.env", "/api/unknown"]) {
    const res = await send(server, path); assert.equal(res.status, 404); assert.doesNotMatch(res.text, /never public/);
  }
  assert.equal((await send(server, "/")).status, 200);
});
