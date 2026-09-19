# Prizma analyzer

Persistent Node.js 24 worker for the Prizma Site. It polls the authenticated Site queue over HTTPS; it does not need a public domain. ClamAV must remain on Railway private networking.

## Railway service

- Dockerfile: `services/analyzer/Dockerfile`, build context: repository root.
- Start: `node dist-worker/services/analyzer/worker.js`.
- Healthcheck: `/healthz`, timeout: 300 seconds.
- Disable sleeping and cron schedules. Configure restart on failure.
- Allocate 4 GB RAM to ClamAV; use 4 GB as initial analyzer capacity and measure actual usage. The 1 GB trial limit is insufficient for this setup.
- The Docker build downloads checksum-pinned models to `/opt/prizma/models`. Runtime model loading is offline and verifies every file.

| Variable | Value |
| --- | --- |
| `PRIZMA_SITE_URL` | `https://prizma-link-check.rusolanngoweb21.chatgpt.site` |
| `MODEL_MANIFEST` | `/opt/prizma/models/manifest.json` |
| `CLAM_HOST` | Reference the private domain of the ClamAV service |
| `WORKER_SERVICE_TOKEN` | Same random secret as the Site, at least 32 characters |
| `PORT` | `8080` |
| `REQUIRE_CLAMAV` | `1` |

Leave `WORKER_ID` unset so each replica uses its hostname. Do not store actual secrets in Git.

The Site also needs the server-side secrets `WEBRISK_API_KEY` and `URLHAUS_AUTH_KEY`. They are not required on the analyzer. Missing or failed reputation checks keep navigation blocked.

## ClamAV

Image: `clamav/clamav:1.4.6`. Do not expose port 3310 publicly. Freshclam updates signature databases. For long-term operation, attach a persistent volume at `/var/lib/clamav` to retain updates across deployments.

A running container alone does not prove that clamd is ready. Check the actual scanner response, current signature timestamp, and `/healthz` on the analyzer. Deployment is complete only after Site capabilities and end-to-end processing succeed.

## Scope

Models cover AI images, portrait deepfakes, and English AI text. Scores are uncalibrated model outputs, not proof. Russian-text detection is not supported by these models. ClamAV scans a bounded HTTP response, not all behavior of an entire website.
