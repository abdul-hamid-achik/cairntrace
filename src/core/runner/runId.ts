import { randomBytes } from "node:crypto";

/**
 * Generate a run id of the form `<iso>_<name>_<6-hex>`.
 * Colons in the ISO timestamp are replaced with `-` so the id is safe to use
 * as a directory name on all filesystems.
 */
export function generateRunId(
  specName: string,
  now: Date = new Date(),
): string {
  const iso = now.toISOString().replace(/:/g, "-").replace(/\./g, "-");
  const rand = randomBytes(3).toString("hex");
  return `${iso}_${specName}_${rand}`;
}
