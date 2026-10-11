import { appendFile } from "node:fs/promises";
import path from "node:path";

process.once("message", async ({ models }) => {
  if (models.length !== 1) process.exit(2);
  await appendFile(path.join(models[0].directory, "children.log"), `${process.pid}\n`);
  if (models[0].version === "f".repeat(64)) { setInterval(() => {}, 1000); return; }
  if (models[0].version === "e".repeat(64)) process.exit(2);
  process.send({ ready: true });
  process.on("message", ({ input }) => {
    if (input.text === "hang") return;
    if (input.text === "crash") process.exit(2);
    if (input.text === "invalid") return process.send({ outcome: { status: "completed" } });
    process.send({ outcome: {
      status: "completed", scoreKind: "uncalibrated_model_score",
      result: { isAI: false, confidence: 10, modality: "text", details: `pid:${process.pid}` },
    } });
  });
});
