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
| `configure <https-origin>` | Save the public origin and exact Docker gateway IP; create the private SQLite directory owned by uid 1000. Repeating the same configuration is safe; different existing settings are refused. |
| `start` | Start the web service, then replace only the Prizma analyzer container after database readiness. |
| `health` | Report database/API and real analyzer readiness. |
| `logs` | Show the last 30 service log lines. |
| `stop` | Stop only these two Prizma services, retaining data. |

The existing worker token is reused from its private environment file; never paste or print it. No new enrollment or rotation is needed. Recreating the Docker network changes the gateway: revalidate proxy trust before restarting.

Nginx must forward the selected site's public traffic to the loopback listener, set `Host` to the exact configured public authority (including any non-default port), and replace `X-Real-IP` with its socket client address. Do not use a client-supplied forwarded header as the source. Disable caching for `/api/`, cap request bodies at 2,850,000 bytes, bound timeouts and disallow `/api/internal/` at the proxy as defense in depth. The public listener itself never routes worker endpoints. Verify `nginx -t` before a reload and keep existing configuration/certificates active if validation fails.

Only the Nginx configuration determines where public TLS terminates. Short-lived IP certificates require automatic renewal and a successful-configuration-only reload hook. Check the public certificate, renewal path, real model result and cross-session denial before announcing a new public address.

## Data and resources

`services/web/vps/.private/data/prizma.sqlite` and its WAL contain private inputs and results. They are outside the image and retained on container replacement. Directory mode is 0700, database mode 0600. SQLite uses WAL, FULL synchronization and an 8 MiB page cache. Existing application retention and upload cleanup run every minute. Completed raw inputs are logically deleted; filesystem/WAL backups are still sensitive.

Back up SQLite through its online backup API, or stop **only Prizma** and copy the entire private data directory including any WAL files. Do not copy just a live database file. Store backups with the same access restrictions; test restoration before removing the original. Do not remove the data directory to fix a service startup.

Web memory is capped at 384 MiB; analyzer at 1536 MiB, processing models sequentially. Both have bounded CPU, process counts, temporary storage and log rotation. These are ceilings, not measured combined consumption. Measure actual host headroom with CI active before adding antivirus.

ClamAV, WebRisk and URLhaus are not configured by this bundle. Missing checks continue to show unavailable and hold navigation. Do not advertise a full malware check or simulate a clean response. Model confidence is the existing uncalibrated score, not measured accuracy.

## Local validation

`PRIZMA_TEST_STORAGE=disk node --test tests/*.test.ts` exercises the existing security suite against the actual disk adapter as well as new HTTP, storage and origin tests. `node services/analyzer/build.ts` compiles the worker. `node node_modules/vite/bin/vite.js build --config services/web/vite.config.ts` builds the UI. `node node_modules/typescript/bin/tsc -p services/web/tsconfig.json --noEmit` checks the standalone source.
