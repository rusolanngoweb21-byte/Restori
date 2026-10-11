// Explicit, offline integration check. Requires an existing verified model manifest.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { openStore } from "../services/web/storage.ts";
import { createWebServer } from "../services/web/server.ts";

if (!process.argv[2]) throw new Error("Existing model manifest path required; no models will be downloaded");
const directory = mkdtempSync(join(tmpdir(), "prizma-model-http-"));
const path = join(directory, "data", "app.sqlite"), token = randomBytes(32).toString("hex");
let app = openStore(path), worker;
const options = { publicOrigin: "https://prizma.test", settings: { WORKER_SERVICE_TOKEN: token } };
let servers = [];
async function start() {
  servers = ["public", "worker"].map(kind => createWebServer({ ...options, kind, store: app.store,
    ...(kind === "public" ? { assetsDir: resolve("dist-web") } : {}) }));
  for (const server of servers) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
}
async function closeServers() {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
function request(path, body, cookie) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: servers[0].address().port, path,
      method: body ? "POST" : "GET", headers: { host: "prizma.test", "content-type": "application/json", ...(cookie ? { cookie } : {}) } }, res => {
      const chunks = [];
      res.on("data", x => chunks.push(x));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
try {
  await start();
  const html = await request("/"); assert.equal(html.status, 200);
  assert.match(html.text, /Призма/);
  const asset = /src="([^"]+\.js)"/.exec(html.text)?.[1]; assert(asset);
  assert.equal((await request(asset)).status, 200);
  worker = spawn(process.execPath, ["dist-worker/services/analyzer/worker.js"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH,
      PRIZMA_SITE_URL: `http://127.0.0.1:${servers[1].address().port}`, PRIZMA_LOCAL: "1",
      WORKER_SERVICE_TOKEN: token, WORKER_ID: "local-smoke", MODEL_MANIFEST: resolve(process.argv[2]) },
  });
  // Application logs have no payloads; retain only a bounded tail for a failure code.
  let log = "";
  for (const stream of [worker.stdout, worker.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-2000); });
  const deadline = Date.now() + 120000;
  let caps = [];
  while (Date.now() < deadline) {
    caps = JSON.parse((await request("/api/capabilities")).text).capabilities;
    if (caps.some(c => c.detector === "text-ai")) break;
    if (worker.exitCode !== null) throw new Error("WORKER_EXITED: " + log);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(caps.some(c => c.detector === "text-ai"), "Real worker did not become ready");
  console.log(JSON.stringify({ event: "real_models_ready", detectors: caps.map(c => c.detector) }));
  const text = "The community garden opened on a rainy Saturday morning. Neighbours brought wooden boxes, seeds, and a pot of hot tea. We spent the first hour clearing the path beside the old wall, then measured the beds and wrote a planting schedule. I had never grown carrots before, so one of the volunteers showed me how shallow the rows should be. By noon the rain had stopped. Two children counted the worms we found in the soil, while their grandfather repaired a broken bench. We agreed to meet again next weekend and see which seeds had started to grow.";
  const queued = await request("/api/media", { detector: "text-ai", language: "en", text });
  assert.equal(queued.status, 202);
  const job = JSON.parse(queued.text), cookie = queued.headers["set-cookie"][0].split(";")[0];
  assert.equal((await request("/api/jobs/" + job.id)).status, 404);
  let result;
  for (let i = 0; i < 90; i++) {
    result = JSON.parse((await request("/api/jobs/" + job.id, undefined, cookie)).text);
    if (result.state === "finished") break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(result.state, "finished"); assert.equal(result.outcome.status, "completed");
  assert.equal(result.outcome.result.modality, "text");
  assert.equal(await app.store.bucket.get("inputs/" + job.id), null);
  const stopped = once(worker, "close"); worker.kill("SIGTERM"); await stopped; worker = undefined;
  await closeServers(); app.close(); app = openStore(path); await start();
  const resumed = await request("/api/jobs/" + job.id, undefined, cookie);
  assert.equal(resumed.status, 200); assert.deepEqual(JSON.parse(resumed.text).outcome, result.outcome);
  assert.equal((await request("/api/jobs/" + job.id)).status, 404);
  console.log(JSON.stringify({ event: "real_http_model_job", status: result.outcome.status, restartRetained: true, foreignSessionDenied: true, rawInputDeleted: true }));
} finally {
  if (worker && worker.exitCode === null) { const stopped = once(worker, "close"); worker.kill("SIGTERM"); await stopped; }
  await closeServers(); app.close(); rmSync(directory, { recursive: true, force: true });
}
