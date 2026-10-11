import { z } from "zod";
import { evaluate, normalizeInput, type Evidence } from "./scanner.ts";
import {
  outcomeSchema,
  type ThreatCheck,
  type ThreatResult,
} from "./contracts.ts";
import { readBytes, sha256 } from "./http.ts";
import { SingleFlight } from "./cache.ts";
import type { Store } from "./store.ts";
import type { Settings } from "./runtime.ts";
const empty: Evidence = {
  a: null,
  aaaa: null,
  mx: null,
  txt: null,
  dmarc: null,
  ns: null,
  rdap: null,
  apple: null,
  rdapSource: "RDAP",
};
const flights = new SingleFlight<ThreatCheck>();
export function canonicalTarget(raw: string) {
  const url = normalizeInput(raw);
  url.hash = "";
  return url;
}
async function providerJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
) {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("PROVIDER_STATUS");
  return JSON.parse(
    new TextDecoder().decode(await readBytes(response, 262144)),
  ) as unknown;
}
export async function checkThreat(
  raw: string,
  store: Store,
  settings: Settings,
  fetcher: typeof fetch = fetch,
  fresh = false,
): Promise<ThreatResult> {
  const url = canonicalTarget(raw),
    hash = await sha256(url.href);
  const blocked = await store.blocked(hash);
  const stamp = () => new Date().toISOString();
  if (blocked)
    return {
      status: "blocked",
      navigationAllowed: false,
      reason: blocked.reason,
      checkedAt: stamp(),
      checks: [
        {
          source: "Серверная блокировка",
          status: "malicious",
          detail: blocked.reason,
        },
      ],
    };
  const local = evaluate(raw, url, empty);
  if (local.level === "high") {
    const reason =
      "Сильные признаки подмены адреса. Переход через Призму заблокирован.";
    await store.block(hash, reason);
    return {
      status: "blocked",
      navigationAllowed: false,
      reason,
      checkedAt: stamp(),
      checks: [
        { source: "Правила адреса", status: "malicious", detail: reason },
      ],
    };
  }
  if (local.signals.some((s) => s.id === "secret" && s.status === "warn"))
    return {
      status: "hold",
      navigationAllowed: false,
      reason:
        "В ссылке возможен секретный параметр. Удалите его перед проверкой.",
      checkedAt: stamp(),
      checks: [
        {
          source: "Защита приватных ссылок",
          status: "unavailable",
          detail: "Ссылка не передавалась репутационным службам.",
        },
      ],
    };
  async function reputation(
    name: string,
    enabled: boolean,
    fn: () => Promise<ThreatCheck>,
  ): Promise<ThreatCheck> {
    if (!enabled)
      return {
        source: name,
        status: "unavailable",
        detail: "Источник не подключён. Репутация не проверена.",
      };
    const key = `reputation:v2:${name}:${hash}`;
    if (!fresh) {
      const cached = await store.cacheGet<ThreatCheck>(key);
      if (cached) return cached;
    }
    try {
      return await flights.run(key + (fresh ? ":fresh" : ""), async () => {
        const result = await fn();
        await store.cacheSet(key, result, 30000);
        return result;
      });
    } catch {
      return {
        source: name,
        status: "unavailable",
        detail: "Источник недоступен. Это не означает безопасность ссылки.",
      };
    }
  }
  const checks = await Promise.all([
    reputation("Google Web Risk", !!settings.WEBRISK_API_KEY, async () => {
      const endpoint = new URL("https://webrisk.googleapis.com/v1/uris:search");
      for (const type of ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"])
        endpoint.searchParams.append("threatTypes", type);
      endpoint.searchParams.set("uri", url.href);
      const data = z
        .object({
          threat: z
            .object({
              threatTypes: z.array(z.string()).min(1),
              expireTime: z.string().optional(),
            })
            .optional(),
        })
        .strict()
        .parse(
          await providerJson(fetcher, endpoint.href, {
            headers: { "X-Goog-Api-Key": settings.WEBRISK_API_KEY! },
          }),
        );
      return {
        source: "Google Web Risk",
        status: data.threat ? "malicious" : "clear",
        detail: data.threat
          ? `Обнаружено: ${data.threat.threatTypes.join(", ")}.`
          : "Адрес не найден в проверенных списках угроз.",
      };
    }),
    reputation("URLhaus", !!settings.URLHAUS_AUTH_KEY, async () => {
      const data = z
        .object({ query_status: z.enum(["ok", "no_results"]) })
        .passthrough()
        .parse(
          await providerJson(fetcher, "https://urlhaus-api.abuse.ch/v1/url/", {
            method: "POST",
            headers: {
              "Auth-Key": settings.URLHAUS_AUTH_KEY!,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ url: url.href }).toString(),
          }),
        );
      return {
        source: "URLhaus",
        status: data.query_status === "ok" ? "malicious" : "clear",
        detail:
          data.query_status === "ok"
            ? "Адрес присутствует в базе распространения вредоносных файлов."
            : "Совпадение в базе URLhaus не найдено.",
      };
    }),
  ]);
  const parsed = outcomeSchema.safeParse(
    await store.cacheGet<unknown>(`signature:${hash}`),
  );
  if (
    parsed.success &&
    parsed.data.status === "completed" &&
    "signature" in parsed.data
  ) {
    const value = parsed.data.signature;
    checks.push({
      source: "ClamAV · сигнатуры",
      status: value.status === "malicious" ? "malicious" : "clear",
      detail:
        value.status === "malicious"
          ? `Найдена сигнатура: ${value.signature}.`
          : `В проверенном ответе (${value.bytes} байт) сигнатуры не найдены. Скрипты и вложенные ресурсы не выполнялись.`,
    });
    if (value.redirectCount > 0)
      checks.push({
        source: "Перенаправления",
        status: "unavailable",
        detail:
          "Адрес перенаправляет на другую страницу. Репутация всей цепочки не подтверждена; переход закрыт.",
      });
  } else
    checks.push({
      source: "ClamAV · сигнатуры",
      status: "unavailable",
      detail: "Содержимое по ссылке антивирусом ещё не проверено.",
    });
  const malicious = checks.find((c) => c.status === "malicious");
  if (malicious) {
    await store.block(hash, `${malicious.source}: ${malicious.detail}`);
    return {
      status: "blocked",
      navigationAllowed: false,
      reason: malicious.detail,
      checkedAt: stamp(),
      checks,
    };
  }
  const revoked = await store.blocked(hash);
  if (revoked)
    return {
      status: "blocked",
      navigationAllowed: false,
      reason: revoked.reason,
      checkedAt: stamp(),
      checks,
    };
  const clear =
    checks.every((c) => c.status === "clear") &&
    local.level !== "attention" &&
    url.protocol === "https:";
  return {
    status: clear ? "clear" : "hold",
    navigationAllowed: clear,
    checkedAt: stamp(),
    checks,
    reason: clear
      ? "В выполненных проверках угрозы не обнаружены. Это не гарантия подлинности владельца."
      : "Переход закрыт: есть предупреждения или проверка угроз не завершена.",
  };
}
