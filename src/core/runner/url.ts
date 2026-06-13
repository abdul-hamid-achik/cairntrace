/** True when `url` is path-like and needs a base URL before browser use. */
export function isRelativeUrl(url: string): boolean {
  const trimmed = url.trim();
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith("//");
}

/** Collapse repeated slashes outside the URL scheme separator. */
export function normalizeUrl(url: string): string {
  return url.replace(/([^:])\/{2,}/g, "$1/");
}

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.trim();
  return normalizeUrl(p.startsWith("/") ? `${b}${p}` : `${b}/${p}`);
}

export function resolveUrl(base: string, path: string): string {
  return normalizeUrl(new URL(path.trim(), base).toString());
}

export function hasRuntimeUrlPlaceholder(path: string): boolean {
  return /\$\{(?:requests|artifacts)\./.test(path);
}
