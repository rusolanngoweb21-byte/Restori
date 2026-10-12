# Self-hosted Prizma on the existing VPS

This bundle serves the existing React interface and application API using Node 24 and durable SQLite. The analyzer uses `http://web:8081` inside the existing `prizma_default` Docker network. It never calls the managed Site. No additional paid service or domain is required by this bundle.

## Before activation

- This is a prepared deployment, not evidence that public HTTPS already works.
- Keep the existing Nginx and unrelated AdaptiveVPN services. Inspect their server blocks and firewall before choosing a public origin; ports 80/443 are already occupied.
- The public HTTP listener is published only at `127.0.0.1:18080`. Confirm that port is free. Port 8081 and analyzer health remain inside Docker.
- Reuse the existing `prizma-analyzer:local` image and `services/analyzer/vps/.private/worker.env`. The new image adds the website and updated worker without reinstalling packages or downloading models.
- Preserve the old Site. Check its permanent `threat_blocks` again immediately before cutover; any new rows need a private migration. Existing private sessions and jobs remain at the old origin for their retention period. Never publish old input payloads in this repository.
- Choose a real HTTPS origin before configuring; do not use a temporary HTTP origin. A free IP certificate may be obtained with ACME after the challenge route is ready. Existing proxy paths and listeners must be confirmed before writing a configuration.

## Operations

The executable `services/web/vps/manage` supports one operation at a time:

| Operation | Effect |
| --- | --- |
| `build` | Build `prizma-selfhost:local` from the existing local analyzer image; does not start services. |
| `build-multilingual` | Download the pinned Russian model into a candidate bundle, build the candidate app, run bounded offline inference, then promote image tags on success. Does not start services. |
| `model-smoke` | Run installed English, Russian and image models offline in a temporary container capped at 1536 MiB. |
| `configure <https-origin>` | Save the public origin and exact Docker gateway IP; create the private SQLite directory owned by uid 1000. Repeating the same configuration is safe; different existing settings are refused. |
| `start` | Start the web service, then replace only the Prizma analyzer container after database readiness. |
| `health` | Report database/API and real analyzer readiness. |
| `proxy-install` | Install the inspected server's separate HTTPS listener on port 8443; requires root and the host's existing Python 3, Nginx, OpenSSL and IP certificate. |
| `logs` | Show the last 30 service log lines. |
| `stop` | Stop only these two Prizma services, retaining data. |

The existing worker token is reused from its private environment file; never paste or print it. No new enrollment or rotation is needed. Recreating the Docker network changes the gateway: revalidate proxy trust before restarting.

### Russian and English text models

The multilingual extension retains the English TMR detector and adds the pinned
Russian RuModernBERT-small classifier. Other languages remain unavailable until
a model with that declared coverage is installed. These detect signs of AI origin;
they do not verify news facts. Detection scores are experimental and uncalibrated.

After pulling this change, use `build-multilingual` once, while CI is idle and the
host has room for an additional model process. About 145 MB of Russian assets are
downloaded; no packages, paid API or new VPS are needed. The existing
`prizma-analyzer:local` image must be present. A failed build or model smoke leaves
the installed image tags and running containers unchanged. A successful build
prints `MULTILINGUAL_BUILD_OK`; then use `start` and `health`, and verify a Russian
job through the public interface. Routine `build` automatically uses the installed
`prizma-models:multilingual` bundle and remains offline, so it retains Russian.

The Russian input window is capped at 1024 tokens; English retains 512. Excess
input is explicitly rejected instead of truncated. Models run serially in temporary
processes; adding a model does not keep all model weights resident in RAM. The
1536 MiB container limit is unchanged. The candidate smoke reports its cgroup peak;
local process measurements do not establish the VPS's combined memory headroom.

Nginx must forward the selected site's public traffic to the loopback listener, set `Host` to the exact configured public authority (including any non-default port), and replace `X-Real-IP` with its socket client address. Do not use a client-supplied forwarded header as the source. Disable caching for `/api/`, cap request bodies at 2,850,000 bytes, bound timeouts and disallow `/api/internal/` at the proxy as defense in depth. The public listener itself never routes worker endpoints. Verify `nginx -t` before a reload and keep existing configuration/certificates active if validation fails.

Only the Nginx configuration determines where public TLS terminates. Short-lived IP certificates require automatic renewal and a successful-configuration-only reload hook. Check the public certificate, renewal path, real model result and cross-session denial before announcing a new public address.

### Verified VPS listener

The target VPS has been inspected: `185.68.22.22`, existing Nginx sites on 80/443, `/etc/nginx/conf.d/*.conf` included, no real-IP rewrite directives, and an existing Let's Encrypt certificate with the exact IP SAN. The separate origin is `https://185.68.22.22:8443`. This deployment helper is deliberately pinned to that inspected host; it is not a general-purpose proxy installer.

