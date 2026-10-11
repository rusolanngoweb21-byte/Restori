import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { scanBytes, clamVersion } from "../services/analyzer/clamav.ts";

async function withDaemon(
  reply: string,
  check: (connection: { host: string; port: number }) => Promise<void>,
) {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await check({ host: "127.0.0.1", port: (server.address() as net.AddressInfo).port });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a disconnected ClamAV response without its terminator cannot authorize a clean scan", async () => {
  await withDaemon("stream: OK", async (connection) => {
    await assert.rejects(scanBytes(connection, Buffer.from("harmless test data")), /CLAM_INCOMPLETE/);
  });
});

test("a truncated version response cannot advertise antivirus readiness", async () => {
  await withDaemon(`ClamAV 1.4.6/12345/${new Date().toUTCString()}`, async (connection) => {
    await assert.rejects(clamVersion(connection), /CLAM_INCOMPLETE/);
  });
});

test("complete ClamAV replies still distinguish clean files and detections", async () => {
  await withDaemon("stream: OK\0", async (connection) => {
    assert.equal((await scanBytes(connection, Buffer.from("harmless test data"))).status, "clean");
  });
  await withDaemon("stream: Eicar-Signature FOUND\0", async (connection) => {
    assert.equal((await scanBytes(connection, Buffer.from("harmless protocol fixture"))).status, "malicious");
  });
});
