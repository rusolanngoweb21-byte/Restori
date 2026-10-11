/** Public deployments require TLS. HTTP is limited to explicitly enabled same-host peers. */
export function workerOrigin(value: string, options: { local?: boolean; selfHosted?: boolean } = {}) {
  const base = new URL(value);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash)
    throw new Error("WORKER_ORIGIN_REQUIRED");
  if (base.protocol === "https:") return base;
  if (base.protocol === "http:" && (
    (options.local && ["127.0.0.1", "localhost"].includes(base.hostname)) ||
    (options.selfHosted && base.origin === "http://web:8081")
  )) return base;
  throw new Error("HTTPS_REQUIRED");
}
