import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelProcess } from "../services/analyzer/model-process.ts";
import type { ModelManifest } from "../services/analyzer/manifest.ts";

async function setup(timeoutMs = 3000) {
  const directory = await mkdtemp(path.join(tmpdir(), "prizma-process-"));
  const models = ["text-ai", "deepfake", "image-ai"].map((detector, i) => ({
    detector, directory, version: String(i + 1).repeat(64), languages: detector === "text-ai" ? ["en"] : [],
  })) as ModelManifest[];
  const runner = new ModelProcess(models, {
    entrypoint: new URL("./fixtures/model-process.mjs", import.meta.url), timeoutMs,
  });
  return { runner, models, directory,
    async pids() { return (await readFile(path.join(directory, "children.log"), "utf8")).trim().split("\n").map(Number); },
    async cleanup() { await runner.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
function assertExited(pid: number) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "Native model process must exit before returning");
}
test("language mismatch is refused before launching inference and preserves readiness", async () => {
  const h = await setup();
  try {
    await h.runner.initialize();
    const before = await h.pids();
    const result = await h.runner.infer(h.models[0].version, { detector: "text-ai", language: "ru", text: "Русский текст" });
    assert.equal(result.status !== "completed" && result.code, "LANGUAGE_UNSUPPORTED");
    assert.deepEqual(await h.pids(), before);
    assert.equal(h.runner.ready, true);
  } finally { await h.cleanup(); }
});
const input = (text: string) => ({ detector: "text-ai" as const, language: "en" as const, text });

test("model validation leaves no resident model process; each job releases its process", async () => {
  const h = await setup();
  try {
    await h.runner.initialize();
    assert.equal(h.runner.ready, true);
    const prepared = await h.pids();
    assert.equal(prepared.length, 3);
    prepared.forEach(assertExited);
    const result = await h.runner.infer(h.models[0].version, input("normal"));
    assert.equal(result.status, "completed");
    const pids = await h.pids();
    assert.equal(pids.length, 4);
    assert.equal(new Set(pids).size, 4);
    pids.forEach(assertExited);
  } finally { await h.cleanup(); }
});

test("parallel model work is refused; timeout kills the child and removes readiness", async () => {
  const h = await setup(1000);
  try {
    await h.runner.initialize();
    const first = h.runner.infer(h.models[0].version, input("hang"));
    const second = await h.runner.infer(h.models[0].version, input("normal"));
    assert.equal(second.status !== "completed" && second.code, "MODEL_BUSY");
    const timedOut = await first;
    assert.equal(timedOut.status !== "completed" && timedOut.code, "MODEL_TIMEOUT");
    assert.equal(h.runner.ready, false);
    (await h.pids()).forEach(assertExited);
  } finally { await h.cleanup(); }
});

for (const text of ["invalid", "crash"]) test(`${text} model response cannot produce a valid result or remain ready`, async () => {
  const h = await setup();
  try {
    await h.runner.initialize();
    assert.equal(h.runner.ready, true);
    const result = await h.runner.infer(h.models[0].version, input(text));
    assert.notEqual(result.status, "completed");
    assert.equal(h.runner.ready, false);
    (await h.pids()).forEach(assertExited);
    const again = await h.runner.infer(h.models[0].version, input("normal"));
    assert.equal(again.status !== "completed" && again.code, "MODEL_UNAVAILABLE");
    await h.runner.initialize();
    assert.equal(h.runner.ready, true);
    assert.equal((await h.runner.infer(h.models[0].version, input("normal"))).status, "completed");
    (await h.pids()).forEach(assertExited);
  } finally { await h.cleanup(); }
});

for (const [version, code] of [["f", "MODEL_TIMEOUT"], ["e", "MODEL_FAILURE"]])
test(`startup ${code} leaves no child or advertised model`, async () => {
  const h = await setup(1000);
  h.models[0].version = version.repeat(64);
  try {
    await assert.rejects(h.runner.initialize(), { message: code });
    assert.equal(h.runner.ready, false);
    (await h.pids()).forEach(assertExited);
  } finally { await h.cleanup(); }
});

test("shutdown during preparation settles loading and prevents a replacement process", async () => {
  const h = await setup();
  h.models[0].version = "f".repeat(64);
  try {
    const failed = assert.rejects(h.runner.initialize(), { message: "MODEL_FAILURE" });
    await Promise.all([h.runner.close(), h.runner.close()]);
    await failed;
    assert.equal(h.runner.ready, false);
    await assert.rejects(h.runner.initialize(), { message: "MODEL_STOPPED" });
  } finally { await h.cleanup(); }
});
