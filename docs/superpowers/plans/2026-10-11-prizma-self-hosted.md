# Prizma self-hosted deployment implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. The user has already authorized finishing the project on the existing paid VPS without new spending. User-facing terminal guidance must contain exactly one command at a time.

**Goal:** Run the existing Prizma interface, API, storage and analyzer on the existing VPS, independently of hosted Sites ingress.

**Architecture:** Keep the existing React interface and application rules. Add a Node HTTP entry point and durable SQLite transport adapters for the existing Store; keep the analyzer on a private local container network. Publish through the existing server's HTTPS stack only after checking listeners and routing. This replaces a hosting dependency; it must not relay requests to, spoof clients for, or otherwise route around the blocked managed Site.

**Tech stack:** Existing Node 24 image and dependencies, React/Vite static assets, node:sqlite, Docker Compose, existing reverse proxy, free ACME certificate.

**Spec:** The requirements and verified starting state below are the deployment specification for this change.

## Global constraints and verified starting state

- Target: adaptivevpn-ci-01, 185.68.22.22, Ubuntu 24.04, 4 GB plan / 3.8 GiB visible RAM, 2 CPU, 50 GB disk. No additional host or paid plan.
- Preserve the AdaptiveVPN CI runner, reverse proxy and Frankfurt VPN node. Do not stop, replace, or reconfigure unrelated services to free a port.
- Built analyzer image: prizma-analyzer:local. Three bundled models passed a real sequential VPS smoke test; observed peak 1085 MiB. This does not establish combined antivirus and CI capacity.
- Current GitHub main: fafd60080e47474b5e972781f4c6c7b78ccc5108. The user has pulled it into /opt/prizma.
- Current hosted source: /workspace/scratch/95c7e5bc44cf/prizma at d2bdccc6738c61eceb552db228f8e336c1006836. Preserve the hosted publication and audience during preparation.
- 2026-10-11 21:50 MSK: an authenticated one-shot probe using both worker auth and the existing documented Sites service credential returned HTTP 403, HTML, cloudflarePage:true, blocked:true, challenge:false. No exact WAF rule is available. Do not retry unchanged probes or rotate tokens as diagnosis.
- No new paid domain is required. Let's Encrypt supports IP-address certificates with Certbot >=5.4 for webroot; those certificates last six days and require automatic renewal plus reload. Issue only after inbound challenge routing is verified. A free provider hostname is another option, but availability and certificate eligibility have not been verified for this account.
- Keep existing session ownership, request limits, bounded uploads, job leasing, retention and permanent threat blocks. Missing reputation or antivirus checks must continue to hold navigation.
- WebRisk and URLhaus credentials are absent; ClamAV is not yet deployed. Do not advertise those features as available or substitute simulated clean results.
- Browser-facing HTTPS address will change for the independent deployment. Do not silently delete the old Site or existing data. Check/export permanent threat blocks before cutover; do not copy secrets into Git or publish private job payloads.

## Review focus

1. Restart during job completion: result, cache and permanent block commit atomically; raw input survives until safe deletion.
2. Forged proxy/Host headers: client identity and public origin come only from configured trusted ingress; cookies stay Secure and private.
3. Duplicate claims and expired leases: one worker owns a job, stale completion cannot publish or clear a block.
4. HTTPS renewal and occupied ports: preserve existing services; an unsuccessful certificate or configuration test must leave the previous listener active.
5. Missing services and resource pressure: fail closed, cap memory and uploads, and report unavailable models without fabricated results.

## Task 1: Durable local storage and HTTP service

**Files:** Add services/web/storage.ts, services/web/server.ts and tests/web-storage.test.ts, tests/web-http.test.ts. Copy the exact existing lib/api.ts, lib/store.ts, lib/media.ts, lib/threats.ts, lib/report.ts and drizzle schema into the backend repository as needed; do not fork application decision rules.

**Interfaces:** openStore(path, clock?) returns {store, close}. A SQLite adapter supplies the prepare/bind/first/all/run/batch methods used by Store. Store input payloads and upload timestamps in a dedicated SQLite table implementing the existing bucket's put/get/delete/list subset. createWebServer(options) accepts explicit publicOrigin, Store, application settings and trusted ingress configuration.

- [x] Add failing tests for disk restart, transaction rollback, lease race, result ownership, upload deletion and orphan cleanup.
- [x] Implement SQLite initialization in a transaction, WAL and bounded cache. Execute each batch synchronously as one database transaction; never await other work inside it.
- [x] Add HTTP tests for authenticated internal routes, no cross-session job access, forbidden cross-origin writes, body/time limits and forwarded-header spoofing.
- [x] Implement the HTTP adapter with a pinned public origin and narrow routes. Route internal endpoints only over the private worker network. Serve no arbitrary filesystem paths.
- [x] Run those tests and the existing security tests against the durable adapter. Verify an API restart retains a pending job and permanent block.

## Task 2: Existing interface and bounded deployment bundle

**Files:** Add services/web/index.html, client.tsx, vite.config.ts, Dockerfile, deployment Compose configuration and self-hosted operations documentation. Reuse existing components, app/page.tsx, app/globals.css and required public assets.

**Interfaces:** Build produces static dist-web assets consumed by the Node service. The web service and analyzer share an explicitly configured private Docker network and worker token. The web origin is separate from that internal address.

- [x] Build the existing interface with the standalone Vite entry point. Resolve only build/runtime compatibility issues; keep user-facing behavior and privacy copy accurate.
- [x] Add tests for private worker origin validation. If plain HTTP is used inside the same-host container network, allow only its exact configured service name and an explicit self-hosted flag; preserve HTTPS for all public traffic.
- [x] Define persistent storage, bounded container memory/CPU/logging and readiness probes. Keep API host exposure loopback-only until the reverse proxy is configured.
- [x] Verify static assets and real API calls locally, including a real model job with an actual bundled model when available. Fixtures must not be treated as a production capability registration.
- [x] Obtain an independent code review, fix blockers and publish the reviewed repository state for the VPS to pull.

