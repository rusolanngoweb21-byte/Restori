import { readFile } from "node:fs/promises";
import { loadManifests } from "./dist-worker/services/analyzer/manifest.js";
import { ModelProcess } from "./dist-worker/services/analyzer/model-process.js";
import sharp from "sharp";

const models = await loadManifests(process.env.MODEL_MANIFEST);
if (JSON.stringify(models.map((model) => model.detector).sort()) !== JSON.stringify(["deepfake", "image-ai", "text-ai"]))
  throw Error("MODEL_SET_INCOMPLETE");
const worker = new ModelProcess(models);
try {
  await worker.initialize();
  const imageBase64 = (await sharp({ create: { width: 224, height: 224, channels: 3,
    background: { r: 120, g: 170, b: 210 } } }).png().toBuffer()).toString("base64");
  for (const model of models) {
    const input = model.detector === "text-ai"
      ? { detector: model.detector, language: "en", text: "This is a synthetic deployment check. It verifies that the local text model can process a short English paragraph. It does not measure the accuracy of the detector." }
      : { detector: model.detector, imageBase64 };
    const outcome = await worker.infer(model.version, input);
    if (outcome.status !== "completed" && !(outcome.status === "inconclusive" && outcome.code === "AMBIGUOUS_SCORE"))
      throw Error(`${model.detector}: ${outcome.code}`);
    console.log(JSON.stringify({ detector: model.detector, status: outcome.status }));
  }
  let memoryPeakMiB = null;
  try {
    memoryPeakMiB = Math.ceil(Number(await readFile("/sys/fs/cgroup/memory.peak", "utf8")) / 1048576);
  } catch { /* Older cgroup layouts do not expose this measurement. */ }
  console.log(JSON.stringify({ status: "MODELS_OK", memoryPeakMiB }));
} finally {
  await worker.close();
}
