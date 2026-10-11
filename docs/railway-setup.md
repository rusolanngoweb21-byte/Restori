# Railway connection status — 2026-10-11

## Budget decision after user clarification

The user explicitly requires no new hosting or domain expense. The Railway
activation sequence below is historical, not the next action. Do not upgrade the
plan or apply the staged source connection. Both services are offline; Railway
reported zero project volumes and buckets. This is a resource inventory, not a
statement about the user's entire Railway account bill.

The existing Petersburg host has 4 GB RAM (3.2 GiB available in the supplied
terminal screenshot), 2 CPU cores and 24.5 GB free disk. It also hosts VPN-project
CI and an HTTPS proxy, so their resource needs must be preserved. No SSH access
is available in this session. The user is running individual setup commands in
Termius; the last screenshot confirms Docker CLI exists but Compose is missing.

The analyzer has been changed to use one short-lived model process per job, with
sequential startup validation, a 60-second combined loading/inference deadline
and process-exit cleanup. Host memory measurements and real ClamAV testing remain
required before claiming this fits the 4 GB host. Missing reputation-provider keys
still keep the protected navigation closed.

Validation of the process-per-job change: 25 tests, scanner checks, TypeScript
and analyzer compilation pass. The Site production build passes. The local queue
E2E ran all three checksum-pinned CPU models: text and AI-image completed, portrait
deepfake correctly returned an inconclusive score for the synthetic image. The E2E
also passed session ownership, caching and sticky denial. Antivirus and reputation
in that E2E are fixtures, not evidence of live ClamAV or provider readiness. An
independent review found no critical/important issue; additional lifecycle tests
cover startup timeout, startup failure, shutdown and recovery after a model failure.
The host-level aggregate RAM requirement remains unmeasured. Docker is unavailable
in this development runtime, so the container build must still be checked on the host.

## Current verified state

The public Site responds successfully. A live request to `/api/capabilities`
returned no active worker capabilities and both reputation providers unconfigured.
The live `/api/analyze` produced a DNS/RDAP report for `https://example.com/`,
with `threat.status=hold` and `navigationAllowed=false` as required.

Railway reports both existing services offline with no active deployments.
The analyzer source `rusolanngoweb21-byte/Restori`, branch `main`, is now staged
in production (patch `5060b06d-3a83-454a-9a1c-112df405b89e`). It is not applied
and no build was started. The backend source was compared against the Site
source before preparing the update; all retained analyzer inputs matched.

An attempt to set the existing ClamAV service to 4 GB was rejected by Railway:
`The maximum allowed memory for this service is 1 GB`. No subscription or
billing change was made. The ClamAV capacity prerequisite remains unresolved.
`WEBRISK_API_KEY` and `URLHAUS_AUTH_KEY` remain absent from Site configuration;
the worker authentication secret is configured in Site settings (its value was
not retrieved). The old live internal endpoint still returned HTTP 503
`WORKER_UNCONFIGURED`, showing that saved configuration had not reached that
publication. The updated Site publication applies current runtime settings.
Live probes also confirmed `/api/out` denies with HTTP 409 and `/api/media`
returns HTTP 503 `MODEL_UNAVAILABLE` instead of a fabricated result.

The corrected analyzer source is saved on GitHub `Restori/main` at commit
`77d31ed43f1cd66e2fbdf16afce4329c9cda5348`. Its default test command runs the
backend tests available in that repository; the Site runs the full test suite.

The ClamAV adapter now refuses EOF without the NUL protocol terminator. The
previous code accepted a truncated `stream: OK` or version reply. Both cases
were reproduced with failing tests before the fix. All 18 unit/security tests,
scanner checks, TypeScript validation, analyzer compilation and Site production
build pass. An independent review found no critical or important issues. The Docker
build now runs the analyzer readiness and protocol tests before model download.
Real clamd, cloud model inference and browser interaction remain unverified.
Qodo review was unavailable because its CLI is not installed in this environment.
The container image build itself was not run: Docker is unavailable here.

Historical Railway activation steps (superseded by the budget decision above):

1. Make sufficient memory available in the Railway workspace (4 GB per service
   is the prepared initial capacity; actual usage still needs measurement).
2. Apply service limits and persistent ClamAV storage, then activate the ClamAV
   image and the staged analyzer source. Observe terminal deployment success
   and actual scanner readiness, not only a container status.