## Task 3: Existing VPS integration and external verification

**Files:** Exact proxy/certificate configuration will be selected only after inspecting the existing listeners and server blocks; do not invent these paths or overwrite a default server.

- [x] Read occupied TCP listeners from the VPS: Nginx owns 80/443. Relevant Nginx configuration is the next external dependency; there is no direct SSH session in the assistant environment.
- [x] Inspect the relevant proxy configuration and select a conflict-free IP/port listener: existing Nginx on 80/443, free 8443, included conf.d, no real-IP rewrite directives, existing exact-IP certificate.
- [x] Verify external access on the selected port: the cloud browser and the user's iPhone both loaded https://185.68.22.22:8443/ on 2026-10-12. No firewall changes were needed.
- [x] Replace only the Prizma worker's failed polling loop, preserve its enrollment key and token securely, and deploy the reviewed web service and worker configuration. VPS reports web 200/ok and analyzer 200/ready, models true, site true.
- [x] Install and verify the separate 8443 proxy using the existing certificate. The installer confirmed trusted TLS, Host filtering and private-route denial. The existing snap.certbot.renew.timer is scheduled; on 2026-10-12 a successful `certbot reconfigure` staging renewal saved and exercised `nginx -t && nginx -s reload`. The webroot authenticator and shortlived profile are retained. This verifies the renewal setup and test, not a future scheduled production renewal.
- [ ] Verify public HTTPS, a real model job, another session's denied job lookup, survival across app restart, and truthful model availability.
- [ ] Measure actual combined memory before adding ClamAV. Configure low-memory database reload while preserving database integrity testing; stop on insufficient headroom instead of upgrading a paid plan.
- [ ] Configure reputation providers only through supported no-charge access available to the user; otherwise leave explicit unavailable/hold behavior and report the remaining requirement.
- [ ] Move the public entry point only after the new endpoint is verified. Preserve hosted data and audience until retention/migration is reconciled.

## Checks completed for this plan

- Existing API accepts injected Store/settings and imports Cloudflare runtime only as a type.
- Existing local security tests already use real node:sqlite, providing a verified starting point for the adapter rather than a new database architecture.
- The main interface is a React client component using relative API URLs; its inspected imports do not require hosted Sites identity.
- Native Sites tooling exposes audience, environment, deployment and logs, but no Cloudflare edge rule management. The production application error log queried after the blocked probe was empty.
- Official references: https://letsencrypt.org/2026/03/11/shorter-certs-certbot and https://timeweb.cloud/docs/domains/technical-domain . The latter explicitly restricts ordering SSL certificates for technical domains; do not promise provider-panel SSL for one.

**Status:** The standalone web service and analyzer are deployed. Public HTTPS is verified externally and on the user's iPhone; the separate proxy passes its TLS, Host and private-route checks. Certbot's scheduled renewal and tested Nginx reload hook are configured. A real English text job completed through the public UI on 2026-10-12; this demonstrates the processing path, not detector accuracy. Local restart/session-isolation tests passed previously; their live-VPS counterparts remain unverified. ClamAV, reputation credentials and a Russian text model remain unavailable. Hosted permanent threat_blocks were rechecked empty on 2026-10-12 MSK; existing hosted data/publication remain intact.

## DNS provider regression found during the public link check (2026-10-12)

- The public report for example.com returned 24/37 available signals: registration data was present, but all seven infrastructure signals were unknown.
- A paired request from the running VPS web container identified the cause: the shared Accept value `application/dns-json, application/rdap+json, application/json` returned HTTP 400; the exact `application/dns-json` value returned HTTP 200 with DNS records.
- The scanner now uses the exact DNS media type for the existing Cloudflare endpoint and retains RDAP/JSON media types for other providers. Endpoints, timeouts, body limits, cache rules and unknown-on-failure behavior are unchanged.
- The regression test failed before the fix (0/7 available infrastructure signals) and passed afterward. A second test verifies that a DNS HTTP failure stays unknown while RDAP data is retained.
- Deployed and verified on 2026-10-12: the user pulled 7c409f1, built image 9fd2411ec307 and started the containers. A public browser check of example.com at 11:20 MSK returned 31/37 available signals, including all 7/7 infrastructure signals, while the incomplete threat check continued to hold navigation.

## Antivirus capacity gate (2026-10-12)

- At 11:22 MSK the host reported 3.8 GiB total RAM, 844 MiB used, 3.0 GiB available, and no swap. At 11:25 MSK Docker reported analyzer 41.07 MiB / 1.5 GiB and web 48.95 MiB / 384 MiB, both below 1% CPU. These are idle observations, not simultaneous peak-load proof.
- The optional `manage antivirus-probe` runs real official database update/validation and clean/EICAR scans serially under a 1536 MiB cap, with host headroom/CI monitoring. It never connects to the worker or changes application capability registration. The cap is below the vendor's recommended capacity: an unsuccessful trial must stop, not trigger a paid upgrade or an unbounded run.
- Local tests cover headroom refusal, CI refusal, update failure, OOM classification, clean/detection result requirements, ownership-aware cleanup, and explicit non-production reporting. Docker is not available in the assistant environment; the actual image, signature download, memory peak and engine scan remain unverified until the VPS probe runs.
- A successful probe still requires a daemon/renewal design with nonconcurrent reload and retained database integrity testing, measured simultaneous model/host load, and a real public scan before advertising antivirus availability.
