import { openStore } from "./storage.ts";
import { createWebServer } from "./server.ts";

const publicOrigin = process.env.PUBLIC_ORIGIN || "";
const trustedProxy = process.env.TRUSTED_PROXY || "";
if (!trustedProxy) throw new Error("TRUSTED_PROXY_REQUIRED");
if ((process.env.WORKER_SERVICE_TOKEN || "").length < 32) throw new Error("WORKER_SERVICE_TOKEN_REQUIRED");
const app = openStore(process.env.DATABASE_PATH || "/data/prizma.sqlite");
const options = { publicOrigin, store: app.store, settings: {
  WORKER_SERVICE_TOKEN: process.env.WORKER_SERVICE_TOKEN,
  WEBRISK_API_KEY: process.env.WEBRISK_API_KEY,
  URLHAUS_AUTH_KEY: process.env.URLHAUS_AUTH_KEY,
} };
const web = createWebServer({ ...options, kind: "public", trustedProxy, assetsDir: process.env.ASSETS_PATH || "/app/dist-web" });
const worker = createWebServer({ ...options, kind: "worker" });
web.listen(3000, "0.0.0.0");
worker.listen(8081, "0.0.0.0");
let cleaning = false, stopping = false;
const maintenance = setInterval(async () => {
  if (cleaning || stopping) return;
  cleaning = true;
  try { await app.store.cleanup(); } catch { console.error('{"event":"maintenance_failed"}'); }
  finally { cleaning = false; }
}, 60000);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true; clearInterval(maintenance);
  // Crash-safe WAL remains usable if the process cannot drain by its deadline.
  const deadline = setTimeout(() => process.exit(1), 25000); deadline.unref();
  Promise.all([web, worker].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    .then(async () => {
      while (cleaning) await new Promise(resolve => setTimeout(resolve, 20));
      app.close(); clearTimeout(deadline);
    }).catch(() => process.exit(1));
});
