import { env } from "cloudflare:workers";
import { Store } from "./store.ts";
export type Settings = {
  WEBRISK_API_KEY?: string;
  URLHAUS_AUTH_KEY?: string;
  WORKER_SERVICE_TOKEN?: string;
};
export function settings(): Settings {
  return env as unknown as Settings;
}
export function runtimeStore() {
  if (!env.DB || !env.BUCKET) throw new Error("STORAGE_UNAVAILABLE");
  return new Store(env.DB, env.BUCKET);
}
