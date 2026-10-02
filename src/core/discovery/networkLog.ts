import type { NetworkEntry } from "../../adapters/browserBackend";
import type { SessionNetworkMutation } from "../schema/events.v1";

/**
 * Network visibility for discovery: what the app requested while an action
 * ran. Entries are projected to a small, credential-free shape before they
 * are journaled or returned — no headers, no request bodies, no query
 * strings (they carry tokens) — and the caller's redactor scrubs the rest.
 */

/** One journaled request (network/NNN.json). */
export interface DiscoveryNetworkEntry {
  /** Action that was running (or had just run) when it was observed. */
  action: number;
  method: string;
  /** URL without query string or fragment (redacted). */
  url: string;
  /** URL path only. */
  path: string;
  status?: number;
  resourceType?: string;
  durationMs?: number;
  timestamp?: number;
  /** Bytes of the request body when the backend saw one (body omitted). */
  postDataBytes?: number;
  /** Observed after the action returned (attributed on the next flush). */
  late?: true;
}

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Drop the query string and fragment. */
function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut >= 0 ? url.slice(0, cut) : url;
}

/** The path of a URL (no origin, query or fragment). */
export function urlPath(url: string): string {
  const bare = stripQuery(url);
  try {
    return new URL(bare).pathname || "/";
  } catch {
    return bare;
  }
}

/** Project a backend entry to the journaled shape. */
export function toDiscoveryEntry(
  entry: NetworkEntry,
  action: number,
  redactText: (text: string) => string,
  late = false,
): DiscoveryNetworkEntry {
  const url = redactText(stripQuery(String(entry.url ?? "")));
  const bodyBytes =
    typeof entry.postDataBytes === "number"
      ? entry.postDataBytes
      : typeof entry.postData === "string"
        ? Buffer.byteLength(entry.postData)
        : undefined;
  return {
    action,
    method: String(entry.method ?? "GET").toUpperCase(),
    url,
    path: urlPath(url),
    ...(typeof entry.status === "number" ? { status: entry.status } : {}),
    ...(typeof entry.resourceType === "string"
      ? { resourceType: entry.resourceType }
      : {}),
    ...(typeof entry.durationMs === "number"
      ? { durationMs: entry.durationMs }
      : {}),
    ...(typeof entry.timestamp === "number"
      ? { timestamp: entry.timestamp }
      : {}),
    ...(bodyBytes !== undefined ? { postDataBytes: bodyBytes } : {}),
    ...(late ? { late: true as const } : {}),
  };
}

/** Requests that change server state (anything but GET/HEAD/OPTIONS). */
export function mutationsOf(
  entries: readonly DiscoveryNetworkEntry[],
): SessionNetworkMutation[] {
  return entries
    .filter((entry) => !READ_ONLY_METHODS.has(entry.method))
    .map((entry) => ({
      method: entry.method,
      path: entry.path,
      ...(entry.status !== undefined ? { status: entry.status } : {}),
    }));
}

export interface NetworkQuery {
  /** Only entries of actions with an index >= this. */
  sinceAction?: number;
  method?: string;
  urlContains?: string;
  /** Newest entries kept (default 200). */
  limit?: number;
}

/** Filter journaled entries; newest `limit` kept, oldest first. */
export function queryNetwork(
  entries: readonly DiscoveryNetworkEntry[],
  query: NetworkQuery,
): { entries: DiscoveryNetworkEntry[]; total: number; truncated: boolean } {
  const method = query.method?.toUpperCase();
  const matched = entries.filter(
    (entry) =>
      (query.sinceAction === undefined || entry.action >= query.sinceAction) &&
      (method === undefined || entry.method === method) &&
      (query.urlContains === undefined ||
        entry.url.includes(query.urlContains)),
  );
  const limit = Math.max(1, query.limit ?? 200);
  return {
    entries: matched.slice(-limit),
    total: matched.length,
    truncated: matched.length > limit,
  };
}
