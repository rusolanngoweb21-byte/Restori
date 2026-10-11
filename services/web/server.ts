import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { createApi } from "../../lib/api.ts";
import { ApiError, failure, json } from "../../lib/http.ts";
import type { Store } from "../../lib/store.ts";
import type { Settings } from "../../lib/runtime.ts";

type Options = {
  publicOrigin: string;
  store: Store;
  settings: Settings;
  kind: "public" | "worker";
  /** Exact socket peer address of the local ingress, not a user-controlled header. */
  trustedProxy?: string;
  assetsDir?: string;
  bodyTimeoutMs?: number;
};
const normalizeIP = (ip: string) => ip.startsWith("::ffff:") ? ip.slice(7) : ip;
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
};
const securityHeaders = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY", "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function loadAssets(directory?: string) {
  const assets = new Map<string, { bytes: Buffer; type: string }>();
  if (!directory) return assets;
  let total = 0;
  function visit(folder: string, prefix: string) {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      if (item.name.startsWith(".")) continue;
      const key = prefix + "/" + item.name, file = join(folder, item.name);
      if (item.isDirectory()) { if (key === "/assets") visit(file, key); continue; }
      if (!item.isFile() || !contentTypes[extname(item.name)]) continue;
      const bytes = readFileSync(file); total += bytes.length;
      if (total > 20_000_000) throw new Error("ASSET_LIMIT");
      assets.set(key, { bytes, type: contentTypes[extname(item.name)] });
    }
  }
  visit(directory, "");
  if (!assets.has("/index.html")) throw new Error("INDEX_REQUIRED");
  assets.set("/", assets.get("/index.html")!);
  return assets;
}
function readBody(request: IncomingMessage, maximum: number, timeout: number): Promise<Buffer> {
  if (Number(request.headers["content-length"] || 0) > maximum)
    return Promise.reject(new ApiError(413, "BODY_LIMIT", "Превышен размер запроса."));
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
    return Promise.reject(new ApiError(415, "CONTENT_ENCODING", "Сжатые запросы не поддерживаются."));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const timer = setTimeout(() => finish(new ApiError(408, "BODY_TIMEOUT", "Передача данных заняла слишком много времени.")), timeout);
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) finish(new ApiError(413, "BODY_LIMIT", "Превышен размер запроса."));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new ApiError(400, "BODY_ABORTED", "Запрос прерван."));
    function finish(error?: Error) {
      clearTimeout(timer);
      request.off("data", onData); request.off("end", onEnd);
      request.off("aborted", onError); request.off("error", onError);
      if (error) { request.pause(); reject(error); }
      else resolve(Buffer.concat(chunks, size));
    }
    request.on("data", onData); request.once("end", onEnd);
    request.once("aborted", onError); request.once("error", onError);
  });
}
async function respond(response: ServerResponse, result: Response) {
  if (response.destroyed) return;
  for (const [key, value] of Object.entries(securityHeaders)) response.setHeader(key, value);
  result.headers.forEach((value, key) => { if (key !== "set-cookie") response.setHeader(key, value); });
  const cookies = result.headers.getSetCookie();
  if (cookies.length) response.setHeader("set-cookie", cookies);
  response.statusCode = result.status;
  response.end(Buffer.from(await result.arrayBuffer()));
}

export function createWebServer(options: Options) {
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || origin.username || origin.password)
    throw new Error("PUBLIC_HTTPS_ORIGIN_REQUIRED");
  if (options.trustedProxy && !isIP(options.trustedProxy)) throw new Error("INVALID_TRUSTED_PROXY");
  const api = createApi(options), assets = loadAssets(options.kind === "public" ? options.assetsDir : undefined);
  const publicRoutes = new Map([
    ["GET /api/capabilities", api.capabilities], ["POST /api/media", api.media],
    ["POST /api/analyze", api.analyze], ["POST /api/threat", api.threat], ["POST /api/out", api.out],
  ]);
  const workerRoutes = new Map([
    ["POST /api/internal/claim", api.claim], ["POST /api/internal/complete", api.complete],
    ["POST /api/internal/maintenance", api.maintenance],
  ]);
  let active = 0;
  const server = createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    if (active >= 8) { res.setHeader("Connection", "close"); await respond(res, json({ code: "BUSY" }, 503)); return; }
    active++;
    try {
      const target = req.url || "/";
      if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\"))
        throw new ApiError(400, "REQUEST_TARGET", "Некорректный адрес запроса.");
      const url = new URL(target, origin);
      // The private health listener is not published to the host.
      if (options.kind === "worker" && req.method === "GET" && url.pathname === "/healthz") {
        await options.store.db.prepare("SELECT 1").first();
        await respond(res, json({ status: "ok" })); return;
      }
      let ip = normalizeIP(req.socket.remoteAddress || "");
      if (options.kind === "public") {
        if (req.headers.host?.toLowerCase() !== origin.host)
          throw new ApiError(421, "HOST", "Неверный адрес сайта.");
        if (options.trustedProxy) {
          if (ip !== normalizeIP(options.trustedProxy)) throw new ApiError(403, "INGRESS", "Нет доступа.");
          const forwarded = req.headers["x-real-ip"];
          if (typeof forwarded !== "string" || !isIP(forwarded)) throw new ApiError(400, "CLIENT_IP", "Некорректный адрес клиента.");
          ip = normalizeIP(forwarded);
        }
      }
      let handler = (options.kind === "worker" ? workerRoutes : publicRoutes).get(req.method + " " + url.pathname);
      if (!handler && options.kind === "public" && req.method === "GET" && /^\/api\/jobs\/[a-f0-9-]{36}$/.test(url.pathname)) handler = api.job;
      if (!handler) {
        const asset = options.kind === "public" && (req.method === "GET" || req.method === "HEAD") ? assets.get(url.pathname) : undefined;
        if (asset) {
          await respond(res, new Response(req.method === "HEAD" ? null : new Uint8Array(asset.bytes), {
            headers: { "Content-Type": asset.type, "Cache-Control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" },
          }));
        } else { res.setHeader("Connection", "close"); await respond(res, json({ code: "NOT_FOUND" }, 404)); }
        return;
      }
      const headers = new Headers();
      for (const key of ["content-type", "cookie", "origin", "sec-fetch-site", "authorization"]) {
        const value = req.headers[key]; if (typeof value === "string") headers.set(key, value);
      }
      // Never copy inbound Cloudflare/forwarded headers into the application's identity.
      headers.set("cf-connecting-ip", ip);
      let body: Buffer | undefined;
      if (req.method === "POST") body = await readBody(req, url.pathname === "/api/media" ? 2_850_000 : url.pathname === "/api/internal/complete" ? 16384 : 8192, options.bodyTimeoutMs ?? 15000);
      const request = new Request(url, { method: req.method, headers, ...(body ? { body: new Uint8Array(body) } : {}) });
      await respond(res, await handler(request));
    } catch (error) {
      res.setHeader("Connection", "close");
      // Finish the error response before closing an oversized or stalled upload.
      res.once("finish", () => req.destroy());
      await respond(res, failure(error));
    } finally { active--; }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 64;
  return server;
}
