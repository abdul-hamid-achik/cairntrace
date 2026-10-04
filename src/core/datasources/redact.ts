/**
 * Connection-string hygiene for datasource evidence. Evidence names a
 * source by `{name, kind, transport, database, hosts}` — never by its URI —
 * and every transport error passes through scrubDatasourceText first.
 */

/** Hosts (`host[:port]`) of a mongodb:// or mongodb+srv:// URI. */
export function mongoUriHosts(uri: string): string[] {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?#]*)/i.exec(uri);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

/** Host names without ports, lowercased. */
export function hostNames(hosts: string[]): string[] {
  return hosts.map((host) => {
    const bracketed = /^\[([^\]]+)\]/.exec(host);
    if (bracketed?.[1]) return bracketed[1].toLowerCase();
    return host.replace(/:\d+$/, "").toLowerCase();
  });
}

/**
 * `mongodb://user:pass@h1:27017,h2/db?authSource=admin` →
 * `mongodb://***@h1:27017,h2/db` — credentials masked, query dropped.
 */
export function redactUri(uri: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(?:([^@/?#]*)@)?([^?#]*)/i.exec(uri);
  if (!match) return "[redacted uri]";
  const [, scheme, userinfo, rest] = match;
  return `${scheme}${userinfo ? "***@" : ""}${rest ?? ""}`;
}

/** A URL safe to show in evidence: userinfo masked, otherwise unchanged. */
export function displayUrl(url: string): string {
  const authority =
    url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
  return authority.includes("@") ? redactUri(url) : url;
}

const URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>;)]+/gi;

/**
 * Remove every literal secret and mask credentials in any URI-shaped text
 * (driver and mongosh errors echo the connection string they failed on).
 */
export function scrubDatasourceText(
  text: string,
  secrets: readonly string[] = [],
): string {
  // Mask URIs first (keeps hosts readable), then any literal secret left.
  let out = text
    .replace(URI_PATTERN, (uri) => {
      const authority =
        uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
      return authority.includes("@") || /^mongodb/i.test(uri)
        ? redactUri(uri)
        : uri;
    })
    .replace(
      /(authorization["']?\s*[:=]\s*["']?)(basic|bearer)\s+[^\s"',}]+/gi,
      "$1$2 [redacted]",
    );
  // A sorted copy without toSorted: this module is vendored into Playwright
  // exports, whose host tsconfig may stop at lib ES2022.
  const longestFirst = [...secrets];
  longestFirst.sort((a, b) => b.length - a.length);
  for (const secret of longestFirst) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
