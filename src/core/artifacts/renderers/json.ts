/**
 * Canonical JSON renderer. 2-space indent, no trailing newline added unless needed.
 * Object key order is preserved from the source object (which is constructed in
 * the schema's documented order).
 */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
