/**
 * Bounds for datasource / value / http evidence in `outcomes/<id>.raw.json`:
 * at most 20 rows, at most 4KB per row, a `truncated` flag when anything was
 * cut. The artifact writer's redactor still runs over the result.
 */

export const MAX_EVIDENCE_ROWS = 20;
export const MAX_EVIDENCE_ROW_BYTES = 4096;

/** One value, cut to a JSON preview when its JSON is over `maxBytes`. */
export function boundValue(
  value: unknown,
  maxBytes = MAX_EVIDENCE_ROW_BYTES,
): { value: unknown; truncated: boolean } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { value: String(value).slice(0, maxBytes), truncated: true };
  }
  if (json === undefined) return { value: null, truncated: false };
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) return { value, truncated: false };
  return {
    value: {
      truncated: true,
      bytes,
      preview: Buffer.from(json, "utf8").subarray(0, maxBytes).toString("utf8"),
    },
    truncated: true,
  };
}

/** A row list bounded to 20 rows of ≤4KB each. */
export function boundRows(rows: readonly unknown[]): {
  rows: unknown[];
  total: number;
  truncated: boolean;
} {
  let truncated = rows.length > MAX_EVIDENCE_ROWS;
  const bounded = rows.slice(0, MAX_EVIDENCE_ROWS).map((row) => {
    const cut = boundValue(row);
    if (cut.truncated) truncated = true;
    return cut.value;
  });
  return { rows: bounded, total: rows.length, truncated };
}

const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key|x-auth-token)$/i;

/** Header map with credential headers masked (names kept). */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER.test(name) ? "[redacted]" : value;
  }
  return out;
}

/** A URL with userinfo masked and query values of secret-looking keys hidden. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/token|secret|password|passwd|key|signature|auth/i.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
