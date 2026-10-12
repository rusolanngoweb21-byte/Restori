import { z } from "zod";

// Protocol vocabulary, not a claim that a model exists for every language.
export const languageSchema = z.enum([
  "ru", "en", "uk", "de", "fr", "es", "pt", "it", "nl", "pl", "cs",
  "ar", "zh", "ja", "ko", "vi", "hi", "tr", "el", "bg", "sw", "th", "ur",
]);
export type TextLanguage = z.infer<typeof languageSchema>;
export const MAX_MODELS = 8;
export const MAX_CAPABILITIES = MAX_MODELS + 1; // Optional signature scanner.

export function countWords(text: string, language: TextLanguage): number {
  const segments = new Intl.Segmenter(language, { granularity: "word" }).segment(text);
  let count = 0;
  for (const segment of segments) if (segment.isWordLike) count++;
  return count;
}

/** Conservative script guard, not an automatic language identifier. */
export function scriptMatches(text: string, language: TextLanguage): boolean {
  const letters = text.match(/\p{L}/gu)?.length || 1;
  if (language === "ru")
    return (text.match(/\p{Script=Cyrillic}/gu)?.length || 0) / letters >= 0.85;
  if (language === "en")
    return (text.match(/\p{Script=Latin}/gu)?.length || 0) / letters >= 0.85;
  return true;
}
