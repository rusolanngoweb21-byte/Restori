import test from "node:test";
import assert from "node:assert/strict";

test("Russian model preprocessing reproduces the pinned training normalization", async () => {
  const modulePath = new URL("../services/analyzer/ru-text.ts", import.meta.url).href;
  const loaded = await import(modulePath).catch(() => null);
  assert.equal(typeof loaded?.normalizeRuText, "function", "Russian model preprocessing must exist");
  const input = '\ufeff# Заголовок\n> «Ёж» — **герой**…\n- [Подробнее](https://example.com)\n_слово_ слово_внутри ~~текст~~\n| A | B |\n| --- | --- |\n';
  assert.equal(loaded.normalizeRuText(input), 'Заголовок "Еж" - герой... Подробнее слово слово_внутри текст A B');
});
