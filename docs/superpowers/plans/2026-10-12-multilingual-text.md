# Multilingual AI-text detection

User requirement: make Prizma's text-origin detection multilingual, including Russian,
on the existing 3.8 GiB VPS without a paid API, GPU or another server.

## Delivered scope

The first bundle has two language-specific detectors. A language is available only
when a live worker registers a loaded, hashed model for that language. The protocol's
larger language vocabulary is infrastructure for future models, not advertised coverage.

| Language | Pinned model | Runtime | Input window |
| --- | --- | --- | --- |
| English | onnx-community/tmr-ai-text-detector-ONNX, b9aa251e5bcda7e429fcc936767d921435945b60 | Existing Transformers.js q8 | 512 tokens |
| Russian | toiletsandpaper/russian-ai-text-detector-modernbert, 00141fe7ab18291ef0c4ab75bc00c0797e590a8b | Native ONNX Runtime FP32, fixed normalization, local tokenizer | 1024 tokens |

The Russian model is a classifier based on RuModernBERT-small, not a generative
chat LLM. Its model card reports Russian LLMTrace training and evaluation. The
author's metrics are not Prizma's measured accuracy. Other languages, edited or
translated AI text, mixed authorship and new generators require separate evaluation.
Source: https://huggingface.co/toiletsandpaper/russian-ai-text-detector-modernbert

No translation is performed before detection. The user selects the original
language; a conservative Cyrillic/Latin check catches an obvious RU/EN mismatch.
This is not a language identifier and cannot distinguish Russian from other
Cyrillic languages. Word counting uses Unicode language segmentation, including
languages without spaces. It does not decide AI origin.

## Implementation and limits

- Separate model directories prevent overwriting the English model with Russian.
- Pin revision, ONNX weights, tokenizer and Russian metadata with SHA-256. Load no
  remote Python code. Publish a complete manifest only after preparation succeeds.
- Port the pinned Russian normalization; do not use the English tokenizer/pipeline.
  `ru-modernbert-v1` is part of the model/cache identity and must change if the
  preprocessing or runtime semantics change.
- Do not truncate overlong texts. Return TEXT_TOO_LONG; retain the existing
  minimum of 80 words / 400 characters and maximum of 12,000 characters.
- Retain 0.3–0.7 abstention and explicitly uncalibrated AI-class scores. A score is
  neither an authorship proof nor a factual-truth score.
- Up to eight model capabilities and one signature capability can register.
  Unavailable/expired language capabilities cannot fall back to another language.
- One short-lived model process at a time. CPU inference remains one thread;
  process exit frees native allocations before the next model is loaded.
- Initial VPS extension downloads about 145 MB of Russian assets, reusing the
  installed packages and three existing models. Routine web rebuilds stay offline.

## Verification and release gates

- Baseline: 45 existing tests passed before changes.
- Red/green tests cover language routing, no fallback, worker registration,
  Unicode word counting, script mismatch, normalization, manifest collisions and
  refusal of a wrong-language job before a child is launched.
- Real pinned Russian model loads on the installed Transformers.js 3.8.1 / ORT
  1.21.0 stack. A short probe observed approximately 361 MiB process peak locally.
  This is not a VPS/cgroup measurement or a quality benchmark.
- Real English and Russian jobs completed through the HTTP API, SQLite queue and
  worker; results survived restart, raw inputs were deleted and foreign-session
  access was denied. A long Russian input returned TEXT_TOO_LONG.
- Independent review found no remaining Critical/Important issues. Final local
  suite: 55 Node tests plus 3 deployment control-flow tests passed; TypeScript,
  worker compilation and Vite build passed. The deployment tests use a Docker test
  double and do not validate a real image. All four real models passed local
  inference; Russian boundary tests cover excess tokens and formatting-only input.
- Remaining release gates: candidate Docker build and bounded offline model smoke
  on the VPS, activation, public Russian job and combined host memory observation.
  There is no Docker daemon or direct SSH in the assistant environment.

`manage build-multilingual` builds candidate model/app images and runs all four
models without network, with a 1536 MiB cap. Only after smoke succeeds are install
tags updated. Running containers are unchanged until `manage start`. Run during
idle CI and normal user load; inspect host memory before the additional smoke
container. No Nginx, certificate, secret, database or unrelated service changes.

## Fact checking is a separate feature

AI-written text can be true; human-written text can be false. No fact-checking
engine is implemented by this change. A future multilingual verifier must retrieve
dated source evidence, attribute each claim, distinguish independent sources from
copies, and return insufficient evidence when retrieval/comparison cannot support
a conclusion. Language support must be tested separately for retrieval and evidence
comparison. Model confidence alone must never become a FakeNews verdict. Paid
provider keys or additional hosting require a separate user decision.
