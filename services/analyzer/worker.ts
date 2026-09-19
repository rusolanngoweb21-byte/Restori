import { Worker } from "node:worker_threads";
import { hostname } from "node:os";
import { loadManifests, type ModelManifest } from "./manifest.ts";
import { safeDownload } from "./safe-download.ts";
import { clamVersion, scanBytes, type ClamConnection } from "./clamav.ts";
import { startHealthServer } from "./health.ts";
import {
  capabilitySchema,
  outcomeSchema,
  type Capability,
  type JobInput,
  type Outcome,
} from "../../lib/contracts.ts";
import { sha256 } from "../../lib/http.ts";

const base = new URL(process.env.PRIZMA_SITE_URL || "");
if (
  base.protocol !== "https:" &&
  !(
    process.env.PRIZMA_LOCAL === "1" &&
    ["127.0.0.1", "localhost"].includes(base.hostname)
  )
)
  throw new Error("HTTPS_REQUIRED");
const secret = process.env.WORKER_SERVICE_TOKEN || "";
if (secret.length < 32) throw new Error("WORKER_SERVICE_TOKEN_REQUIRED");
const id = (process.env.WORKER_ID || hostname())
  .replace(/[^a-zA-Z0-9_-]/g, "_")
  .slice(0, 64);
const models = process.env.MODEL_MANIFEST
  ? await loadManifests(process.env.MODEL_MANIFEST)
  : [];
let stopping = false,
  thread: Worker | null = null,
  modelsReady = false,
  lastSiteSuccess = 0,
  lastClamSuccess = 0;
const clam: ClamConnection | undefined = process.env.CLAM_SOCKET
  ? { path: process.env.CLAM_SOCKET }
  : process.env.CLAM_HOST
    ? { host: process.env.CLAM_HOST, port: 3310 }
    : undefined;
let engine: string | null = null;
const healthServer = process.env.PORT
  ? startHealthServer(Number(process.env.PORT), () => ({
      stopping,
      modelsReady: modelsReady && !!thread,
      clamavReady: !!engine && Date.now() - lastClamSuccess < 90000,
      siteReady: Date.now() - lastSiteSuccess < 45000,
    }), process.env.REQUIRE_CLAMAV === "1")
  : undefined;
async function api(path: string, body: unknown) {
  const response = await fetch(new URL(path, base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`API_${response.status}`);
  const value = await response.json();
  lastSiteSuccess = Date.now();
  return value;
}
async function startInference(manifests: ModelManifest[]) {
  if (!manifests.length) return;
  const source = import.meta.url.endsWith(".ts");
  thread = new Worker(
    new URL(
      source ? "./inference-thread.ts" : "./inference-thread.js",
      import.meta.url,
    ),
    {
      workerData: manifests,
      execArgv: source ? ["--experimental-transform-types"] : [],
      resourceLimits: { maxOldGenerationSizeMb: 2048 },
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void thread?.terminate();
        reject(new Error("MODEL_START_TIMEOUT"));
      }, 180000);
      thread!.once("message", (value) => {
        clearTimeout(timer);
        if (value?.ready === true) resolve();
        else reject(new Error("MODEL_START_RESPONSE"));
      });
      thread!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    modelsReady = true;
    const active = thread;
    active.on("error", () => {
      if (thread === active) {
        thread = null;
        modelsReady = false;
      }
    });
    active.on("exit", () => {
      if (thread === active) {
        thread = null;
        modelsReady = false;
      }
    });
  } catch (error) {
    const failed = thread;
    thread = null;
    modelsReady = false;
    await failed.terminate();
    throw error;
  }
}
async function infer(version: string, input: JobInput): Promise<Outcome> {
  if (!thread)
    return {
      status: "unavailable",
      code: "MODEL_UNAVAILABLE",
      details: "Модель сейчас недоступна.",
    };
  const current = thread;
  return new Promise((resolve) => {
    const finish = (outcome: Outcome) => {
      clearTimeout(timer);
      current.off("message", received);
      current.off("error", failed);
      resolve(outcome);
    };
    const received = (value: { outcome: unknown }) => {
      const parsed = outcomeSchema.safeParse(value.outcome);
      finish(
        parsed.success
          ? parsed.data
          : {
              status: "failed",
              code: "MODEL_RESPONSE",
              details: "Некорректный ответ модели.",
            },
      );
    };
    const failed = () => {
      thread = null;
      modelsReady = false;
      finish({
        status: "failed",
        code: "MODEL_FAILURE",
        details: "Обработчик модели остановился.",
      });
    };
    const timer = setTimeout(() => {
      thread = null;
      modelsReady = false;
      void current.terminate();
      finish({
        status: "unavailable",
        code: "MODEL_TIMEOUT",
        details: "Модель не завершила анализ за 60 секунд.",
      });
    }, 60000);
    current.once("message", received);
    current.once("error", failed);
    current.postMessage({ version, input });
  });
}
async function capabilities(): Promise<Capability[]> {
  try {
    engine = clam ? await clamVersion(clam) : null;
    if (engine) lastClamSuccess = Date.now();
  } catch {
    engine = null;
  }
  return capabilitySchema
    .array()
    .parse([
      ...(thread
        ? models.map((m) => ({
            detector: m.detector,
            version: m.version,
            languages: m.languages,
          }))
        : []),
      ...(engine
        ? [
            {
              detector: "url-signature",
              version: await sha256(engine + ":download-v2"),
              languages: [],
            },
          ]
        : []),
    ]);
}
await startInference(models);
let caps = await capabilities(),
  lastMaintenance = 0;
