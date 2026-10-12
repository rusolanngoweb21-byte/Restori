import { readFile } from "node:fs/promises";
import { loadManifests } from "./dist-worker/services/analyzer/manifest.js";
import { ModelProcess } from "./dist-worker/services/analyzer/model-process.js";
import sharp from "sharp";

const models = await loadManifests(process.env.MODEL_MANIFEST);
const languages = (process.env.PRIZMA_EXPECT_LANGUAGES || "en").split(",");
if (!["deepfake", "image-ai"].every(detector => models.some(m => m.detector === detector)) ||
    !languages.every(language => models.some(m => m.detector === "text-ai" && m.languages.includes(language))))
  throw Error("MODEL_SET_INCOMPLETE");
const worker = new ModelProcess(models);
try {
  await worker.initialize();
  const imageBase64 = (await sharp({ create: { width: 224, height: 224, channels: 3,
    background: { r: 120, g: 170, b: 210 } } }).png().toBuffer()).toString("base64");
  for (const model of models) {
    const input = model.detector === "text-ai"
      ? { detector: model.detector, language: model.languages[0], text: model.languages[0] === "ru"
          ? "Это искусственный текст для проверки установки русской модели на сервере. Мы проверяем загрузку словаря, обработку текста и получение результата. Этот тест не измеряет точность определения авторства и не проверяет достоверность новостей. ".repeat(4)
          : "This is a synthetic deployment check. It verifies that the local text model can process a short English paragraph. It does not measure the accuracy of the detector." }
      : { detector: model.detector, imageBase64 };
    const outcome = await worker.infer(model.version, input);
    if (outcome.status !== "completed" && !(outcome.status === "inconclusive" && outcome.code === "AMBIGUOUS_SCORE"))
      throw Error(`${model.detector}: ${outcome.code}`);
    console.log(JSON.stringify({ detector: model.detector, languages: model.languages, status: outcome.status }));
  }
  let memoryPeakMiB = null;
  try {
    memoryPeakMiB = Math.ceil(Number(await readFile("/sys/fs/cgroup/memory.peak", "utf8")) / 1048576);
  } catch { /* Older cgroup layouts do not expose this measurement. */ }
  console.log(JSON.stringify({ status: "MODELS_OK", memoryPeakMiB }));
} finally {
  await worker.close();
}
