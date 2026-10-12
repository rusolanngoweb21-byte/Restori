import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { modelSchema, loadManifests } from "../services/analyzer/manifest.ts";

const hash = createHash("sha256").update("fixture").digest("hex");
const entry = (directory: string, language: string) => ({ detector: "text-ai", directory,
  source: "https://example.com/model", revision: "a".repeat(40), license: "mit",
  languages: [language], aiLabel: "ai", dtype: "fp32", threshold: 0.7, maxTokens: 512,
  files: { "model.onnx": hash } });

test("Russian native runtime accepts only its reviewed language and FP32 configuration", () => {
  assert.equal(modelSchema.safeParse({ ...entry("ru", "ru"), textRuntime: "ru-modernbert-v1" }).success, true);
  assert.equal(modelSchema.safeParse({ ...entry("ru", "en"), textRuntime: "ru-modernbert-v1" }).success, false);
  assert.equal(modelSchema.safeParse({ ...entry("ru", "ru"), textRuntime: "ru-modernbert-v1", dtype: "q8" }).success, false);
});

test("manifest loads more than three models and refuses two models sharing a directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prizma-manifest-"));
  try {
    const entries = ["en", "ru", "fr", "de"].map(language => entry(language, language));
    for (const model of entries) {
      await mkdir(path.join(root, model.directory));
      await writeFile(path.join(root, model.directory, "model.onnx"), "fixture");
    }
    const filename = path.join(root, "manifest.json");
    await writeFile(filename, JSON.stringify(entries));
    const models = await loadManifests(filename);
    assert.equal(models.length, 4);
    assert.equal(new Set(models.map(m => m.version)).size, 4);
    await writeFile(filename, JSON.stringify([entries[0], { ...entries[1], directory: "en" }]));
    await assert.rejects(loadManifests(filename), /MODEL_DIRECTORY_DUPLICATE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