const heartbeat = setInterval(() => {
  void api("/api/internal/claim", {
    workerId: id,
    capabilities: stopping ? [] : caps.filter((cap) => cap.detector === "url-signature"
      ? !!engine && Date.now() - lastClamSuccess < 90000
      : modelsReady && !!thread),
    claim: false,
  }).catch(() => {});
}, 15000);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping = true;
    healthServer?.close();
  });
while (!stopping) {
  try {
    if (models.length && !thread) {
      await startInference(models);
      caps = await capabilities();
    }
    if (Date.now() - lastMaintenance > 60000) {
      caps = await capabilities();
      await api("/api/internal/maintenance", {});
      lastMaintenance = Date.now();
    }
    const { job } = (await api("/api/internal/claim", {
      workerId: id,
      capabilities: caps,
      claim: true,
    })) as {
      job: null | {
        id: string;
        lease: string;
        version: string;
        createdAt: number;
        input: JobInput;
      };
    };
    if (!job) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const started = performance.now(),
      queueWaitMs = Math.max(0, Date.now() - job.createdAt);
    let outcome: Outcome;
    if (job.input.detector === "url-signature") {
      try {
        if (!clam) throw new Error("CLAM_UNAVAILABLE");
        // Validate freshness for every scan, including a database update or outage.
        engine = await clamVersion(clam);
        lastClamSuccess = Date.now();
        const file = await safeDownload(job.input.url);
        const scanned = await scanBytes(clam, file.bytes);
        outcome = {
          status: "completed",
          signature: {
            ...scanned,
            engine,
            bytes: file.bytes.length,
            finalUrlHash: await sha256(file.url),
            redirectCount: file.redirectCount,
          },
        };
      } catch {
        outcome = {
          status: "unavailable",
          code: "SIGNATURE_SCAN_UNAVAILABLE",
          details:
            "Содержимое по ссылке не удалось полностью проверить. Переход остаётся закрыт.",
        };
      }
    } else outcome = await infer(job.version, job.input);
    await api("/api/internal/complete", {
      id: job.id,
      lease: job.lease,
      outcome,
    });
    console.log(
      JSON.stringify({
        event: "job_finished",
        detector: job.input.detector,
        status: outcome.status,
        queueWaitMs,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "worker_retry",
        code: error instanceof Error ? error.message : "ERROR",
      }),
    );
    await new Promise((r) => setTimeout(r, 3000));
  }
}
clearInterval(heartbeat);
await api("/api/internal/claim", {
  workerId: id,
  capabilities: [],
  claim: false,
}).catch(() => {});
await (thread as Worker | null)?.terminate();
