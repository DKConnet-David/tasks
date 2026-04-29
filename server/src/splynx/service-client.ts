import { SplynxClient } from "./client.js";
import type { AppConfig } from "../config.js";

/**
 * The "service-account" Splynx client — uses the API key + secret to talk to
 * Splynx for task fetches and writebacks. There is one of these per process,
 * shared across all sessions, since with API-key auth Splynx has no concept
 * of per-user identity (we record the acting tech's identity ourselves and
 * tag Splynx comment text with their name when posting).
 *
 * Throws if the API key/secret is not configured — the caller decides
 * whether to surface a 503 or fail boot.
 */

let cached: SplynxClient | null = null;

export function getServiceSplynxClient(config: AppConfig): SplynxClient {
  if (cached) return cached;
  if (!config.SPLYNX_API_KEY || !config.SPLYNX_API_SECRET) {
    throw new Error(
      "Splynx not configured: set SPLYNX_API_KEY and SPLYNX_API_SECRET in env",
    );
  }
  cached = new SplynxClient({
    baseUrl: config.SPLYNX_BASE_URL,
    apiKey: config.SPLYNX_API_KEY,
    apiSecret: config.SPLYNX_API_SECRET,
  });
  return cached;
}

export function isSplynxConfigured(config: AppConfig): boolean {
  return Boolean(config.SPLYNX_API_KEY && config.SPLYNX_API_SECRET);
}
