import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function privateDirectory(directory) {
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700, recursive: true });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("DIRECTORY_INVALID");
  if ((info.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
}
export function configure(directory, origin, proxy) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password)
    throw new Error("PUBLIC_HTTPS_ORIGIN_REQUIRED");
  if (!isIP(proxy)) throw new Error("PROXY_IP_REQUIRED");
  privateDirectory(directory);
  const content = `PUBLIC_ORIGIN=${origin}\nTRUSTED_PROXY=${proxy}\n`, target = join(directory, "web.env");
  if (existsSync(target)) {
    if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw new Error("CONFIG_INVALID");
    if (readFileSync(target, "utf8") !== content) throw new Error("CONFIG_EXISTS");
    chmodSync(target, 0o600);
  } else writeFileSync(target, content, { flag: "wx", mode: 0o600 });
  const data = join(directory, "data");
  privateDirectory(data);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("ARGUMENTS_REQUIRED");
    const directory = join(dirname(fileURLToPath(import.meta.url)), ".private");
    configure(directory, process.argv[2], process.argv[3]);
    // Container setup runs as root with CHOWN; the application itself runs as uid 1000.
    chownSync(join(directory, "data"), 1000, 1000);
    console.log("WEB_CONFIGURED");
  } catch { console.error("WEB_SETUP_FAILED"); process.exitCode = 1; }
}
