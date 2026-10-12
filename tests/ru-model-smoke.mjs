// Explicit integration test against a preinstalled, hashed model, never downloaded here.
import assert from "node:assert/strict";
import { loadManifests } from "../services/analyzer/manifest.ts";
import { ModelProcess } from "../services/analyzer/model-process.ts";
if (!process.argv[2]) throw new Error("Existing model manifest path required");
const models = (await loadManifests(process.argv[2])).filter(m => m.textRuntime === "ru-modernbert-v1");
assert.equal(models.length, 1);
const worker = new ModelProcess(models);
try {
  await worker.initialize();
  const text = "Вчера мы пришли в городской парк и увидели новую дорожку возле старого пруда. Соседи рассказали о планах благоустройства и предложили вместе обсудить будущую посадку деревьев. ".repeat(4);
  const run = text => worker.infer(models[0].version, { detector: "text-ai", language: "ru", text });
  const valid = await run(text);
  assert(valid.status === "completed" || valid.code === "AMBIGUOUS_SCORE", JSON.stringify(valid));
  const long = await run("Это длинный синтетический текст для проверки ограничения размера модели. ".repeat(150));
  assert.equal(long.code, "TEXT_TOO_LONG");
  const stripped = await run(("``` " + text + "\n").repeat(3));
  assert.equal(stripped.code, "TEXT_TOO_SHORT");
  console.log(JSON.stringify({ event: "real_russian_boundaries", normal: valid.status, long: long.code, normalization: stripped.code }));
} finally { await worker.close(); }
