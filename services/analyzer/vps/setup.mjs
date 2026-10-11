import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SITE_URL = "https://prizma-link-check.rusolanngoweb21.chatgpt.site";
const CONTEXT = Buffer.from("prizma-worker-token-v1");
const keyFile = "enrollment.pem";
const publicBytes = (key) => createPublicKey(key).export({ type: "spki", format: "der" });
function privateDirectory(directory) {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error("PRIVATE_DIRECTORY_INVALID");
  chmodSync(directory, 0o700);
}
function privateKey(directory) {
  const filename = join(directory, keyFile);
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw Error("PRIVATE_KEY_INVALID");
  chmodSync(filename, 0o600);
  const key = createPrivateKey(readFileSync(filename));
  if (key.asymmetricKeyType !== "x25519") throw Error("PRIVATE_KEY_INVALID");
  return key;
}
function decode(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error("ENVELOPE_INVALID");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value) throw Error("ENVELOPE_INVALID");
  return bytes;
}
function importPublic(bytes) {
  const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "x25519") throw Error("PUBLIC_KEY_INVALID");
  return key;
}
function derive(privatePart, publicPart, recipient, ephemeral) {
  return hkdfSync("sha256", diffieHellman({ privateKey: privatePart, publicKey: publicPart }),
    Buffer.concat([recipient, ephemeral]), CONTEXT, 32);
}
function validateToken(token) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("TOKEN_INVALID");
}
export function prepare(directory) {
  privateDirectory(directory);
  const filename = join(directory, keyFile);
  if (!existsSync(filename)) {
    const { privateKey: key } = generateKeyPairSync("x25519");
    writeFileSync(filename, key.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  }
  return publicBytes(privateKey(directory)).toString("base64url");
}
/** Encrypt off-server; only the target VPS holds the matching private key. */
export function seal(token, recipientPublicKey) {
  validateToken(token);
  const recipient = decode(recipientPublicKey, 44);
  const { privateKey: key } = generateKeyPairSync("x25519");
  const ephemeral = publicBytes(key), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(key, importPublic(recipient), recipient, ephemeral), iv);
  cipher.setAAD(CONTEXT);
  const payload = Buffer.concat([cipher.update(token, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return ["v1", ephemeral.toString("base64url"), iv.toString("base64url"), payload.toString("base64url")].join(".");
}
export function install(directory, envelope) {
  privateDirectory(directory);
  const target = join(directory, "worker.env");
  if (existsSync(target)) throw Error("ALREADY_CONFIGURED");
  if (typeof envelope !== "string" || envelope.length > 1024) throw Error("ENVELOPE_INVALID");
  const [version, encodedKey, encodedIV, encodedPayload, extra] = envelope.split(".");
  if (version !== "v1" || extra !== undefined) throw Error("ENVELOPE_INVALID");
  const ephemeral = decode(encodedKey, 44), iv = decode(encodedIV, 12), payload = decode(encodedPayload, 80);
  const key = privateKey(directory), recipient = publicBytes(key);
  const decipher = createDecipheriv("aes-256-gcm", derive(key, importPublic(ephemeral), recipient, ephemeral), iv);
  decipher.setAAD(CONTEXT);
  decipher.setAuthTag(payload.subarray(-16));
  const token = Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString("utf8");
  validateToken(token);
  writeFileSync(target, `PRIZMA_SITE_URL=${SITE_URL}\nWORKER_SERVICE_TOKEN=${token}\nWORKER_ID=prizma-spb-01\n`,
    { flag: "wx", mode: 0o600 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = join(dirname(fileURLToPath(import.meta.url)), ".private");
  try {
    if (process.argv[2] === "prepare" && process.argv.length === 3) console.log("PUBLIC_KEY=" + prepare(directory));
    else if (process.argv[2] === "install" && process.argv.length === 4) {
      install(directory, process.argv[3]);
      console.log("ENV_SAVED");
    } else throw Error("USAGE: prepare | install <encrypted-envelope>");
  } catch (error) {
    // Never serialize inputs, private keys or decrypted configuration.
    console.error("SETUP_FAILED: " + (error instanceof Error ? error.message : "ERROR"));
    process.exitCode = 1;
  }
}
