import { createHash } from "node:crypto";
import type { Spec } from "./schema/spec.v1";

/**
 * Compute the contract hash for a spec (sha256 over canonical-JSON of
 * intent + outcomes). Plan §10/§13d.
 *
 * The hash is stamped at `cairn spec scaffold` time and re-verified by
 * `cairn run` and `cairn spec heal`. Any mismatch is exit code 6.
 */
export function computeContractHash(
  spec: Pick<Spec, "intent" | "outcomes">,
): string {
  const canonical = canonicalJson({
    intent: spec.intent,
    outcomes: spec.outcomes,
  });
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hex}`;
}

/**
 * Stable JSON serialization with sorted object keys. Ensures the hash is
 * insensitive to YAML/JSON key ordering — the only thing that affects it
 * is the *content* of intent and outcomes.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}
