/**
 * snake_case step ids derived from what a step does (`click_save`,
 * `fill_website`, `open_profile`, `use_login`). Ids make runs, heal patches
 * and `fromSpec` setups point at a step by name instead of position.
 */

const MAX_ID_LENGTH = 40;

/** Step keys that are not the step kind. */
const NON_KIND_KEYS = new Set(["id", "when", "postcondition", "target"]);

/** The kind of a spec step (`open`, `click`, `use`, …). */
export function stepKindOf(step: Record<string, unknown>): string {
  return Object.keys(step).find((key) => !NON_KIND_KEYS.has(key)) ?? "step";
}

/** `${vars.websiteValue}` → `website_value`; other text kept. */
function placeholderWords(text: string): string {
  return text.replace(
    /\$\{(?:vars|env|secrets)\.([A-Za-z0-9_]+)[^}]*\}/g,
    (_m, name: string) => ` ${name} `,
  );
}

/** Lowercase snake_case words of free text (camelCase split, ASCII only). */
export function toSnake(text: string): string {
  return placeholderWords(text)
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function truncateWords(id: string): string {
  if (id.length <= MAX_ID_LENGTH) return id;
  const cut = id.slice(0, MAX_ID_LENGTH);
  const lastBreak = cut.lastIndexOf("_");
  return (lastBreak > 8 ? cut.slice(0, lastBreak) : cut).replace(/_+$/, "");
}

/** The last meaningful path segments of a URL-ish string. */
function pathWords(url: string): string {
  const bare = url
    .replace(/\$\{baseUrl\}/g, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "")
    .replace(/[?#].*$/, "");
  const segments = bare
    .split("/")
    .filter((segment) => segment && !isIdLike(segment));
  if (segments.length === 0) return "home";
  return segments.slice(-2).join(" ");
}

/** Database ids, UUIDs, numbers: not words. */
export function isIdLike(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      segment,
    ) ||
    /^[0-9a-f]{12,}$/i.test(segment) ||
    (/^[A-Za-z0-9_-]{16,}$/.test(segment) && /\d/.test(segment))
  );
}

function locatorWords(locator: unknown): string {
  if (typeof locator === "string") return locator;
  if (!locator || typeof locator !== "object") return "";
  const l = locator as Record<string, unknown>;
  // F15: `set: { field: country }` → set_country.
  for (const key of ["field", "name", "label", "text", "testid", "testId"]) {
    if (typeof l[key] === "string") return l[key] as string;
  }
  if (typeof l["selector"] === "string") {
    return (l["selector"] as string).replace(/[#.[\]=:"'>~+*()]/g, " ");
  }
  return "";
}

function waitWords(wait: unknown): string {
  if (!wait || typeof wait !== "object") return "";
  const w = wait as Record<string, unknown>;
  if (w["url"] && typeof w["url"] === "object") {
    const url = w["url"] as Record<string, unknown>;
    const pattern =
      typeof url["pattern"] === "string"
        ? // `/products/\d+/edit/?(?:[?#]|$)` → `/products/ /edit`
          url["pattern"].replace(
            /\[[^\]]*\](?:\{[\d,]*\})?|\\[a-zA-Z][+*]?|\(\?:[^)]*\)|[?^$+*]/g,
            " ",
          )
        : undefined;
    const value = url["includes"] ?? url["equals"] ?? pattern;
    return `url ${typeof value === "string" ? pathWords(value) : ""}`;
  }
  for (const key of ["text", "notText"]) {
    if (typeof w[key] === "string") return `${key} ${w[key] as string}`;
    if (w[key] && typeof w[key] === "object") {
      const inner = w[key] as Record<string, unknown>;
      const value = inner["contains"] ?? inner["equals"];
      if (typeof value === "string") return `${key} ${value}`;
    }
  }
  if (w["value"]) return `value ${locatorWords(w["value"])}`;
  if (typeof w["selector"] === "string") return locatorWords(w);
  if (typeof w["load"] === "string") return `load ${w["load"] as string}`;
  if (typeof w["ms"] === "number") return `${w["ms"] as number} ms`;
  return "";
}

/** The words describing what a step acts on. */
function stepWords(kind: string, step: Record<string, unknown>): string {
  const body = step[kind];
  switch (kind) {
    case "open": {
      const path =
        typeof body === "string"
          ? body
          : body && typeof body === "object"
            ? String((body as Record<string, unknown>)["path"] ?? "")
            : "";
      return pathWords(path);
    }
    case "use":
      return typeof body === "string"
        ? body
        : body && typeof body === "object"
          ? String((body as Record<string, unknown>)["action"] ?? "")
          : "";
    case "wait":
      return waitWords(body);
    case "press":
      return `${
        typeof body === "string" ? body : ""
      } ${locatorWords(step["target"])}`;
    case "request": {
      const r = (body ?? {}) as Record<string, unknown>;
      if (typeof r["assign"] === "string") return r["assign"];
      return `${
        typeof r["method"] === "string" ? r["method"] : "get"
      } ${pathWords(String(r["url"] ?? ""))}`;
    }
    case "eval": {
      const e = (body ?? {}) as Record<string, unknown>;
      if (typeof e["assign"] === "string") return e["assign"];
      if (typeof e["file"] === "string") {
        const file = (e["file"] as string).split("/").pop() ?? "";
        return file.replace(/\.[a-z]+$/i, "");
      }
      return "";
    }
    case "scroll": {
      const s = (body ?? {}) as Record<string, unknown>;
      if (s["to"]) return locatorWords(s["to"]);
      return typeof s["direction"] === "string" ? s["direction"] : "";
    }
    case "download": {
      const d = (body ?? {}) as Record<string, unknown>;
      return locatorWords(d);
    }
    case "form": {
      // F15: form_<first field> (the first key names the form's section).
      const f = (body ?? {}) as Record<string, unknown>;
      const fields = f["fields"];
      return fields && typeof fields === "object"
        ? (Object.keys(fields)[0] ?? "")
        : "";
    }
    case "snapshot":
    case "batch":
    case "monitor":
    case "transform":
    // F14 control flow: the block's kind is the id (`repeat`, `if`).
    case "repeat":
    case "if":
      return "";
    default:
      return locatorWords(body);
  }
}

/** A snake_case id for one step (not yet unique). */
export function stepIdFor(step: Record<string, unknown>): string {
  const kind = stepKindOf(step);
  const words = toSnake(stepWords(kind, step));
  const id = truncateWords(words ? `${toSnake(kind)}_${words}` : toSnake(kind));
  return /^[a-z]/.test(id) ? id : `step_${id}`;
}

/**
 * Give every step without an `id` a unique snake_case one (existing ids are
 * kept and reserved). `taken` carries ids already used elsewhere (setup
 * steps); it is updated in place. Returns new step objects and how many ids
 * were added.
 */
export function assignStepIds(
  steps: readonly Record<string, unknown>[],
  taken: Set<string> = new Set(),
): { steps: Record<string, unknown>[]; added: number } {
  for (const step of steps) {
    if (typeof step["id"] === "string") taken.add(step["id"]);
  }
  let added = 0;
  const out = steps.map((step) => {
    if (typeof step["id"] === "string") return step;
    const base = stepIdFor(step);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    added++;
    return { id, ...step };
  });
  return { steps: out, added };
}
