import net from "node:net";
export type ClamConnection = { path: string } | { host: string; port: number };
/** Clamd must be on a private network. Its protocol does not authenticate clients. */
export function clamCommand(
  connection: ClamConnection,
  command: "VERSION" | "INSTREAM",
  bytes?: Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection);
    let reply = Buffer.alloc(0),
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(reply.toString("utf8").replace(/\0[\s\S]*$/, ""));
    };
    const timer = setTimeout(() => finish(new Error("CLAM_TIMEOUT")), 12000);
    socket.on("error", (error) => finish(error));
    socket.on("end", () =>
      finish(reply.length ? undefined : new Error("CLAM_EMPTY")),
    );
    socket.on("data", (data: Buffer) => {
      reply = Buffer.concat([reply, data]);
      if (reply.length > 4096) return finish(new Error("CLAM_RESPONSE_LIMIT"));
      if (reply.includes(0)) finish();
    });
    socket.on("connect", () => {
      socket.write(`z${command}\0`);
      if (command === "INSTREAM") {
        if (!bytes || bytes.length > 8388608)
          return finish(new Error("CLAM_INPUT_LIMIT"));
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          const chunk = bytes.subarray(offset, offset + 65536),
            length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length);
          socket.write(length);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      }
    });
  });
}
export async function clamVersion(connection: ClamConnection) {
  const version = await clamCommand(connection, "VERSION");
  const timestamp = Date.parse(version.split("/").slice(2).join("/"));
  if (
    !Number.isFinite(timestamp) ||
    Date.now() - timestamp > 48 * 3600000 ||
    timestamp > Date.now() + 3600000
  )
    throw new Error("SIGNATURES_STALE");
  return version;
}
export async function scanBytes(connection: ClamConnection, bytes: Buffer) {
  const result = await clamCommand(connection, "INSTREAM", bytes);
  if (result === "stream: OK")
    return { status: "clean" as const, signature: null };
  const found = /^stream: (.{1,200}) FOUND$/.exec(result);
  if (found) return { status: "malicious" as const, signature: found[1] };
  throw new Error("CLAM_INCOMPLETE");
}
