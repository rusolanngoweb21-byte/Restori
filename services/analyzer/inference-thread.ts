import { parentPort, workerData } from "node:worker_threads";
import {
  env,
  pipeline,
  RawImage,
  AutoTokenizer,
  AutoProcessor,
} from "@huggingface/transformers";
import { InferenceSession, Tensor } from "onnxruntime-node";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ModelManifest } from "./manifest.ts";
import type { MediaInput, Outcome } from "../../lib/contracts.ts";
env.allowRemoteModels = false;
env.allowLocalModels = true;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;
const manifests = workerData as ModelManifest[];
type Classifier = (
  input: string | RawImage,
  options: { top_k: number; truncation: boolean },
) => Promise<{ label: string; score: number }[]>;
const loadPipeline = pipeline as unknown as (
  task: string,
  path: string,
  options: Record<string, unknown>,
) => Promise<Classifier>;
const models = new Map<string, Classifier>();
for (const model of manifests) {
  if (model.detector === "text-ai") {
    models.set(
      model.version,
      await loadPipeline("text-classification", model.directory, {
        device: "cpu",
        dtype: model.dtype,
        local_files_only: true,
      }),
    );
    continue;
  }
  const processor = await AutoProcessor.from_pretrained(model.directory, {
    local_files_only: true,
  });
  const config = JSON.parse(
    await readFile(path.join(model.directory, "config.json"), "utf8"),
  ) as { id2label: Record<string, string> };
  const graph = await InferenceSession.create(
    path.join(
      model.directory,
      "onnx",
      model.dtype === "q8" ? "model_quantized.onnx" : "model.onnx",
    ),
    { executionProviders: ["cpu"], intraOpNumThreads: 2, interOpNumThreads: 1 },
  );
  if (graph.inputNames.length !== 1 || graph.inputNames[0] !== "pixel_values")
    throw new Error("IMAGE_MODEL_INPUTS");
  models.set(model.version, async (input) => {
    if (typeof input === "string") throw new Error("IMAGE_REQUIRED");
    const values = await processor(input);
    const outputs = await graph.run({
      pixel_values: new Tensor(
        "float32",
        values.pixel_values.data as Float32Array,
        values.pixel_values.dims,
      ),
    });
    const logits = Array.from(
      outputs[graph.outputNames[0]].data as Float32Array,
    );
    if (logits.length !== Object.keys(config.id2label).length)
      throw new Error("IMAGE_MODEL_OUTPUTS");
    const maximum = Math.max(...logits),
      exp = logits.map((x) => Math.exp(x - maximum)),
      sum = exp.reduce((a, b) => a + b, 0);
    return exp.map((x, i) => ({
      label: config.id2label[String(i)],
      score: x / sum,
    }));
  });
}
parentPort!.postMessage({ ready: true });
parentPort!.on(
  "message",
  async ({ version, input }: { version: string; input: MediaInput }) => {
    let outcome: Outcome;
    try {
      const model = manifests.find((m) => m.version === version),
        classifier = models.get(version);
      if (!model || !classifier) throw new Error("MODEL_VERSION");
      let data: string | RawImage;
      if (input.detector === "text-ai") {
        if (!model.languages.includes(input.language))
          throw new Error("LANGUAGE_UNSUPPORTED");
        const tokenizer = await AutoTokenizer.from_pretrained(model.directory, {
          local_files_only: true,
        });
        const encoded = await tokenizer(input.text, { truncation: false });
        if (encoded.input_ids.size > model.maxTokens) {
          parentPort!.postMessage({
            outcome: {
              status: "inconclusive",
              code: "TEXT_TOO_LONG",
              details:
                "Текст превышает окно модели. Сократите его: скрытое обрезание не выполняется.",
            },
          });
          return;
        }
        data = input.text;
      } else {
        const buffer = Buffer.from(input.imageBase64, "base64");
        const image = sharp(buffer, {
          limitInputPixels: 16000000,
          animated: false,
          failOn: "warning",
        });
        const metadata = await image.metadata();
        if (
          !metadata.width ||
          !metadata.height ||
          metadata.width < 64 ||
          metadata.height < 64 ||
          (metadata.pages ?? 1) > 1
        )
          throw new Error("IMAGE_DIMENSIONS");
        const { data: rgb, info } = await image
          .rotate()
          .removeAlpha()
          .toColourspace("srgb")
          .raw()
          .toBuffer({ resolveWithObject: true });
        data = new RawImage(
          new Uint8ClampedArray(rgb),
          info.width,
          info.height,
          info.channels,
        );
      }
      const predictions = await (
        classifier as unknown as (
          input: string | RawImage,
          options: { top_k: number; truncation: boolean },
        ) => Promise<{ label: string; score: number }[]>
      )(data, { top_k: 2, truncation: false });
      const ai = predictions.find((p) => p.label === model.aiLabel);
      if (!ai || !Number.isFinite(ai.score) || ai.score < 0 || ai.score > 1)
        throw new Error("MODEL_LABELS");
      const score = ai.score;
      if (score > 1 - model.threshold && score < model.threshold)
        outcome = {
          status: "inconclusive",
          code: "AMBIGUOUS_SCORE",
          details:
            "Оценка модели находится в зоне неопределённости. Данных недостаточно для вывода.",
        };
      else
        outcome = {
          status: "completed",
          scoreKind: "uncalibrated_model_score",
          result: {
            isAI: score >= model.threshold,
            confidence: Math.round(score * 10000) / 100,
            modality: input.detector === "text-ai" ? "text" : "image",
            details: `Оценка класса ИИ у модели: ${(score * 100).toFixed(1)}%. Это некалиброванный балл модели, не установленная вероятность подделки и не проверка личности.${input.detector === "deepfake" ? " Область применения: портреты; видео не анализировалось." : ""}`,
          },
        };
    } catch {
      outcome = {
        status: "inconclusive",
        code: "INPUT_OR_MODEL_UNSUPPORTED",
        details:
          "Модель не смогла надёжно обработать эти данные. Процент не рассчитан.",
      };
    }
    parentPort!.postMessage({ outcome });
  },
);
