import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { modelSchema } from "./manifest.ts";
type Entry = {
  detector: string;
  repo: string;
  revision: string;
  license: string;
  languages: string[];
  aiLabel: string;
  dtype: string;
  threshold: number;
  maxTokens: number;
  files: string[];
  weightSha256: string;
  configSource?: { repo: string; revision: string; files: string[] };
};
const catalog = JSON.parse(
  await readFile(new URL("./model-catalog.json", import.meta.url), "utf8"),
) as Entry[];
const directory = path.resolve(process.argv[2] || ".models");
await mkdir(directory, { recursive: true });
const manifests: unknown[] = [];
for (const item of catalog) {
  const local = path.join(directory, item.detector);
  await mkdir(local, { recursive: true });
  const assets = [
    ...item.files.map((file) => ({
      file,
      repo: item.repo,
      revision: item.revision,
      remote: item.detector === "image-ai" ? "model.onnx" : file,
    })),
    ...(item.configSource?.files.map((file) => ({
      file,
      repo: item.configSource!.repo,
      revision: item.configSource!.revision,
      remote: file,
    })) || []),
  ];
  const hashes: Record<string, string> = {};
  for (const asset of assets) {
    const filename = path.join(local, asset.file);
    await mkdir(path.dirname(filename), { recursive: true });
    let existing: Buffer | undefined;
    try {
      existing = await readFile(filename);
    } catch {}
    if (existing) {
      const hash = createHash("sha256").update(existing).digest("hex");
      if (!asset.file.endsWith(".onnx") || hash === item.weightSha256) {
        hashes[asset.file] = hash;
        continue;
      }
    }
    const response = await fetch(
      `https://huggingface.co/${asset.repo}/resolve/${asset.revision}/${asset.remote}`,
      { signal: AbortSignal.timeout(300000) },
    );
    if (!response.ok || !response.body)
      throw new Error(`MODEL_DOWNLOAD_${response.status}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 600000000) return callback(new Error("MODEL_SIZE_LIMIT"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        meter,
        createWriteStream(filename + ".part"),
      );
      const digest = hash.digest("hex");
      if (asset.file.endsWith(".onnx") && digest !== item.weightSha256)
        throw new Error("WEIGHT_CHECKSUM");
      await rename(filename + ".part", filename);
      hashes[asset.file] = digest;
    } catch (error) {
      await rm(filename + ".part", { force: true });
      throw error;
    }
    console.log(
      JSON.stringify({
        event: "model_asset_ready",
        detector: item.detector,
        file: asset.file,
        bytes,
      }),
    );
  }
  const manifest = modelSchema.parse({
    detector: item.detector,
    directory: item.detector,
    source: `https://huggingface.co/${item.repo}`,
    revision: item.revision,
    license: item.license,
    languages: item.languages,
    aiLabel: item.aiLabel,
    dtype: item.dtype,
    threshold: item.threshold,
    maxTokens: item.maxTokens,
    files: hashes,
  });
  manifests.push(manifest);
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifests, null, 2) + "\n",
  );
}
console.log(
  "All model assets pinned and hashed. Run the validation script before connecting a worker.",
);
