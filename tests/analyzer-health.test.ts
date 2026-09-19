import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { startHealthServer, type WorkerHealth } from "../services/analyzer/health.ts";

test("Railway readiness fails closed for missing models, Site, ClamAV or shutdown", async () => {
  let state: WorkerHealth = {
    stopping: false, modelsReady: true, clamavReady: true, siteReady: true,
  };
  const server = startHealthServer(0, () => state, true, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/healthz`;
  try {
    assert.equal((await fetch(url)).status, 200);
    for (const key of ["modelsReady", "clamavReady", "siteReady"] as const) {
      state[key] = false;
      const response = await fetch(url);
      assert.equal(response.status, 503, `${key} must block readiness`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      state[key] = true;
    }
    state.stopping = true;
    assert.equal((await fetch(url)).status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
