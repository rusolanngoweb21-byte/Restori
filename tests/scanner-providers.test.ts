import test from "node:test";
import assert from "node:assert/strict";
import { collectEvidence, evaluate, normalizeInput } from "../lib/scanner.ts";

// Reproduce the provider contract observed on the VPS: a mixed Accept value
// returns HTTP 400; application/dns-json returns DNS JSON successfully.
function providerResponse(input: string | URL | Request, init?: RequestInit, dnsUnavailable = false) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const accept = new Headers(init?.headers).get("accept") ?? "";
  if (url.hostname === "cloudflare-dns.com") {
    if (dnsUnavailable || accept !== "application/dns-json") return new Response(null, { status: 400 });
    const type = url.searchParams.get("type");
    const record = {
      A: { type: 1, data: "93.184.215.14" },
      AAAA: { type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" },
      MX: { type: 15, data: "10 mail.example.com." },
      NS: { type: 2, data: "ns.example.com." },
      TXT: { type: 16, data: url.searchParams.get("name")?.startsWith("_dmarc.") ? '"v=DMARC1; p=reject"' : '"v=spf1 -all"' },
    }[type ?? ""];
    return Response.json({ Status: 0, AD: true, Answer: record ? [{ ...record, TTL: 60 }] : [] });
  }
  if (url.href === "https://data.iana.org/rdap/dns.json") {
    return accept.includes("application/json")
      ? Response.json({ services: [[["com", "net"], ["https://rdap.registry.test/"]]] })
      : new Response(null, { status: 406 });
  }
  if (url.hostname === "rdap.registry.test") {
    return accept.includes("application/rdap+json")
      ? Response.json({ ldhName: url.pathname.split("/").at(-1), events: [], status: ["active"] })
      : new Response(null, { status: 406 });
  }
  throw new Error("Unexpected provider URL: " + url.href);
}

test("DNS provider negotiation produces all infrastructure signals without breaking RDAP", async t => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => providerResponse(input, init));
  const url = normalizeInput("https://example.com/");
  const evidence = await collectEvidence(url);
  const report = evaluate(url.href, url, evidence);
  const infrastructure = report.signals.filter(signal => signal.group === "Инфраструктура");
  assert.equal(infrastructure.length, 7);
  assert.equal(infrastructure.filter(signal => signal.status !== "unknown").length, 7);
  assert.equal(report.signals.find(signal => signal.id === "dns")?.status, "pass");
  assert.equal(report.signals.find(signal => signal.id === "public")?.status, "pass");
  assert.match(report.signals.find(signal => signal.id === "spf")?.detail ?? "", /SPF опубликована/);
  assert.match(report.signals.find(signal => signal.id === "dmarc")?.detail ?? "", /DMARC опубликована/);
  assert.equal(evidence.rdap?.ldhName, "example.com");
});

test("DNS HTTP failure remains unknown while registration data is retained", async t => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => providerResponse(input, init, true));
  const url = normalizeInput("https://example.net/");
  const evidence = await collectEvidence(url);
  const report = evaluate(url.href, url, evidence);
  assert.equal(report.signals.filter(signal => signal.group === "Инфраструктура" && signal.status === "unknown").length, 7);
  assert.equal(evidence.rdap?.ldhName, "example.net");
});
