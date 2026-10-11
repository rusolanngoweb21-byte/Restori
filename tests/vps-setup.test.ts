import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepare, seal, install, SITE_URL } from "../services/analyzer/vps/setup.mjs";

function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "prizma-enrollment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "private");
}

test("encrypted enrollment preserves the server key and writes a private, pinned configuration", (t) => {
  const dir = directory(t);
  const publicKey = prepare(dir);
  assert.equal(prepare(dir), publicKey);
  assert.equal(Buffer.from(publicKey, "base64url").length, 44);
  const token = "a1".repeat(32);
  const box = seal(token, publicKey);
  assert.ok(!box.includes(token));
  install(dir, box);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "enrollment.pem")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "worker.env")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, "worker.env"), "utf8"), `PRIZMA_SITE_URL=${SITE_URL}\nWORKER_SERVICE_TOKEN=${token}\nWORKER_ID=prizma-spb-01\n`);
  assert.throws(() => install(dir, seal("b2".repeat(32), publicKey)), /ALREADY_CONFIGURED/);
  assert.ok(readFileSync(join(dir, "worker.env"), "utf8").includes(token));
});

test("wrong server and corrupted ciphertext never create a worker secret", (t) => {
  const recipient = directory(t), other = directory(t);
  const box = seal("ab".repeat(32), prepare(recipient));
  prepare(other);
  assert.throws(() => install(other, box));
  const parts = box.split(".");
  const ciphertext = Buffer.from(parts[3], "base64url");
  ciphertext[0] ^= 1;
  parts[3] = ciphertext.toString("base64url");
  assert.throws(() => install(recipient, parts.join(".")));
  assert.equal(existsSync(join(recipient, "worker.env")), false);
  assert.equal(existsSync(join(other, "worker.env")), false);
});

test("invalid tokens, malformed envelopes and directory symlinks are rejected", (t) => {
  const dir = directory(t), publicKey = prepare(dir);
  assert.throws(() => seal("secret\nPRIZMA_SITE_URL=https://other.invalid", publicKey), /TOKEN_INVALID/);
  for (const box of ["", "v0.a.b.c", "v1.a.b.c", "x".repeat(4096)]) {
    assert.throws(() => install(dir, box));
  }
  assert.equal(existsSync(join(dir, "worker.env")), false);
  const linked = directory(t);
  symlinkSync(dir, linked);
  assert.throws(() => prepare(linked), /PRIVATE_DIRECTORY_INVALID/);
});
