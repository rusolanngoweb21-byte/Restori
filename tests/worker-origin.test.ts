import test from "node:test";
import assert from "node:assert/strict";
import { workerOrigin } from "../services/analyzer/origin.ts";
test("worker permits private HTTP only with an explicit flag and the exact local service origin", () => {
  assert.equal(workerOrigin("https://example.com").origin, "https://example.com");
  assert.equal(workerOrigin("http://web:8081", { selfHosted: true }).origin, "http://web:8081");
  assert.equal(workerOrigin("http://127.0.0.1:9000", { local: true }).origin, "http://127.0.0.1:9000");
  for (const url of ["http://web:8081", "http://127.0.0.1:9000", "http://example.com"])
    assert.throws(() => workerOrigin(url));
  for (const url of ["http://web:80", "http://web:8081.attacker.example", "http://web:8081@attacker.example", "http://attacker.example", "ftp://localhost", "https://example.com/path", "https://user:password@example.com", "https://example.com/?secret=a"])
    assert.throws(() => workerOrigin(url, { selfHosted: true }));
});
