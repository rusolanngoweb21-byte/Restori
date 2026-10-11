import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepare, seal, SITE_URL } from "../services/analyzer/vps/setup.mjs";
import { sealAccessToken, openAccessToken, probe } from "../services/analyzer/vps/access-probe.mjs";

const serviceToken = Buffer.alloc(32, 7).toString("base64url");
const settings = { PRIZMA_SITE_URL: SITE_URL, WORKER_SERVICE_TOKEN: "ab".repeat(32) };

test("service access envelope is recipient-bound, tamper-proof and separate from worker enrollment", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prizma-service-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recipient = join(dir, "recipient"), other = join(dir, "other");
  const publicKey = prepare(recipient);
  prepare(other);
  const envelope = sealAccessToken(serviceToken, publicKey);
  assert.ok(!envelope.includes(serviceToken));
  assert.equal(openAccessToken(recipient, envelope), serviceToken);
  assert.throws(() => openAccessToken(other, envelope));
  const parts = envelope.split("."), payload = Buffer.from(parts[3], "base64url");
  payload[0] ^= 1;
  parts[3] = payload.toString("base64url");
  assert.throws(() => openAccessToken(recipient, parts.join(".")));
  assert.throws(() => openAccessToken(recipient, seal(settings.WORKER_SERVICE_TOKEN, publicKey)));
  assert.throws(() => sealAccessToken(serviceToken + "\n", publicKey));
});

test("probe uses only the pinned Site and both documented authorization layers without claiming work", async () => {
  const report = await probe(serviceToken, settings, async (url, options) => {
    assert.equal(url, SITE_URL + "/api/internal/claim");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Bearer " + settings.WORKER_SERVICE_TOKEN);
    assert.equal(options.headers["OAI-Sites-Authorization"], "Bearer " + serviceToken);
    assert.deepEqual(JSON.parse(options.body), { workerId: "prizma-access-probe", capabilities: [], claim: false });
    return Response.json({ job: null });
  });
  assert.equal(report.access, "SITE_ACCESS_OK");
  let requested = false;
  await assert.rejects(probe(serviceToken, { ...settings, PRIZMA_SITE_URL: "https://other.invalid" }, async () => { requested = true; }), /SITE_URL_MISMATCH/);
  assert.equal(requested, false);
});

test("Cloudflare, application auth, and redirects remain distinguishable and never echo secrets", async () => {
  const upstream = `<title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1><span class="cf-error-code">1020</span>${serviceToken}${settings.WORKER_SERVICE_TOKEN}`;
  const blocked = await probe(serviceToken, settings, async () => new Response(upstream, { status: 403, headers: { "content-type": "text/html", "cf-ray": "123abc-FRA" } }));
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.cloudflareError, "1020");
  assert.equal(blocked.cloudflareRay, "123abc-FRA");
  assert.equal(blocked.access, "unconfirmed");
  assert.ok(!JSON.stringify(blocked).includes(serviceToken));
  assert.ok(!JSON.stringify(blocked).includes(settings.WORKER_SERVICE_TOKEN));
  const rejected = await probe(serviceToken, settings, async () => Response.json({ code: "WORKER_AUTH" }, { status: 401 }));
  assert.equal(rejected.access, "APPLICATION_AUTH_REJECTED");
  const redirected = await probe(serviceToken, settings, async () => new Response(null, { status: 302, headers: { location: "https://other.invalid" } }));
  assert.equal(redirected.http, 302);
  assert.equal(redirected.access, "unconfirmed");
});