3. Configure provider-issued Web Risk and URLhaus secrets on the Site and apply
   the runtime configuration.
4. Verify production heartbeat, one text and one image job, result privacy,
   harmless antivirus test, incomplete-check denial and worker-stop behavior.

The project is not production-complete while these prerequisites are unmet.

## Historical preparation — 2026-09-19

The existing public Site is `https://prizma-link-check.rusolanngoweb21.chatgpt.site`.
Site project: `appgprj_6aac14aeb18881918767485e3287a740`.

## Provisioned resources

- Railway project `Prizma`: `8e96273a-3c5f-4f88-bdc6-9ad2a1203ea9`.
- Production environment: `e6130526-4897-4a6a-ab20-623c60fa205a`.
- Node service `prizma-analyzer`: `1cc49599-e8a7-4c64-94b1-6cd730f486bb`.
- Antivirus service `clamav`: `2509db22-a0a9-452a-a144-986b99da9e34`.
- Public deployment-source repository: `rusolanngoweb21-byte/Restori`, branch `main`.
  Only analyzer build inputs were transferred; models are fetched during Docker build.

The same generated `WORKER_SERVICE_TOKEN` is saved in Railway and the Site's secret configuration.
No secret value is included here. The analyzer also has `PRIZMA_SITE_URL`, `MODEL_MANIFEST`,
`CLAM_HOST` as a Railway private-domain reference, `PORT=8080`, `REQUIRE_CLAMAV=1`, and
`NODE_ENV=production`. Replica identity uses the container hostname.

Analyzer settings: `services/analyzer/Dockerfile`, repository-root context,
`node dist-worker/services/analyzer/worker.js`, `/healthz`, healthcheck timeout 300 seconds,
sleeping disabled, no cron, restart on failure with ten retries. The Docker build bundles
all three checksum-pinned models. The health endpoint requires loaded models, recent successful
Site communication and fresh ClamAV availability. Model failure removes its heartbeat capability.

## Original live-deployment blockers

At the September checkpoint the repository was not attached to the analyzer.
The current connector supports attachment; the source change is now staged as
recorded above. Do not create duplicate projects or services when resuming.

The attempted ClamAV deployment `26833681-00d1-4557-8551-ade328c55c97` downloaded current
signatures but never opened its clamd socket and ultimately reported `CRASHED` / `Failed to start clamd`.
Observed memory limit: approximately 1 GB. This is below ClamAV's documented 3 GiB minimum and
4 GiB recommendation. Increase the allowed capacity before redeploying; the container's early
`SUCCESS` status was not scanner readiness. A billing/plan change may be necessary.

`WEBRISK_API_KEY` and `URLHAUS_AUTH_KEY` are absent from Site settings. Their adapters already
exist. Enter provider-issued keys as Site secrets, apply runtime configuration, then test real
provider responses. Missing providers intentionally keep link navigation blocked.

Recommended initial capacity is 4 GB per service, subject to actual measurement. Neither service
needs a public domain. Keep ClamAV TCP 3310 private. Persist antivirus updates with a volume at
`/var/lib/clamav` when the account permits it. Do not bypass model checksums or reduce antivirus
coverage to fit the trial memory limit.

## Verification performed in this session

- Analyzer TypeScript compilation and Site production build passed.
- Existing 14 security tests and scanner checks passed.
- New HTTP readiness test passed for missing models, missing Site, missing ClamAV and shutdown.
- Real CPU E2E passed after restoring incomplete scratch model downloads and quarantining
  stale download temporary files: image, portrait and English-text models executed; queue,
  result privacy, caching and sticky denial passed. Antivirus and reputation in this local
  E2E remain fixtures; live ClamAV/provider verification has not passed.

After fixing the blockers, check live `/api/capabilities`, submit one text and one image through
the production queue, verify a harmless antivirus test and source failure behavior, and confirm
that unavailable/stopped workers no longer advertise readiness. Do not claim the integration is
complete until these checks succeed.

References: [ClamAV Docker requirements](https://docs.clamav.net/manual/Installing/Docker.html),
[Railway plans](https://docs.railway.com/pricing/plans),
[Web Risk Lookup](https://docs.cloud.google.com/web-risk/docs/lookup-api),
[URLhaus API](https://urlhaus.abuse.ch/api/).
