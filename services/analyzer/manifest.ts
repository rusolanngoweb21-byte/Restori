import { z } from "zod";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { detectorSchema } from "../../lib/contracts.ts";
export const modelSchema = z
  .object({
    detector: detectorSchema.exclude(["url-signature"]),
    directory: z.string().min(1),
    source: z.string().url(),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    license: z.string().min(1),
    languages: z.array(z.enum(["ru", "en"])).max(2),
    aiLabel: z.string().min(1),
    dtype: z.enum(["fp32", "q8"]),
    threshold: z.number().min(0.6).max(0.95).default(0.7),
    maxTokens: z.number().int().min(128).max(2048).default(512),
    files: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict();
export type ModelManifest = z.infer<typeof modelSchema> & { version: string };
async function filesUnder(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("MODEL_SYMLINK");
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      files.push(...(await filesUnder(directory, relative)));
    else files.push(relative);
  }
  return files.sort();
}
/** Offline-only models. Hash every file; never load arbitrary remote model code or pickle. */
export async function loadManifests(
  filename: string,
): Promise<ModelManifest[]> {
  const list = modelSchema
    .array()
    .max(3)
    .parse(JSON.parse(await readFile(filename, "utf8")));
  const manifests: ModelManifest[] = [];
  for (const model of list) {
    const directory = await realpath(
      path.resolve(path.dirname(filename), model.directory),
    );
    if (!(await lstat(directory)).isDirectory())
      throw new Error("MODEL_DIRECTORY");
    const files = await filesUnder(directory),
      expected = Object.keys(model.files).sort();
    if (
      JSON.stringify(files) !== JSON.stringify(expected) ||
      !files.some((f) => f.endsWith(".onnx"))
    )
      throw new Error("MODEL_FILES");
    for (const file of files) {
      if (
        file.endsWith(".py") ||
        file.endsWith(".pkl") ||
        file.endsWith(".bin")
      )
        throw new Error("MODEL_FORMAT");
      const hash = createHash("sha256")
        .update(await readFile(path.join(directory, file)))
        .digest("hex");
      if (hash !== model.files[file]) throw new Error("MODEL_HASH");
    }
    const version = createHash("sha256")
      .update(
        JSON.stringify({
          implementation: "prizma-v2.0.0-transformers3.8.1-ort1.21.0",
          ...model,
          directory: undefined,
          files: Object.fromEntries(expected.map((f) => [f, model.files[f]])),
        }),
      )
      .digest("hex");
    manifests.push({ ...model, directory, version });
  }
  return manifests;
}
