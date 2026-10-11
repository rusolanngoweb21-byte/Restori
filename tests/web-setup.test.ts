import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure } from "../services/web/vps/setup.mjs";
test("self-host configuration pins HTTPS and ingress without copying the worker secret or replacing existing settings", t => {
  const parent = mkdtempSync(join(tmpdir(), "prizma-setup-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, "config");
  configure(directory, "https://185.68.22.22:8443", "172.20.0.1");
  const config = readFileSync(join(directory, "web.env"), "utf8");
  assert.equal(config, "PUBLIC_ORIGIN=https://185.68.22.22:8443\nTRUSTED_PROXY=172.20.0.1\n");
  assert.equal(statSync(join(directory, "web.env")).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, "data")).mode & 0o777, 0o700);
  configure(directory, "https://185.68.22.22:8443", "172.20.0.1");
  assert.throws(() => configure(directory, "https://different.example", "172.20.0.1"), /CONFIG_EXISTS/);
  for (const origin of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com\nSECRET=oops"])
    assert.throws(() => configure(join(parent, "bad"), origin, "172.20.0.1"));
  assert.throws(() => configure(join(parent, "bad"), "https://example.com", "1.1.1.1\nBAD=1"));
  symlinkSync(directory, join(parent, "link"));
  assert.throws(() => configure(join(parent, "link"), "https://example.com", "172.20.0.1"), /DIRECTORY_INVALID/);
  assert.equal(readFileSync(join(directory, "web.env"), "utf8"), config);
});
