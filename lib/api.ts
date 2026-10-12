import { z } from "zod";
import { analyzeLink, normalizeInput, type Report } from "./scanner.ts";
import { MAX_CAPABILITIES } from "./languages.ts";
import {
  capabilitySchema,
  outcomeSchema,
  type ThreatResult,
} from "./contracts.ts";
import {
  ApiError,
  failure,
  json,
  readJson,
  readBytes,
  sameOrigin,
  session,
  sha256,
  denyNavigation,
} from "./http.ts";
import { enqueueMedia } from "./media.ts";
import { canonicalTarget, checkThreat } from "./threats.ts";
import { LruCache, SingleFlight } from "./cache.ts";
import type { Store } from "./store.ts";
import type { Settings } from "./runtime.ts";
import { withThreat } from "./report.ts";
export type { ExtendedReport } from "./report.ts";
const reportLru = new LruCache<Report>(128),
  reportFlight = new SingleFlight<Report>(512);
const localLimits = new LruCache<{ count: number; expires: number }>(2000);
let activeMediaUploads = 0;
const urlInput = z.object({ url: z.string().min(1).max(2048) }).strict();
type Dependencies = {
  store: Store;
  settings: Settings;
  analyze?: typeof analyzeLink;
  fetcher?: typeof fetch;
};
export function createApi({
  store,
  settings,
  analyze = analyzeLink,
  fetcher = fetch,
}: Dependencies) {
  async function limited(request: Request, category: string, maximum: number) {
    sameOrigin(request);
    const ip = request.headers.get("cf-connecting-ip") || "local-preview";
    const key = `${category}:${await sha256(ip + new Date().toISOString().slice(0, 10))}`,
      now = Date.now();
    const existing = localLimits.get(key);
    if (existing && existing.expires > now && existing.count >= maximum)
      throw new ApiError(
        429,
        "RATE_LIMIT",
        "Слишком много запросов. Подождите минуту.",
      );
    // D1 remains authoritative across instances. Local rejection prevents a hot abusive client from hammering it.
    await store.rate(key, maximum);
    const state =
      existing && existing.expires > now
        ? existing
        : { count: 0, expires: now + 60000 };
    state.count++;
    localLimits.set(key, state, Math.max(1, state.expires - now));
  }
  const wrap =
    (fn: (request: Request) => Promise<Response>) =>
    async (request: Request) => {
      try {
        return await fn(request);
      } catch (error) {
        return failure(error);
      }
    };
  async function getUrl(request: Request, form = false) {
    let value: unknown;
    if (
      form &&
      request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    ) {
      const fields = new URLSearchParams(
        new TextDecoder().decode(await readBytes(request, 8192)),
      );
      if ([...fields.keys()].length !== 1 || !fields.has("url"))
        throw new ApiError(400, "URL_INPUT", "Передайте только ссылку.");
      value = { url: fields.get("url") };
    } else value = await readJson(request);
    const parsed = urlInput.safeParse(value);
    if (!parsed.success)
      throw new ApiError(400, "URL_INPUT", "Передайте одну ссылку в поле url.");
    try {
      normalizeInput(parsed.data.url);
    } catch (error) {
      throw new ApiError(400, "URL_INVALID", (error as Error).message);
    }
    return parsed.data.url;
  }
  async function workerAuth(request: Request) {
    if (
      !settings.WORKER_SERVICE_TOKEN ||
      settings.WORKER_SERVICE_TOKEN.length < 32
    )
      throw new ApiError(
        503,
        "WORKER_UNCONFIGURED",
        "Обработчик не подключён.",
      );
    const supplied =
      request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
    const [left, right] = await Promise.all([
      sha256(supplied),
      sha256(settings.WORKER_SERVICE_TOKEN),
    ]);
    let delta = 0;
    for (let i = 0; i < left.length; i++)
      delta |= left.charCodeAt(i) ^ right.charCodeAt(i);
    if (delta) throw new ApiError(401, "WORKER_AUTH", "Нет доступа.");
  }
  return {
    capabilities: wrap(async (request) => {
      const identity = await session(request);
      return json(
        {
          capabilities: await store.capabilities(),
          reputation: {
            webRisk: !!settings.WEBRISK_API_KEY,
            urlhaus: !!settings.URLHAUS_AUTH_KEY,
          },
        },
        200,
        identity.headers,
      );
    }),
    media: wrap(async (request) => {
      await limited(request, "media", 10);
      if (activeMediaUploads >= 2)
        throw new ApiError(
          503,
          "UPLOAD_BUSY",
          "Загрузка занята. Повторите через несколько секунд.",
        );
      activeMediaUploads++;
      try {
        const identity = await session(request),
          job = await enqueueMedia(
            store,
            identity.owner,
            await readJson(request, 2850000),
          );
        return json(
          job,
          job.state === "finished" ? 200 : 202,
          identity.headers,
        );
      } finally {
        activeMediaUploads--;
      }
    }),
    job: wrap(async (request) => {
      await limited(request, "poll", 180);
      const id = new URL(request.url).pathname.split("/").pop() || "";
      if (!/^[a-f0-9-]{36}$/.test(id))
        throw new ApiError(404, "JOB_MISSING", "Проверка не найдена.");
      const identity = await session(request),
        job = await store.job(id, identity.owner);
      if (!job)
        throw new ApiError(
          404,
          "JOB_MISSING",
          "Проверка не найдена или срок хранения истёк.",
        );
      return json(job, 200, identity.headers);
    }),
    analyze: wrap(async (request) => {
      await limited(request, "analyze", 20);
      const raw = await getUrl(request),
        identity = await session(request),
        key = `report:v2:${await sha256(raw)}`;
      const reportPromise = reportFlight.run(key, async () => {
        const cached =
          reportLru.get(key) || (await store.cacheGet<Report>(key));
        if (cached) return cached;
        const report = await analyze(raw),
          ttl = report.checked > 20 ? 60000 : 5000;
        reportLru.set(key, report, ttl);
        await store.cacheSet(key, report, ttl);
        return report;
      });
      const [report, threat] = await Promise.all([
        reportPromise,
        checkThreat(raw, store, settings, fetcher),
      ]);
      if (
        threat.status === "hold" &&
        threat.checks.some(
          (c) => c.source.startsWith("ClamAV") && c.status === "unavailable",
        )
      ) {
        const capability = (await store.capabilities()).find(
          (c) => c.detector === "url-signature",
        );
        if (capability) {
          const url = canonicalTarget(raw).href;
          threat.signatureJob = await store.enqueue(
            identity.owner,
            capability,
            { detector: "url-signature", url },
            `signature:${await sha256(url)}`,
          );
        }
      }
      return json(withThreat(report, threat), 200, identity.headers);
    }),
    threat: wrap(async (request) => {
      await limited(request, "threat", 30);
      return json(
        await checkThreat(await getUrl(request), store, settings, fetcher),
      );
    }),
    out: wrap(async (request) => {
      await limited(request, "navigate", 10);
      const raw = await getUrl(request, true),
        result = await checkThreat(raw, store, settings, fetcher, true);
      if (!result.navigationAllowed)
        return denyNavigation(
          request,
          result.reason,
          result.status === "blocked" ? 403 : 409,
        );
      const url = canonicalTarget(raw),
        revoked = await store.blocked(await sha256(url.href));
      if (revoked) return denyNavigation(request, revoked.reason, 403);
      return new Response(null, {
        status: 303,
        headers: {
          Location: url.href,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }),
    claim: wrap(async (request) => {
      await workerAuth(request);
      const data = z
        .object({
          workerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          capabilities: capabilitySchema.array().max(MAX_CAPABILITIES),
          claim: z.boolean().default(true),
        })
        .strict()
        .parse(await readJson(request));
      await store.heartbeat(data.workerId, data.capabilities);
      return json({
        job: data.claim ? await store.claim(data.capabilities) : null,
      });
    }),
    complete: wrap(async (request) => {
      await workerAuth(request);
      const data = z
        .object({
          id: z.string().uuid(),
          lease: z.string().regex(/^[a-f0-9]{64}$/),
          outcome: outcomeSchema,
        })
        .strict()
        .parse(await readJson(request, 16384));
      await store.complete(data.id, data.lease, data.outcome);
      return json({ ok: true });
    }),
    maintenance: wrap(async (request) => {
      await workerAuth(request);
      await store.cleanup();
      return json({ ok: true });
    }),
  };
}
