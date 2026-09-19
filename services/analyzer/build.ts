import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "services/analyzer/tsconfig.json"],
  { stdio: "inherit" },
);
await mkdir("dist-worker/services/analyzer", { recursive: true });
await copyFile(
  "services/analyzer/model-catalog.json",
  "dist-worker/services/analyzer/model-catalog.json",
);
