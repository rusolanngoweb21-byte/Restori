import { mediaInputSchema, type MediaInput } from "./contracts.ts";
import { ApiError, sha256 } from "./http.ts";
import type { Store } from "./store.ts";
import { countWords, scriptMatches } from "./languages.ts";

export function validateMedia(value: unknown): MediaInput {
  const parsed = mediaInputSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      "INVALID_MEDIA",
      "Проверьте формат текста или изображения.",
    );
  const input = parsed.data;
  if (input.detector === "text-ai") {
    input.text = input.text.trim();
    if (input.text.length < 400 || countWords(input.text, input.language) < 80)
      throw new ApiError(
        422,
        "TEXT_TOO_SHORT",
        "Для анализа нужен связный текст: не менее 80 слов и 400 символов.",
      );
    if (!scriptMatches(input.text, input.language))
      throw new ApiError(
        422,
        "LANGUAGE_MISMATCH",
        "Для этого текста выбран неподходящий язык.",
      );
  } else {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        input.imageBase64,
      )
    )
      throw new ApiError(400, "INVALID_IMAGE", "Повреждённое изображение.");
    const bytes = Uint8Array.from(atob(input.imageBase64), (c) =>
      c.charCodeAt(0),
    );
    if (bytes.length > 2097152)
      throw new ApiError(413, "IMAGE_LIMIT", "Размер изображения — до 2 МБ.");
    const png =
      bytes.length >= 24 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
    const jpg =
      bytes.length > 3 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255;
    if (!png && !jpg)
      throw new ApiError(
        415,
        "IMAGE_TYPE",
        "Поддерживаются только PNG и JPEG. SVG и другие форматы не принимаются.",
      );
  }
  return input;
}
export async function enqueueMedia(
  store: Store,
  owner: string,
  value: unknown,
) {
  const input = validateMedia(value);
  const capability = (await store.capabilities()).find(
    (c) =>
      c.detector === input.detector &&
      (input.detector !== "text-ai" || c.languages.includes(input.language)),
  );
  if (!capability)
    throw new ApiError(
      503,
      "MODEL_UNAVAILABLE",
      "Модель для этой проверки сейчас не подключена. Результат и процент не рассчитаны.",
    );
  const key = `media:v2:${owner}:${capability.version}:${await sha256(JSON.stringify(input))}`;
  return store.enqueue(owner, capability, input, key);
}