`proxy-install` first verifies the configured public origin, existing Nginx configuration, free port, certificate lifetime and loopback API including the Docker gateway trust. It writes only `/etc/nginx/conf.d/prizma-8443.conf` using exclusive atomic creation. It refuses an unexpected existing file or symlink. After `nginx -t`, it requests a graceful reload, then verifies HTTPS locally with the system CA store and exact public IP, the page/API, Host rejection and the inaccessible worker API. Failure removes only the file created by this invocation and reloads the previous configuration when necessary. The existing 80/443 server files, firewall, certificates and application data are not changed. An identical existing file is checked without replacing it.

Success reports `HTTPS_LOCAL_OK`; it does **not** establish access through the provider firewall, successful certificate renewal, or a real model job over the external connection. Those are still deployment gates. If a failed first installation leaves `ROLLBACK_RELOAD_FAILED` or `ROLLBACK_REFUSED_CONFIG_CHANGED`, inspect Nginx before proceeding.

SSH hangup, termination and interrupt signals are recorded and handled at transaction boundaries, so publication is completed atomically and rollback can finish. Forced termination (`SIGKILL`), power loss and concurrent administrative edits still require inspection; no script can roll back while its process or host is stopped.

The helper and template live outside the container image. Pulling these files is enough; no container rebuild is required. Local rollback/preservation tests use `python3 tests/web-proxy.test.py`. The actual Nginx syntax and trusted TLS probe are checked on the VPS during installation, because the local development environment has no Nginx or Docker daemon.

## Data and resources

`services/web/vps/.private/data/prizma.sqlite` and its WAL contain private inputs and results. They are outside the image and retained on container replacement. Directory mode is 0700, database mode 0600. SQLite uses WAL, FULL synchronization and an 8 MiB page cache. Existing application retention and upload cleanup run every minute. Completed raw inputs are logically deleted; filesystem/WAL backups are still sensitive.

Back up SQLite through its online backup API, or stop **only Prizma** and copy the entire private data directory including any WAL files. Do not copy just a live database file. Store backups with the same access restrictions; test restoration before removing the original. Do not remove the data directory to fix a service startup.

Web memory is capped at 384 MiB; analyzer at 1536 MiB, processing models sequentially. Both have bounded CPU, process counts, temporary storage and log rotation. These are ceilings, not measured combined consumption. Measure actual host headroom with CI active before adding antivirus.

ClamAV, WebRisk and URLhaus are not configured by this bundle. Missing checks continue to show unavailable and hold navigation. Do not advertise a full malware check or simulate a clean response. Model confidence is the existing uncalibrated score, not measured accuracy.

### Optional antivirus capacity probe

`manage antivirus-probe` performs a one-shot test; it does **not** enable ClamAV in
the application. Run it when CI is idle. It requires root, Docker, cgroup v2 peak
accounting, at least 2304 MiB MemAvailable and 2 GiB free on Docker's filesystem.
ClamAV officially recommends 3 GiB or more; this 1536 MiB capped trial is an
experiment for this constrained host, not a claim that the recommended capacity
has been met. A memory-limit failure means stop and reconsider deployment.

The probe pulls official `clamav/clamav:1.4.6`, resolves the image ID, and creates
the labeled `prizma_clamav_probe_db` volume, retaining signature downloads for
reuse. A foreign volume with that name is rejected. FreshClam updates and tests
the database (`TestDatabases yes`) before a separate offline ClamScan process
checks a benign fixture and the harmless EICAR test string. These run serially,
each capped at 1536 MiB, no swap and 0.5 CPU. No port or app configuration is
changed; no host files are scanned. The scan mounts the database read-only.

The host monitor stops the probe if available memory falls below 768 MiB, an
AdaptiveVPN Runner.Worker starts, a deadline expires or the terminal disconnects.
Docker's hard memory limit applies independently of this sampled monitor; the
monitor cannot guarantee protection from an instantaneous unrelated host spike.
Only containers labeled with this invocation's random token are removed.
Image and database volume remain for reuse; test fixtures are removed.

`CLAM_PROBE_OK` reports the update and scan peaks. It is not validation of clamd,
simultaneous model/CI load, automatic database renewal or the public workflow.
Those gates must pass before enabling `CLAM_HOST` in the analyzer. Failure leaves
the current unavailable/hold behavior intact. A rejected database download must
be diagnosed from its output; do not loop retries or change network routes.

## Local validation

`PRIZMA_TEST_STORAGE=disk node --test tests/*.test.ts` exercises the existing security suite against the actual disk adapter as well as new HTTP, storage and origin tests. `node services/analyzer/build.ts` compiles the worker. `node node_modules/vite/bin/vite.js build --config services/web/vite.config.ts` builds the UI. `node node_modules/typescript/bin/tsc -p services/web/tsconfig.json --noEmit` checks the standalone source.
