import { readFile } from "node:fs/promises";
import path from "node:path";
import { PreTrainedTokenizer } from "@huggingface/transformers";
import { InferenceSession, Tensor } from "onnxruntime-node";

// Port of normalization from pinned revision 00141fe7...; no downloaded code.
export function normalizeRuText(text: string): string {
  return text
    .replace(/[\u200b\u200c\u200d\u200e\u200f\u2060\ufeff\u00ad]/gu, "")
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000\t\r\f\v]/gu, " ")
    .replace(/^[ ]*(?:```|~~~).*$/gm, "")
    .replace(/^[ ]*(?:[-*_=][ ]*){3,}$/gm, "")
    .replace(/^[ ]*\|?(?:[ ]*:?-+:?[ ]*\|)+[ ]*(?::?-+:?)?[ ]*$/gm, "")
    .replace(/^[ ]*#{1,6}[ ]+/gm, "")
    .replace(/^[ ]*(?:>[ ]?)+/gm, "")
    .replace(/^[ ]*(?:[-*+\u2022\u00b7\u25aa\u25cf\u25e6\u2023\u2013\u2014]|\d{1,3}[.)])[ ]+/gm, "")
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>\n]*)?\/?>/g, " ")
    .replace(/\*+|~~|`+/g, "")
    .replace(/(?<![\p{L}\p{N}_])_+|_+(?![\p{L}\p{N}_])/gu, "")
    .replace(/\|/g, " ")
    .replace(/[\u00ab\u00bb\u201e\u201c\u201d\u201f\u2033]/gu, '"')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/gu, "'")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, "-")
    .replace(/\u2026/gu, "...")
    .replace(/ё/g, "е").replace(/Ё/g, "Е").replace(/\s+/gu, " ").trim();
}

export async function loadRuText(directory: string) {
  const tokenizer = new PreTrainedTokenizer(
    JSON.parse(await readFile(path.join(directory, "tokenizer.json"), "utf8")),
    JSON.parse(await readFile(path.join(directory, "tokenizer_config.json"), "utf8")),
  );
  const graph = await InferenceSession.create(path.join(directory, "model.onnx"), {
    executionProviders: ["cpu"], intraOpNumThreads: 1, interOpNumThreads: 1,
  });
  if (graph.inputNames.join(",") !== "input_ids,attention_mask" || graph.outputNames.join(",") !== "logits")
    throw new Error("RUSSIAN_MODEL_IO");
  function encode(text: string): bigint[] {
    const encoded = tokenizer(normalizeRuText(text), { add_special_tokens: false, truncation: false });
    return [BigInt(50281), ...Array.from(encoded.input_ids.data as BigInt64Array), BigInt(50282)];
  }
  return {
    countTokens: (text: string) => encode(text).length,
    async classify(text: string) {
      const ids = encode(text);
      const outputs = await graph.run({
        input_ids: new Tensor("int64", BigInt64Array.from(ids), [1, ids.length]),
        attention_mask: new Tensor("int64", BigInt64Array.from(ids, () => BigInt(1)), [1, ids.length]),
      });
      const logits = Array.from(outputs.logits.data as Float32Array);
      if (logits.length !== 2 || !logits.every(Number.isFinite)) throw new Error("RUSSIAN_MODEL_OUTPUT");
      const maximum = Math.max(...logits), exp = logits.map(x => Math.exp(x - maximum)), sum = exp[0] + exp[1];
      return exp.map((x, i) => ({ label: ["human", "ai"][i], score: x / sum }));
    },
  };
}
