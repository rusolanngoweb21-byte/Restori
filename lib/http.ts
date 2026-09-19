import { ZodError } from "zod";
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  Vary: "Cookie, Origin",
};
export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(body, { status, headers: { ...privateHeaders, ...headers } });
export function denyNavigation(
  request: Request,
  reason: string,
  status: number,
) {
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    return json({ error: reason }, status);
  const escaped = reason.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
  return new Response(
    `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Переход заблокирован · Призма</title><style>body{font:18px/1.6 system-ui;margin:12vh auto;padding:24px;max-width:640px;background:#f5f7f9;color:#233442}h1{color:#922b30;font-size:30px}a{color:#13614d}</style><h1>Переход не разрешён</h1><p>${escaped}</p><a href="/">Вернуться в Призму</a></html>`,
    {
      status,
      headers: {
        ...privateHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'",
      },
    },
  );
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new ApiError(
      403,
      "ORIGIN",
      "Запрос доступен через форму на этом сайте.",
    );
}
export async function readBytes(
  request: Request | Response,
  maximum: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maximum)
    throw new ApiError(413, "BODY_LIMIT", "Превышен размер запроса.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "EMPTY_BODY", "Пустой запрос.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 15000);
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new ApiError(413, "BODY_LIMIT", "Превышен размер запроса.");
      }
      chunks.push(item.value);
    }
    if (expired)
      throw new ApiError(
        408,
        "BODY_TIMEOUT",
        "Передача данных заняла слишком много времени.",
      );
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}
export async function readJson(
  request: Request,
  maximum = 8192,
): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new ApiError(415, "CONTENT_TYPE", "Ожидается JSON.");
  const bytes = await readBytes(request, maximum);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Некорректный JSON.");
  }
}
export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const result = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(result), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function session(request: Request) {
  const secure = new URL(request.url).protocol === "https:";
  const name = secure ? "__Host-prizma_session" : "prizma_session";
  const existing = new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{64})(?:;|$)`).exec(
    request.headers.get("cookie") || "",
  )?.[1];
  const token = existing || randomToken();
  return {
    owner: await sha256(token),
    headers: existing
      ? {}
      : {
          "Set-Cookie": `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? "; Secure" : ""}`,
        },
  } as { owner: string; headers: Record<string, string> };
}
export function failure(error: unknown): Response {
  if (error instanceof ZodError)
    return json(
      { error: "Неверный формат запроса.", code: "INVALID_INPUT" },
      400,
    );
  if (error instanceof ApiError)
    return json(
      { error: error.message, code: error.code },
      error.status,
      error.status === 429 ? { "Retry-After": "60" } : {},
    );
  // Never log URLs, tokens, uploaded text or image bytes.
  console.error(
    JSON.stringify({
      event: "request_failed",
      type: error instanceof Error ? error.name : "unknown",
    }),
  );
  return json(
    {
      error: "Проверка временно недоступна. Попробуйте позже.",
      code: "UNAVAILABLE",
    },
    503,
  );
}
