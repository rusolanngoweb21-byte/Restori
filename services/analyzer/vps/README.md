# Existing VPS deployment

This profile reuses the already-built `prizma-analyzer:local` image on
`adaptivevpn-ci-01`. It does not buy hosting, publish a port, create a domain,
activate Railway or change the existing VPN/CI services. No image rebuild is
needed for these host-side helpers.

## Enrollment and startup

Run `services/analyzer/vps/manage prepare` from the host checkout. This first
validates the three bundled models and runs one synthetic inference per model
in a disposable container with networking disabled. The check is limited to
1536 MiB RAM, no swap, one CPU and 128 processes. It reports a container memory
peak where cgroup v2 provides one; it is not an accuracy or load benchmark.
Only a completed result or `AMBIGUOUS_SCORE` passes. A runtime model failure
must never produce `MODELS_OK`.

After the check passes, the helper creates a host key in `.private/enrollment.pem`
and prints `PUBLIC_KEY=...`. Only this public key is shared. Re-running prepare
keeps the same key. The private key is mode 0600 in a mode 0700 directory.

The Site operator generates a random 32-byte token encoded as lowercase hex,
stores it as the secret `WORKER_SERVICE_TOKEN` in the existing Site, and redeploys
its existing saved version so the new environment takes effect. The operator
uses `seal(token, publicKey)` from `setup.mjs` to produce an encrypted envelope.
The protocol uses ephemeral X25519, HKDF-SHA256 with both public keys as salt
and a fixed domain separator, and AES-256-GCM. The envelope contains no
plaintext token and can be pasted into a terminal. The destination Site URL
is pinned in the setup code; an envelope carries only the token.

Run `services/analyzer/vps/manage activate '<encrypted-envelope>'`. It decrypts
locally, writes `.private/worker.env` with mode 0600 and starts only this Compose
project's analyzer. Existing configuration is never overwritten. If activation
writes the environment but container startup fails, `manage start` retries
startup without replacing the secret. The public key and encrypted envelope
are not credentials; private keys, tokens and the decrypted environment must
never be committed or shared.

The `.private` directory is excluded from Git; the entire VPS helper directory
is excluded from the Docker build context. Enrollment runs with no network and
does not mount the Docker socket. `.private/worker.env` is consumed only by the
host Compose CLI and the worker runtime.

## Verification and current scope

Use `manage health` for structured readiness and `manage logs` for bounded logs.
`manage stop` stops only the Prizma analyzer. Limits and a maximum of three
automatic failure restarts prevent an unlimited restart loop. Logs rotate at
5 MB with two files. Running the short offline check does not establish the
combined requirements of a future antivirus daemon, VPN services and CI builds.

This is the models-only deployment stage: `REQUIRE_CLAMAV=0` means health readiness
requires models and Site connectivity, while the health JSON reports
`clamav:false`. No URL-signature capability is advertised without ClamAV.
Antivirus and reputation-provider checks still have to be configured and
verified before the URL navigation safety gate can clear links. Missing checks
continue to return hold; the safety gate is not bypassed by this deployment.

Local setup tests: `node --test tests/vps-setup.test.ts`.
