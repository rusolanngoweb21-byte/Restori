import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_URL } from "./setup.mjs";

// This one-shot probe uses the documented Sites service-access header. It does
// not change credentials, the worker configuration, or the Site's audience.
const context = Buffer.from("prizma-sites-access-probe-v1\n" + SITE_URL);
const publicBytes = (key) => createPublicKey(key).export({ type: "spki", format: "der" });
function decode(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error("ENVELOPE_INVALID");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value) throw Error("ENVELOPE_INVALID");
  return bytes;
}
function publicKey(bytes) {
  const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "x25519") throw Error("PUBLIC_KEY_INVALID");
  return key;
}
function derive(privateKey, peer, recipient, ephemeral) {
  return hkdfSync("sha256", diffieHellman({ privateKey, publicKey: peer }),
    Buffer.concat([recipient, ephemeral]), context, 32);
}
function validateToken(token) {
  // The existing service credential is a canonical, 32-byte base64url token.
  decode(token, 32);
  return token;
}
export function sealAccessToken(token, recipientPublicKey) {
  validateToken(token);
  const recipient = decode(recipientPublicKey, 44);
  const { privateKey } = generateKeyPairSync("x25519");
  const ephemeral = publicBytes(privateKey), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(privateKey, publicKey(recipient), recipient, ephemeral), iv);
  cipher.setAAD(context);
  const payload = Buffer.concat([cipher.update(token, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return ["site-probe-v1", ephemeral.toString("base64url"), iv.toString("base64url"), payload.toString("base64url")].join(".");
}
export function openAccessToken(directory, envelope) {
  if (typeof envelope !== "string" || envelope.length > 1024) throw Error("ENVELOPE_INVALID");
  const [version, encodedKey, encodedIV, encodedPayload, extra] = envelope.split(".");
  if (version !== "site-probe-v1" || extra !== undefined) throw Error("ENVELOPE_INVALID");
  const ephemeral = decode(encodedKey, 44), iv = decode(encodedIV, 12), payload = decode(encodedPayload, 59);
  const filename = join(directory, "enrollment.pem"), info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw Error("PRIVATE_KEY_INVALID");
  const privateKey = createPrivateKey(readFileSync(filename));
  if (privateKey.asymmetricKeyType !== "x25519") throw Error("PRIVATE_KEY_INVALID");
  const recipient = publicBytes(privateKey);
  const decipher = createDecipheriv("aes-256-gcm", derive(privateKey, publicKey(ephemeral), recipient, ephemeral), iv);
  decipher.setAAD(context);
  decipher.setAuthTag(payload.subarray(-16));
  return validateToken(Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString("utf8"));
}
export async function probe(serviceToken, settings = process.env, request = fetch) {
  validateToken(serviceToken);
  if (settings.PRIZMA_SITE_URL !== SITE_URL) throw Error("SITE_URL_MISMATCH");
  if (!/^[a-f0-9]{64}$/.test(settings.WORKER_SERVICE_TOKEN || "")) throw Error("WORKER_TOKEN_INVALID");
  const response = await request(SITE_URL + "/api/internal/claim", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + settings.WORKER_SERVICE_TOKEN,
      "OAI-Sites-Authorization": "Bearer " + serviceToken,
    },
    body: JSON.stringify({ workerId: "prizma-access-probe", capabilities: [], claim: false }),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  const type = response.headers.get("content-type") || "";
  const report = {
    http: response.status,
    json: type.includes("application/json"),
    cloudflareRay: (response.headers.get("cf-ray") || "").replace(/[^A-Za-z0-9-]/g, "").slice(0,80),
    challenge: response.headers.get("cf-mitigated") === "challenge",
    access: "unconfirmed",
  };
  if (report.json) {
    const body = await response.json();
    if (response.status === 200 && body?.job === null) report.access = "SITE_ACCESS_OK";
    else if (body?.code === "WORKER_AUTH") report.access = "APPLICATION_AUTH_REJECTED";
  } else {
    // Never print arbitrary upstream HTML, headers, request secrets, or jobs.
    const body = await response.text();
    report.cloudflarePage = /<title>[^<]*Cloudflare/i.test(body);
    report.blocked = /Sorry, you have been blocked/i.test(body);
    const code = /(?:error-code[^>]*>\s*|Error\s+)(1\d{3,4})\b/i.exec(body);
    if (code) report.cloudflareError = code[1];
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error("ENVELOPE_REQUIRED");
    const directory = join(dirname(fileURLToPath(import.meta.url)), ".private");
    const result = await probe(openAccessToken(directory, process.argv[2]));
    console.log(JSON.stringify(result));
    if (result.access !== "SITE_ACCESS_OK") process.exitCode = 1;
  } catch {
    console.error("ACCESS_PROBE_FAILED");
    process.exitCode = 1;
  }
}
