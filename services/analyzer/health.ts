import { createServer } from "node:http";

export type WorkerHealth = {
  stopping: boolean;
  modelsReady: boolean;
  clamavReady: boolean;
  siteReady: boolean;
};

/** Private readiness only; never expose payloads, tokens or model paths. */
export function startHealthServer(
  port: number,
  snapshot: () => WorkerHealth,
  requireClamav: boolean,
  host = "::",
) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("HEALTH_PORT_INVALID");
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    if (request.method !== "GET" || request.url !== "/healthz") {
      response.writeHead(404).end('{"status":"not_found"}');
      return;
    }
    const state = snapshot();
    const ready = !state.stopping && state.modelsReady && state.siteReady &&
      (!requireClamav || state.clamavReady);
    response.writeHead(ready ? 200 : 503).end(JSON.stringify({
      status: ready ? "ready" : "not_ready",
      models: state.modelsReady,
      clamav: state.clamavReady,
      site: state.siteReady,
    }));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(port, host);
  return server;
}
