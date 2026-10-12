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
- VPS build, activation and public Russian job verified on 2026-10-12; details
  below. Combined peak host load with CI and ClamAV remains untested.
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

## User quality target — 2026-10-12 12:42 MSK

The user requires 97–98% accuracy across parameters. Record this as the requested
quality target, not an achieved metric or a guarantee for arbitrary future inputs.
The 58 automated software tests establish implementation behavior, not detection
accuracy. The pinned Russian card reports 96.3% accuracy on its own held-out corpus
at a different decision threshold; Prizma has not independently reproduced that
result. No production threshold or displayed score is changed by this requirement.

The measurement programme must:

1. Establish a labeled, versioned evaluation set per module and language. Include
   different genres, human and generated samples, unseen generators, edited/mixed
   authorship, image recompression and realistic benign/malicious URL cases. Use
   verified provenance; mixed authorship and uncertain truth need explicit labels.
   Avoid duplicate authors/documents/source families across train, calibration and
   final test splits. Keep a later temporal and generator-held-out test. Preserve
   the final test for independent evaluation, not repeated threshold tuning.
2. Report confusion matrices, class-specific precision and recall, false positive
   and false negative rates, balanced and deployment-weighted accuracy with class
   prevalence. Break results down by language, modality, domain and generator.
   One pooled score cannot establish every module's or subgroup's quality.
3. Count every eligible request in the main denominator. Unknown, unavailable and
   abstained cases are unresolved, never correct by default. Also report accuracy
   among answered cases, coverage, class-specific abstention and operational
   failure rates separately. Raising abstention alone cannot satisfy the overall
   97–98% target. Define eligibility before seeing results, and publish exclusions.
4. Compare calibrated thresholds on a separate validation set; calibration makes
   scores interpretable but does not by itself improve classification accuracy.
   Evaluate alternatives, complementary ensembles and, where feasible under the
   no-extra-spending constraint, training on verified error cases. Adopt only
   measured improvements; agreement of correlated models is not independent proof.
5. For each claimed 97% or 98% quality level, report sample count and confidence
   intervals; the corresponding lower 95% confidence bound must meet the claimed
   level on the prespecified evaluation population. Use source-cluster-aware
   uncertainty where samples are correlated and account for multiple subgroup
   claims. Small groups remain unverified. Do not imply a bound on future drift.
6. Fact-checking needs claim extraction, dated primary sources, evidence comparison
   and review of contradictory/insufficient evidence. URL reputation and malware
   detection need current provider/engine validation. AI-origin scores alone cannot
   establish any of these properties. Test each subsystem and the final user outcome.
7. Rerun regression and drift checks after model, data, threshold or provider changes.
   Keep test data public/licensed or explicitly contributed; do not retain private
   user submissions for training as a side effect of quality monitoring.

Immediate next quality work is a measured baseline with independently labeled data.
An evaluation harness, dataset and calibrated model improvements are still pending;
this section records the requirement and proposed method, not their completion.


## VPS verification — 2026-10-12

User screenshots confirm image 0a7422d13074, MULTILINGUAL_BUILD_OK and MODELS_OK.
English, AI-image and Russian inference completed; the deepfake fixture returned
inconclusive, an accepted abstention rather than a runtime error. The isolated
smoke cgroup reported memoryPeakMiB=1099 under limit 1536. This is the smoke peak,
not a combined host-load benchmark. `manage start` recreated web and analyzer;
`manage health` returned web 200/status ok and analyzer 200/status ready with
models=true, site=true, clamav=false.

A live browser submission at https://185.68.22.22:8443/ selected Russian and sent
112 words / 874 characters of explicitly synthetic workshop prose. The UI moved
from queued to result ready and rendered the model's completed AI-class output.
The displayed 100.0% is an uncalibrated model score, NOT accuracy. The check proves
public integration only. ClamAV remains disabled. Other languages remain pending.

## Approved visual direction — 2026-10-12 13:02 MSK

The user approved a complete luxury website with desktop priority, rich visuals,
deep emerald/graphite, light accents, expressive typography and a dimensional
prism. Separate mobile-version work is deferred. The user may fund one year of a
custom domain; no purchase is authorized or needed for this interface change.

This is a bounded redesign of existing page and report flows: retain the link,
text/image and source-report behavior, live availability, privacy, uncertainty and
navigation restrictions. Use local vector geometry and CSS motion with reduced
motion support; no new backend, paid provider, remote font or runtime dependency.
Basic layout containment on narrow screens remains part of valid CSS. Validate
TypeScript/build, actual UI layout and existing functional contracts. The target
97–98% accuracy is not displayed as an achieved product claim.


### Interface implementation verification

The approved interface is implemented in the existing page, global styles and
media panel, with decorative artwork in components/prism-visual.tsx. Existing
request and worker contracts are unchanged. The media panel opens by default;
results explicitly label the uncalibrated model score. A skip link, visible focus
styles, persistent section anchors and reduced-motion-aware result scrolling are
included. No new dependencies or network assets were added.

Verification: 55 existing Node tests passed; web TypeScript, root TypeScript and
Vite production build passed. Independent code review found no remaining
Critical/Important issues after reduced-motion handling; its minor transient
anchor issue was corrected as well. Qodo CLI was absent from PATH and the
documented fallback, so no Qodo review result is claimed. No UI-specific tests
that mirror CSS implementation were added.

Cloud Browser rejected file:// local preview under its URL policy. No workaround
was attempted. Rendered layout/keyboard interaction of this new interface still
requires the ordinary HTTPS deployment on the VPS. Production activation remains
a separate user-executed step; a source commit alone does not deploy the UI.
