import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { normalizeInput, isNonPublicIP } from "../../lib/scanner.ts";

export type Resolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;
export async function resolvePublic(
  host: string,
  resolver: Resolver = (h) => dns.lookup(h, { all: true, verbatim: true }),
) {
  const name = host.replace(/^\[|\]$/g, "");
  const entries = isIP(name)
    ? [{ address: name, family: isIP(name) }]
    : await resolver(name);
  if (
    !entries.length ||
    entries.some(
      (x) =>
        isNonPublicIP(x.address) ||
        /^2001:(?:0|[12][0-9a-f]):/i.test(x.address),
    )
  )
    throw new Error("PRIVATE_ADDRESS");
  return entries[0];
}
/** Resolve every hop and pin the actual connection to that validated IP. No cookies, proxy, JS or subresources. */
export async function safeDownload(
  raw: string,
  resolver?: Resolver,
): Promise<{ bytes: Buffer; url: string; redirectCount: number }> {
  let target = normalizeInput(raw);
  const deadline = Date.now() + 15000;
  for (let hop = 0; hop <= 3; hop++) {
    if (
      target.username ||
      target.password ||
      target.hash ||
      (target.port && !["80", "443"].includes(target.port))
    )
      throw new Error("UNSAFE_URL");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("DOWNLOAD_TIMEOUT");
    const resolved = await Promise.race([
      resolvePublic(target.hostname, resolver),
      new Promise<never>((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("DNS_TIMEOUT")),
          Math.min(remaining, 3000),
        );
        t.unref();
      }),
    ]);
    const response = await new Promise<{
      status: number;
      location?: string;
      bytes: Buffer;
    }>((resolve, reject) => {
      const transport = target.protocol === "https:" ? https : http;
      const req = transport.request(
        target,
        {
          method: "GET",
          agent: false,
          family: resolved.family,
          headers: {
            "User-Agent": "Prizma-Security-Scanner/2.0",
            "Accept-Encoding": "identity",
            Accept: "*/*",
          },
          // Node must not perform a second DNS lookup after validation (rebinding).
          lookup: (_hostname, _options, callback) =>
            callback(null, resolved.address, resolved.family),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = res.headers.location;
            res.destroy();
            resolve({ status, location, bytes: Buffer.alloc(0) });
            return;
          }
          if (status !== 200) {
            res.destroy();
            reject(new Error("DOWNLOAD_STATUS"));
            return;
          }
          if (
            res.headers["content-encoding"] &&
            res.headers["content-encoding"] !== "identity"
          ) {
            res.destroy();
            reject(new Error("ENCODING_UNSUPPORTED"));
            return;
          }
          if (Number(res.headers["content-length"] ?? 0) > 8388608) {
            res.destroy();
            reject(new Error("DOWNLOAD_LIMIT"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8388608) {
              req.destroy(new Error("DOWNLOAD_LIMIT"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () =>
            resolve({ status, bytes: Buffer.concat(chunks) }),
          );
        },
      );
      const timeout = setTimeout(
        () => req.destroy(new Error("DOWNLOAD_TIMEOUT")),
        Math.max(1, deadline - Date.now()),
      );
      req.on("error", reject);
      req.on("close", () => clearTimeout(timeout));
      req.end();
    });
    if (response.location) {
      if (hop === 3) throw new Error("REDIRECT_LIMIT");
      target = normalizeInput(new URL(response.location, target).href);
      target.hash = "";
      continue;
    }
    if (response.status !== 200) throw new Error("REDIRECT_INVALID");
    return { bytes: response.bytes, url: target.href, redirectCount: hop };
  }
  throw new Error("REDIRECT_LIMIT");
}
