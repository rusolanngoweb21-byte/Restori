import { fork, type ChildProcess } from "node:child_process";
import type { ModelManifest } from "./manifest.ts";
import { outcomeSchema, type MediaInput, type Outcome } from "../../lib/contracts.ts";

/** One short-lived OS process per model: native ONNX allocations die with it. */
export class ModelProcess {
  ready = false;
  private active: ChildProcess | null = null;
  private closed = false;
  private initializing = false;
  private readonly models: ModelManifest[];
  private readonly entrypoint: URL;
  private readonly timeoutMs: number;
  constructor(models: ModelManifest[], options: { entrypoint?: URL; timeoutMs?: number } = {}) {
    this.models = models;
    this.entrypoint = options.entrypoint ?? new URL(
      import.meta.url.endsWith(".ts") ? "./inference-thread.ts" : "./inference-thread.js", import.meta.url,
    );
    this.timeoutMs = options.timeoutMs ?? 60000;
  }
  async initialize() {
    if (this.initializing || this.active) throw new Error("MODEL_BUSY");
    this.ready = false;
    this.initializing = true;
    try {
      // Prove each model can load before advertising it, without retaining all three.
      for (const model of this.models) await this.execute(model);
      this.ready = this.models.length > 0 && !this.closed;
    } finally { this.initializing = false; }
  }
  async infer(version: string, input: MediaInput): Promise<Outcome> {
    if (this.active || this.initializing)
      return { status: "unavailable", code: "MODEL_BUSY", details: "Обработчик занят другой проверкой." };
    const model = this.models.find((value) => value.version === version && value.detector === input.detector);
    if (!this.ready || this.closed || !model)
      return { status: "unavailable", code: "MODEL_UNAVAILABLE", details: "Модель сейчас недоступна." };
    try {
      return (await this.execute(model, input))!;
    } catch (error) {
      this.ready = false;
      const timedOut = error instanceof Error && error.message === "MODEL_TIMEOUT";
      return { status: "unavailable", code: timedOut ? "MODEL_TIMEOUT" : "MODEL_FAILURE",
        details: timedOut ? "Загрузка модели и проверка не завершились за 60 секунд." : "Обработчик модели не завершил проверку." };
    }
  }
  private execute(model: ModelManifest, input?: MediaInput): Promise<Outcome | undefined> {
    if (this.closed) return Promise.reject(new Error("MODEL_STOPPED"));
    if (this.active) return Promise.reject(new Error("MODEL_BUSY"));
    const child = fork(this.entrypoint, [], {
      execArgv: ["--max-old-space-size=512", ...(this.entrypoint.pathname.endsWith(".ts") ? ["--experimental-transform-types"] : [])],
      // Inference needs no Site credentials, user environment or network credentials.
      env: { PATH: process.env.PATH, NODE_ENV: "production", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.active = child;
    return new Promise((resolve, reject) => {
      let receivedReady = false, settled = false;
      let outcome: Outcome | undefined;
      let failure: Error | undefined;
      const finish = (error?: Error, result?: Outcome) => {
        if (settled) return;
        settled = true;
        failure = error;
        outcome = result;
        clearTimeout(timer);
        // Wait for close below: never overlap the old native allocation with a new process.
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => finish(new Error("MODEL_TIMEOUT")), this.timeoutMs);
      child.on("error", () => finish(new Error("MODEL_FAILURE")));
      child.once("close", () => {
        clearTimeout(timer);
        if (this.active === child) this.active = null;
        if (!settled || failure) reject(failure ?? new Error("MODEL_FAILURE"));
        else resolve(outcome);
      });
      child.on("message", (message: unknown) => {
        if (settled) return;
        const value = message as { ready?: unknown; outcome?: unknown } | null;
        if (!receivedReady) {
          if (value?.ready !== true) return finish(new Error("MODEL_RESPONSE"));
          receivedReady = true;
          if (!input) return finish();
          child.send({ version: model.version, input }, (error) => {
            if (error) finish(new Error("MODEL_FAILURE"));
          });
          return;
        }
        const parsed = outcomeSchema.safeParse(value?.outcome);
        if (!parsed.success) return finish(new Error("MODEL_RESPONSE"));
        finish(undefined, parsed.data);
      });
      child.send({ models: [model] }, (error) => {
        if (error) finish(new Error("MODEL_FAILURE"));
      });
    });
  }
  async close() {
    this.closed = true;
    this.ready = false;
    const child = this.active;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.kill("SIGKILL");
    });
  }
}
