import test from "node:test";
import assert from "node:assert/strict";
import { capabilitySchema, mediaInputSchema, type Capability } from "../lib/contracts.ts";
import { validateMedia, enqueueMedia } from "../lib/media.ts";
import { createApi } from "../lib/api.ts";
import { testStore, textFixture } from "./helpers.ts";

const ru = "Вчера мы пришли в городской парк и увидели новую дорожку возле старого пруда. Соседи рассказали о планах благоустройства и предложили вместе обсудить будущую посадку деревьев. ".repeat(4);
const fr = "Hier nous avons visité le jardin municipal avec nos voisins. Nous avons parlé des arbres et des fleurs que les enfants souhaitent planter au printemps. ".repeat(5);
const zh = "昨天我们和邻居一起去了城市公园。大家讨论了春天种植树木的计划，也认真检查了湖边的小路。孩子们想在花园里种蔬菜，老人则建议先修理长椅。".repeat(9);
const cap = (language: string, digit: string) => ({ detector: "text-ai", version: digit.repeat(64), languages: [language] });

test("capabilities accept an explicit multilingual coverage list, not arbitrary locale strings", () => {
  assert.equal(capabilitySchema.safeParse({ ...cap("en", "a"), languages: ["ru", "en", "fr", "de", "zh", "ar"] }).success, true);
  assert.equal(mediaInputSchema.safeParse({ detector: "text-ai", language: "../../secret", text: fr }).success, false);
});

test("French and Chinese text validation counts words in the chosen language", () => {
  assert.equal(validateMedia({ detector: "text-ai", language: "fr", text: fr }).detector, "text-ai");
  assert.equal(validateMedia({ detector: "text-ai", language: "zh", text: zh }).detector, "text-ai");
});

test("choosing Russian cannot send an English paragraph to the Russian detector", () => {
  assert.throws(() => validateMedia({ detector: "text-ai", language: "ru", text: textFixture }), /неподходящий язык/);
  assert.equal(validateMedia({ detector: "text-ai", language: "ru", text: ru }).detector, "text-ai");
});

test("queue routes each language only to a live matching model and retains unsupported status", async () => {
  const { store } = testStore();
  const capabilities = [cap("en", "a"), cap("ru", "b"), cap("fr", "c")].map(c => capabilitySchema.parse(c));
  await store.heartbeat("worker", capabilities);
  for (const [language, text, version] of [["ru", ru, "b"], ["en", textFixture, "a"], ["fr", fr, "c"]]) {
    const job = await enqueueMedia(store, "owner", { detector: "text-ai", language, text });
    assert.equal(job.version, version.repeat(64));
  }
  await assert.rejects(enqueueMedia(store, "owner", { detector: "text-ai", language: "zh", text: zh }), /не подключена/);
});

test("private worker registration can advertise two text models, image models and antivirus together", async () => {
  const { store } = testStore();
  const capabilities = [cap("en", "a"), cap("ru", "b"),
    { detector: "image-ai", version: "c".repeat(64), languages: [] },
    { detector: "deepfake", version: "d".repeat(64), languages: [] },
    { detector: "url-signature", version: "e".repeat(64), languages: [] }];
  const token = "s".repeat(64);
  const api = createApi({ store, settings: { WORKER_SERVICE_TOKEN: token } });
  const response = await api.claim(new Request("https://prizma.test/api/internal/claim", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workerId: "multilingual", capabilities, claim: false }),
  }));
  assert.equal(response.status, 200, await response.text());
  assert.equal((await store.capabilities()).length, 5);
});

test("expired language capability cannot silently fall back to another language", async () => {
  let now = 1_000_000;
  const { store } = testStore(() => now);
  await store.heartbeat("russian", [capabilitySchema.parse(cap("ru", "b"))]);
  now += 46_000;
  await store.heartbeat("english", [capabilitySchema.parse(cap("en", "a"))]);
  await assert.rejects(enqueueMedia(store, "owner", { detector: "text-ai", language: "ru", text: ru }), /не подключена/);
});
