import { z } from "zod";

/**
 * Static reading of an SDK verifier's fixtures contract:
 *
 *   export default defineVerifier({
 *     description: "…",
 *     fixtures: z.object({ orderId: z.string().describe("…"), retries: z.number().default(3) }),
 *     run(ctx) { … },
 *   });
 *
 * Nothing is imported or executed: the source is scanned as text. A schema
 * built from an inline `z.object({ … })` (optionally through one `const`
 * binding, `.extend({ … })`, `.partial()`, `.pick`/`.omit`, `.strict()` /
 * `.passthrough()`, `.and(z.object({ … }))`) is read completely; anything
 * else (a schema imported from another module, a spread, `.merge(imported)`,
 * `.or(…)`) is reported `dynamic` with the keys that could be read. A key
 * whose own schema cannot be read (imported, or built by a helper call) is
 * listed without `required`: nothing is claimed about it. `cairn verifier
 * schema --load` imports the module in a child process to read such
 * contracts.
 */

export const SdkFixtureKeySchema = z
  .object({
    name: z.string().min(1),
    /** `string`, `number`, `boolean`, `date`, `string[]`, `enum`, `object`, `a | b`, `unknown`, … */
    type: z.string(),
    /**
     * False when the key is optional or has a default. Absent when the key's
     * schema cannot be read statically (imported, or built by a helper).
     */
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    description: z.string().optional(),
    /** Allowed values of an enum or literal. */
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();
export type SdkFixtureKey = z.infer<typeof SdkFixtureKeySchema>;

/**
 * `cairn verifier schema <file> --format json` (urn:cairntrace.dev:verifier-schema:v1).
 * Additive: new optional fields only.
 */
export const VerifierSchemaReportSchema = z
  .object({
    /** The file as given (relative paths stay relative to the cwd). */
    file: z.string().min(1),
    exists: z.boolean(),
    /** The file calls defineVerifier() from the verifier SDK. */
    sdk: z.boolean(),
    /**
     * `static`: the SDK contract was read without running anything;
     * `dynamic`: an SDK verifier whose contract is not fully readable
     * statically (keys lists what was found; use --load); `loaded`: read by
     * importing the module (--load); `legacy`: a plain verify(ctx) script,
     * contract from its header comment / exported object / usage; `none`:
     * the file could not be read.
     */
    mode: z.enum(["static", "dynamic", "loaded", "legacy", "none"]),
    description: z.string().optional(),
    fixtures: z
      .object({
        source: z.enum(["sdk", "header", "export", "usage", "none"]),
        /** Unknown fixture keys are rejected (SDK contracts). */
        strict: z.boolean().optional(),
        /** Keys may be incomplete: unknown keys cannot be flagged. */
        dynamic: z.boolean().optional(),
        keys: z.array(
          z
            .object({
              name: z.string().min(1),
              type: z.string().optional(),
              required: z.boolean().optional(),
              default: z.unknown().optional(),
              description: z.string().optional(),
              values: z
                .array(z.union([z.string(), z.number(), z.boolean()]))
                .optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    /** Why the contract is partial or where it came from. */
    reason: z.string().optional(),
    /** Read or --load failure. */
    error: z.string().optional(),
  })
  .strict();
export type VerifierSchemaReport = z.infer<typeof VerifierSchemaReportSchema>;

export interface SdkContract {
  /**
   * `static`: every key name is known (a key whose own schema cannot be read
   * has no `required`); `dynamic`: keys could not all be listed.
   */
  mode: "static" | "dynamic";
  description?: string;
  /** Unknown fixture keys fail at runtime (the SDK default; `.passthrough()` turns it off). */
  strict: boolean;
  keys: SdkFixtureKey[];
  reason?: string;
}

/** The SDK contract of a verifier source, or undefined when it does not call defineVerifier. */
export function sdkContractFromSource(source: string): SdkContract | undefined {
  const scan = new Scan(source.replace(/^\uFEFF/, ""));
  const call = scan.findCall("defineVerifier");
  if (call === undefined) return undefined;
  if (ZOD_V4_IMPORT.test(scan.text)) {
    // defineVerifier() refuses zod v4 schemas at load time.
    return {
      mode: "dynamic",
      strict: false,
      keys: [],
      reason:
        "the file imports zod v4 (zod/v4, zod/mini); the SDK takes the z it re-exports from @thelacanians/cairntrace/verifier",
    };
  }
  const reader = new ContractReader(scan);
  const arg = scan.skipSpace(call.open + 1);
  if (scan.text[arg] !== "{") {
    return {
      mode: "dynamic",
      strict: false,
      keys: [],
      reason: "defineVerifier() is not called with an inline object literal",
    };
  }
  const entries = scan.objectEntries(arg);
  const description = entries.find((e) => e.key === "description");
  const descriptionText = description
    ? scan.stringLiteral(description.value)
    : undefined;
  const fixtures = entries.find((e) => e.key === "fixtures");
  const described = descriptionText ? { description: descriptionText } : {};
  if (!fixtures) {
    // No schema: fixtures are handed over unvalidated.
    return {
      mode: "static",
      ...described,
      strict: false,
      keys: [],
      reason: "no fixtures schema: fixtures are passed through unvalidated",
    };
  }
  const range = fixtures.shorthand
    ? reader.resolveIdentifier("fixtures")
    : fixtures.value;
  const object = range ? reader.readObject(range, 0) : undefined;
  if (!object) {
    return {
      mode: "dynamic",
      ...described,
      strict: false,
      keys: [],
      reason:
        "the fixtures schema is not an inline z.object() (use --load to import it)",
    };
  }
  return {
    mode: object.dynamic ? "dynamic" : "static",
    ...described,
    strict: object.strict,
    keys: object.keys,
    ...(object.reason ? { reason: object.reason } : {}),
  };
}

/* ------------------------------------------------------------------ */

interface Range {
  start: number;
  end: number;
}

interface Entry {
  key: string;
  value: Range;
  shorthand?: boolean;
}

interface ObjectInfo {
  keys: SdkFixtureKey[];
  strict: boolean;
  dynamic: boolean;
  reason?: string;
}

/** `import … from "zod/v4"` (or zod/mini): schemas the SDK does not parse. */
const ZOD_V4_IMPORT =
  /\bfrom\s*["']zod\/(?:v4|mini|v4-mini)(?:\/[^"']*)?["']|\bimport\(\s*["']zod\/(?:v4|mini)/;

/**
 * Chain methods on the fixtures object that keep its keys and strictness
 * (the SDK peels these wrappers at runtime). Anything not listed here or
 * handled in readObject makes the contract dynamic.
 */
const TRANSPARENT_OBJECT_METHODS = new Set([
  "describe",
  "refine",
  "superRefine",
  "transform",
  "pipe",
  "brand",
  "readonly",
  "default",
  "optional",
  "nullable",
  "nullish",
  "catch",
]);

interface Link {
  name: string;
  args?: Range[];
}

interface TypeInfo {
  type: string;
  /** Accepts a missing key; undefined when that cannot be read statically. */
  optional: boolean | undefined;
  hasDefault: boolean;
  default?: unknown;
  description?: string;
  values?: Array<string | number | boolean>;
}

const MAX_DEPTH = 8;

class ContractReader {
  /** Local names of the zod namespace (`z`, or an alias). */
  private readonly zodNames: Set<string>;

  constructor(private readonly scan: Scan) {
    this.zodNames = new Set(["z"]);
    const text = scan.text;
    for (const m of text.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
    )) {
      if (!/^(?:zod(?:\/v3)?|@thelacanians\/cairntrace\/verifier)$/.test(m[2]!))
        continue;
      for (const part of m[1]!.split(",")) {
        const alias = /^\s*z\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(part);
        if (alias) this.zodNames.add(alias[1]!);
      }
    }
    for (const m of text.matchAll(
      /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["']zod["']/g,
    )) {
      this.zodNames.add(m[1]!);
    }
  }

  /** The initializer of a top-level `const name = …`. */
  resolveIdentifier(name: string): Range | undefined {
    const re = new RegExp(
      `\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=;]+)?=\\s*`,
      "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.scan.text))) {
      if (!this.scan.isCode(m.index)) continue;
      const start = m.index + m[0].length;
      return { start, end: this.scan.expressionEnd(start) };
    }
    return undefined;
  }

  /** A z.object() schema expression: its keys and strictness. */
  readObject(range: Range, depth: number): ObjectInfo | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const links = this.scan.chain(range);
    if (!links || links.length === 0) return undefined;
    let info: ObjectInfo | undefined;
    let i = 0;
    const head = links[0]!.name;
    if (
      this.zodNames.has(head) &&
      (links[1]?.name === "object" || links[1]?.name === "strictObject") &&
      links[1].args
    ) {
      info = this.objectLiteral(links[1].args[0], depth);
      i = 2;
    } else if (
      this.zodNames.has(head) &&
      links[1]?.name === "intersection" &&
      links[1].args
    ) {
      const [left, right] = links[1].args;
      const a = left ? this.readObject(left, depth + 1) : undefined;
      if (!a) return undefined;
      info = intersectObject(
        a,
        right ? this.readObject(right, depth + 1) : undefined,
      );
      i = 2;
    } else if (!this.zodNames.has(head) && links[0]!.args === undefined) {
      const resolved = this.resolveIdentifier(head);
      info = resolved ? this.readObject(resolved, depth + 1) : undefined;
      i = 1;
    }
    if (!info) return undefined;
    for (; i < links.length; i++) {
      const link = links[i]!;
      const args = link.args ?? [];
      switch (link.name) {
        case "strict":
        case "strip":
          info.strict = true;
          break;
        case "passthrough":
        case "catchall":
          info.strict = false;
          break;
        case "extend":
        case "augment":
          info = mergeObject(info, this.objectLiteral(args[0], depth));
          break;
        case "and":
          // An intersection: both sides' keys; unknown keys are rejected
          // only when neither side accepts them.
          info = intersectObject(
            info,
            args[0] ? this.readObject(args[0], depth + 1) : undefined,
          );
          break;
        case "setKey": {
          const name = args[0] ? this.scan.stringLiteral(args[0]) : undefined;
          if (name === undefined || !args[1]) {
            info = { ...info, dynamic: true, reason: dynamicReason(link.name) };
            break;
          }
          info = mergeObject(info, {
            keys: [toKey(name, this.readType(args[1], depth + 1))],
            strict: info.strict,
            dynamic: false,
          });
          break;
        }
        case "merge": {
          const other = args[0]
            ? this.readObject(args[0], depth + 1)
            : undefined;
          info = mergeObject(
            info,
            other ?? {
              keys: [],
              strict: info.strict,
              dynamic: true,
              reason: "merges a schema that cannot be read statically",
            },
          );
          break;
        }
        case "partial":
        case "deepPartial":
          info.keys = info.keys.map((k) => ({ ...k, required: false }));
          break;
        case "required":
          info.keys = info.keys.map((k) =>
            k.default === undefined ? { ...k, required: true } : k,
          );
          break;
        case "pick":
        case "omit": {
          const names = args[0]
            ? new Set(this.scan.objectEntries(args[0].start).map((e) => e.key))
            : new Set<string>();
          info.keys = info.keys.filter((k) =>
            link.name === "pick" ? names.has(k.name) : !names.has(k.name),
          );
          break;
        }
        default:
          if (TRANSPARENT_OBJECT_METHODS.has(link.name)) break;
          // `.or(…)`, `.array()`, a plugin method…: the runtime no longer
          // sees a plain object, so neither keys nor strictness hold.
          info = {
            ...info,
            strict: false,
            dynamic: true,
            reason: dynamicReason(link.name),
          };
          break;
      }
    }
    return withUnreadKeys(info);
  }

  private objectLiteral(arg: Range | undefined, depth: number): ObjectInfo {
    if (!arg) {
      return {
        keys: [],
        strict: true,
        dynamic: true,
        reason: "empty z.object()",
      };
    }
    const start = this.scan.skipSpace(arg.start);
    if (this.scan.text[start] !== "{") {
      const name = this.scan.text.slice(start, arg.end).trim();
      const resolved = /^[A-Za-z_$][\w$]*$/.test(name)
        ? this.resolveIdentifier(name)
        : undefined;
      if (
        resolved &&
        this.scan.text[this.scan.skipSpace(resolved.start)] === "{"
      ) {
        return this.objectLiteral(resolved, depth + 1);
      }
      return {
        keys: [],
        strict: true,
        dynamic: true,
        reason: "the z.object() shape is not an inline object literal",
      };
    }
    const keys: SdkFixtureKey[] = [];
    let dynamic = false;
    let reason: string | undefined;
    for (const entry of this.scan.objectEntries(start)) {
      if (entry.key === "...") {
        dynamic = true;
        reason = "the z.object() shape spreads another object";
        continue;
      }
      // `{ within }` is `{ within: within }`: readType resolves the binding.
      keys.push(toKey(entry.key, this.readType(entry.value, depth + 1)));
    }
    return { keys, strict: true, dynamic, ...(reason ? { reason } : {}) };
  }

  readType(range: Range, depth: number): TypeInfo | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const links = this.scan.chain(range);
    if (!links || links.length === 0) return undefined;
    let info: TypeInfo | undefined;
    let i = 1;
    const head = links[0]!;
    if (this.zodNames.has(head.name)) {
      let factory = links[1];
      i = 2;
      if (factory?.name === "coerce") {
        factory = links[2];
        i = 3;
      }
      if (!factory?.args) return undefined;
      info = this.factory(factory.name, factory.args, depth);
    } else if (head.args === undefined) {
      const resolved = this.resolveIdentifier(head.name);
      info = resolved ? this.readType(resolved, depth + 1) : undefined;
    }
    info ??= unread();
    for (; i < links.length; i++) {
      const link = links[i]!;
      const arg = link.args?.[0];
      switch (link.name) {
        case "optional":
        case "nullish":
        case "catch":
          info.optional = true;
          break;
        case "default":
          info.optional = true;
          info.hasDefault = true;
          if (arg) {
            const value = this.scan.literal(arg);
            if (value.ok) info.default = value.value;
          }
          break;
        case "describe": {
          const text = arg ? this.scan.stringLiteral(arg) : undefined;
          if (text !== undefined) info.description = text;
          break;
        }
        case "array":
        case "promise":
          // A list (or promise) of optional values is itself required.
          info = {
            ...info,
            type: link.name === "array" ? arrayOf(info.type) : info.type,
            optional: false,
            values: undefined,
          };
          delete info.values;
          break;
        case "or": {
          const other =
            (arg ? this.readType(arg, depth + 1) : undefined) ?? unread();
          info.type = `${info.type} | ${other.type}`;
          info.optional = anyOptional([info.optional, other.optional]);
          delete info.values;
          break;
        }
        case "and": {
          const other =
            (arg ? this.readType(arg, depth + 1) : undefined) ?? unread();
          info.type = `${info.type} & ${other.type}`;
          info.optional = allOptional([info.optional, other.optional]);
          delete info.values;
          break;
        }
        default:
          break; // min, max, int, regex, refine, transform, nullable, pipe, …
      }
    }
    return info;
  }

  private factory(name: string, args: Range[], depth: number): TypeInfo {
    switch (name) {
      case "string":
      case "number":
      case "boolean":
      case "date":
      case "bigint":
      case "null":
      case "object":
      case "record":
      case "tuple":
      case "nan":
      case "symbol":
      case "map":
      case "set":
      case "never":
      case "function":
      case "instanceof":
        return base(name === "instanceof" ? "unknown" : name);
      case "any":
      case "unknown":
      case "undefined":
      case "void":
        // zod treats a key whose schema accepts undefined as optional.
        return { ...base(name), optional: true };
      case "array": {
        const inner = args[0] ? this.readType(args[0], depth + 1) : undefined;
        return base(arrayOf(inner?.type ?? "unknown"));
      }
      case "enum": {
        const values = args[0] ? this.scan.literal(args[0]) : NO_LITERAL;
        const list =
          values.ok && Array.isArray(values.value)
            ? (values.value as unknown[]).filter(
                (v): v is string => typeof v === "string",
              )
            : undefined;
        return { ...base("enum"), ...(list ? { values: list } : {}) };
      }
      case "nativeEnum":
        return base("enum");
      case "literal": {
        const value = args[0] ? this.scan.literal(args[0]) : NO_LITERAL;
        const v = value.ok ? value.value : undefined;
        if (value.ok && v === undefined) {
          return { ...base("undefined"), optional: true };
        }
        return {
          ...base("literal"),
          ...(typeof v === "string" ||
          typeof v === "number" ||
          typeof v === "boolean"
            ? { values: [v] }
            : {}),
        };
      }
      case "union":
      case "discriminatedUnion": {
        const list = args[name === "union" ? 0 : 1];
        const members =
          list && this.scan.text[this.scan.skipSpace(list.start)] === "["
            ? this.scan.arrayItems(this.scan.skipSpace(list.start))
            : [];
        if (members.length === 0) return unread();
        const infos = members.map(
          (m) => this.readType(m, depth + 1) ?? unread(),
        );
        return {
          ...base(infos.map((m) => m.type).join(" | ")),
          optional:
            name === "union"
              ? anyOptional(infos.map((m) => m.optional))
              : false,
        };
      }
      case "intersection": {
        const infos = [args[0], args[1]].map(
          (m) => (m ? this.readType(m, depth + 1) : undefined) ?? unread(),
        );
        return {
          ...base(infos.map((m) => m.type).join(" & ")),
          optional: allOptional(infos.map((m) => m.optional)),
        };
      }
      case "optional":
      case "nullable": {
        const inner = args[0] ? this.readType(args[0], depth + 1) : undefined;
        return {
          ...(inner ?? unread()),
          ...(name === "optional" ? { optional: true } : {}),
        };
      }
      case "preprocess": {
        // The preprocess function may turn a missing key into a value.
        const inner =
          (args[1] ? this.readType(args[1], depth + 1) : undefined) ?? unread();
        return {
          ...inner,
          optional: inner.optional === true ? true : undefined,
        };
      }
      default:
        // custom, lazy, … : nothing can be said about the key.
        return unread();
    }
  }
}

function base(type: string): TypeInfo {
  return { type, optional: false, hasDefault: false };
}

/** A schema the static reader cannot see into (imported, a helper call, z.custom…). */
function unread(): TypeInfo {
  return { type: "unknown", optional: undefined, hasDefault: false };
}

/** Three-valued OR: optional if any member is; unknown if any is unknown. */
function anyOptional(values: Array<boolean | undefined>): boolean | undefined {
  if (values.includes(true)) return true;
  return values.includes(undefined) ? undefined : false;
}

/** Three-valued AND: required if any member is; unknown if any is unknown. */
function allOptional(values: Array<boolean | undefined>): boolean | undefined {
  if (values.includes(false)) return false;
  return values.includes(undefined) ? undefined : true;
}

function dynamicReason(method: string): string {
  return `.${method}() on the fixtures schema cannot be read statically (use --load)`;
}

/** Note keys whose own schema could not be read (no `required`). */
function withUnreadKeys(info: ObjectInfo): ObjectInfo {
  const unreadKeys = info.keys
    .filter((k) => k.required === undefined)
    .map((k) => k.name);
  if (unreadKeys.length === 0 || info.reason) return info;
  return {
    ...info,
    reason: `the schema of ${unreadKeys.join(", ")} cannot be read statically (imported or built by a helper), so whether ${
      unreadKeys.length === 1 ? "it is" : "they are"
    } required is not checked (use --load)`,
  };
}

function arrayOf(type: string): string {
  return type.includes(" | ") ? `(${type})[]` : `${type}[]`;
}

function toKey(name: string, type: TypeInfo | undefined): SdkFixtureKey {
  const optional = type?.optional;
  return {
    name,
    type: type?.type ?? "unknown",
    ...(optional === undefined ? {} : { required: !optional }),
    ...(type?.hasDefault && type.default !== undefined
      ? { default: type.default }
      : {}),
    ...(type?.description ? { description: type.description } : {}),
    ...(type?.values ? { values: type.values } : {}),
  };
}

/** `a.and(b)` / `z.intersection(a, b)`; b undefined when it cannot be read. */
function intersectObject(a: ObjectInfo, b: ObjectInfo | undefined): ObjectInfo {
  if (!b) {
    return {
      ...a,
      strict: false,
      dynamic: true,
      reason: "intersects a schema that cannot be read statically",
    };
  }
  const byName = new Map(a.keys.map((k) => [k.name, k]));
  for (const key of b.keys) {
    const existing = byName.get(key.name);
    if (!existing) {
      byName.set(key.name, key);
      continue;
    }
    // Both sides must accept the value: required if either side requires it.
    const optional = allOptional([
      existing.required === undefined ? undefined : !existing.required,
      key.required === undefined ? undefined : !key.required,
    ]);
    const merged: SdkFixtureKey = { ...existing };
    delete merged.required;
    if (optional !== undefined) merged.required = !optional;
    byName.set(key.name, merged);
  }
  const reason = a.reason ?? b.reason;
  return {
    keys: [...byName.values()],
    strict: a.strict && b.strict,
    dynamic: a.dynamic || b.dynamic,
    ...(reason ? { reason } : {}),
  };
}

function mergeObject(a: ObjectInfo, b: ObjectInfo): ObjectInfo {
  const byName = new Map(a.keys.map((k) => [k.name, k]));
  for (const key of b.keys) byName.set(key.name, key);
  const reason = a.reason ?? b.reason;
  return {
    keys: [...byName.values()],
    strict: a.strict,
    dynamic: a.dynamic || b.dynamic,
    ...(reason ? { reason } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* a small, string- and comment-aware scanner                          */
/* ------------------------------------------------------------------ */

const Kind = { Code: 0, Comment: 1, String: 2 } as const;

const IDENT_CHAR = /[\w$]/;

class Scan {
  readonly kinds: Uint8Array;

  constructor(readonly text: string) {
    this.kinds = classify(text);
  }

  isCode(i: number): boolean {
    return this.kinds[i] === Kind.Code;
  }

  skipSpace(i: number): number {
    while (
      i < this.text.length &&
      (/\s/.test(this.text[i]!) || this.kinds[i] === Kind.Comment)
    )
      i++;
    return i;
  }

  /** First `name(` in code (a method call `x.name(` counts too). */
  findCall(name: string): { open: number } | undefined {
    let from = 0;
    while (true) {
      const at = this.text.indexOf(name, from);
      if (at < 0) return undefined;
      from = at + name.length;
      if (!this.isCode(at)) continue;
      const before = this.text[at - 1];
      if (before && IDENT_CHAR.test(before)) continue;
      const after = this.text[at + name.length];
      if (after && IDENT_CHAR.test(after)) continue;
      // `function defineVerifier(` declares, not calls.
      if (/\bfunction\s*$/.test(this.text.slice(Math.max(0, at - 20), at)))
        continue;
      const open = this.skipSpace(at + name.length);
      if (this.text[open] === "(") return { open };
    }
  }

  /** Index of the bracket closing the one at `open`, or -1. */
  close(open: number): number {
    const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
    const stack: string[] = [];
    for (let i = open; i < this.text.length; i++) {
      if (!this.isCode(i)) continue;
      const ch = this.text[i]!;
      if (pairs[ch]) stack.push(pairs[ch]);
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (stack.pop() !== ch) return -1;
        if (stack.length === 0) return i;
      }
    }
    return -1;
  }

  /** Top-level comma-separated parts of the bracketed range at `open`. */
  private parts(open: number): Range[] {
    const end = this.close(open);
    if (end < 0) return [];
    const out: Range[] = [];
    let depth = 0;
    let start = open + 1;
    for (let i = open + 1; i < end; i++) {
      if (!this.isCode(i)) continue;
      const ch = this.text[i]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        out.push({ start, end: i });
        start = i + 1;
      }
    }
    out.push({ start, end });
    return out.filter((r) => this.text.slice(r.start, r.end).trim() !== "");
  }

  arrayItems(open: number): Range[] {
    return this.parts(open);
  }

  /** `key: value` entries of the object literal at `open` (spreads as key "..."). */
  objectEntries(at: number): Entry[] {
    const open = this.skipSpace(at);
    if (this.text[open] !== "{") return [];
    const out: Entry[] = [];
    for (const part of this.parts(open)) {
      const start = this.skipSpace(part.start);
      const text = this.text.slice(start, part.end);
      if (text.startsWith("...")) {
        out.push({ key: "...", value: { start: start + 3, end: part.end } });
        continue;
      }
      const colon = this.topLevelColon(start, part.end);
      if (colon < 0) {
        const name = /^([A-Za-z_$][\w$]*)\s*$/.exec(text);
        if (name) out.push({ key: name[1]!, value: part, shorthand: true });
        continue; // a method (`run(ctx) { … }`) or getter
      }
      const rawKey = this.text.slice(start, colon).trim();
      const key = /^["'`](.*)["'`]$/s.exec(rawKey)?.[1] ?? rawKey;
      if (!/^[\w$-]+$/.test(key)) continue; // computed key
      out.push({ key, value: { start: colon + 1, end: part.end } });
    }
    return out;
  }

  private topLevelColon(start: number, end: number): number {
    let depth = 0;
    for (let i = start; i < end; i++) {
      if (!this.isCode(i)) continue;
      const ch = this.text[i]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === ":" && depth === 0) return i;
      else if (ch === "?" && depth === 0) return -1; // ternary / optional
    }
    return -1;
  }

  /** End of the expression starting at `start` (a top-level `;`, or a newline that ends it). */
  expressionEnd(start: number): number {
    let depth = 0;
    for (let i = start; i < this.text.length; i++) {
      if (!this.isCode(i)) continue;
      const ch = this.text[i]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) return i;
        depth--;
      } else if (depth === 0 && (ch === ";" || ch === ",")) return i;
      else if (depth === 0 && ch === "\n") {
        const next = this.skipSpace(i);
        if (this.text[next] !== ".") return i;
      }
    }
    return this.text.length;
  }

  /** `a.b(…).c<…>(…)` as links; undefined for anything else. */
  chain(range: Range): Link[] | undefined {
    const links: Link[] = [];
    let i = this.skipSpace(range.start);
    const end = range.end;
    const ident = (): string | undefined => {
      const m = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(i, end));
      if (!m) return undefined;
      i += m[0].length;
      return m[0];
    };
    const first = ident();
    if (!first) return undefined;
    links.push({ name: first });
    while (true) {
      i = this.skipSpace(i);
      if (i >= end) break;
      const ch = this.text[i];
      if (ch === "." || (ch === "?" && this.text[i + 1] === ".")) {
        i += ch === "." ? 1 : 2;
        i = this.skipSpace(i);
        const name = ident();
        if (!name) return undefined;
        links.push({ name });
        continue;
      }
      if (ch === "<") {
        // Generic type arguments: skip to the matching `>`.
        let depth = 0;
        for (; i < end; i++) {
          if (this.text[i] === "<") depth++;
          else if (this.text[i] === ">" && --depth === 0) break;
        }
        i++;
        continue;
      }
      if (ch === "(") {
        const close = this.close(i);
        if (close < 0 || close > end) return undefined;
        links[links.length - 1]!.args = this.parts(i);
        i = close + 1;
        continue;
      }
      if (/^(?:as|satisfies)\b/.test(this.text.slice(i, end))) break;
      return undefined;
    }
    return links;
  }

  /** A plain string literal's value. */
  stringLiteral(range: Range): string | undefined {
    const value = this.literal(range);
    return value.ok && typeof value.value === "string"
      ? value.value
      : undefined;
  }

  /** A JS literal: strings in any quote style, numbers, booleans, null, arrays, objects. */
  literal(range: Range): { ok: true; value: unknown } | { ok: false } {
    const parser = new LiteralParser(this.text.slice(range.start, range.end));
    try {
      const value = parser.value();
      parser.space();
      return parser.done() ? { ok: true, value } : { ok: false };
    } catch {
      return { ok: false };
    }
  }
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/** Recursive-descent reader for literal JS values (no expressions). */
class LiteralParser {
  private i = 0;

  constructor(private readonly s: string) {}

  done(): boolean {
    return this.i >= this.s.length;
  }

  space(): void {
    while (this.i < this.s.length) {
      if (/\s/.test(this.s[this.i]!)) this.i++;
      else if (this.s.startsWith("//", this.i)) {
        const end = this.s.indexOf("\n", this.i);
        this.i = end < 0 ? this.s.length : end;
      } else if (this.s.startsWith("/*", this.i)) {
        const end = this.s.indexOf("*/", this.i + 2);
        this.i = end < 0 ? this.s.length : end + 2;
      } else break;
    }
  }

  value(): unknown {
    this.space();
    const ch = this.s[this.i];
    if (ch === '"' || ch === "'" || ch === "`") return this.string();
    if (ch === "[") return this.array();
    if (ch === "{") return this.object();
    const word =
      /^(?:-?(?:\d[\d_]*(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+)|true|false|null|undefined)(?![\w$])/i.exec(
        this.s.slice(this.i),
      );
    if (!word) throw new Error("not a literal");
    this.i += word[0].length;
    const w = word[0];
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    if (w === "undefined") return undefined;
    const n = Number(w.replace(/_/g, ""));
    if (!Number.isFinite(n)) throw new Error("not a number");
    return n;
  }

  private string(): string {
    const quote = this.s[this.i]!;
    let out = "";
    this.i++;
    while (this.i < this.s.length && this.s[this.i] !== quote) {
      const ch = this.s[this.i]!;
      if (quote === "`" && ch === "$" && this.s[this.i + 1] === "{") {
        throw new Error("template expression");
      }
      if (ch === "\\") {
        const next = this.s[this.i + 1] ?? "";
        out += ESCAPES[next] ?? next;
        this.i += 2;
        continue;
      }
      out += ch;
      this.i++;
    }
    if (this.s[this.i] !== quote) throw new Error("unterminated string");
    this.i++;
    return out;
  }

  private array(): unknown[] {
    const out: unknown[] = [];
    this.i++;
    while (true) {
      this.space();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.space();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") throw new Error("bad array");
    }
  }

  private object(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.i++;
    while (true) {
      this.space();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      const ch = this.s[this.i];
      let key: string;
      if (ch === '"' || ch === "'") key = this.string();
      else {
        const m = /^(?:[A-Za-z_$][\w$]*|\d+)/.exec(this.s.slice(this.i));
        if (!m) throw new Error("bad key");
        key = m[0];
        this.i += key.length;
      }
      this.space();
      if (this.s[this.i] !== ":") throw new Error("bad object");
      this.i++;
      out[key] = this.value();
      this.space();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}") throw new Error("bad object");
    }
  }
}

/** Mark each character as code, comment, or string/template/regex literal. */
function classify(text: string): Uint8Array {
  const kinds = new Uint8Array(text.length);
  let i = 0;
  let lastCode = "";
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      kinds.fill(Kind.Comment, i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      kinds.fill(Kind.Comment, i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") j++;
        else if (ch !== "`" && text[j] === "\n") break;
        j++;
      }
      const stop = Math.min(text.length, j + 1);
      kinds.fill(Kind.String, i, stop);
      i = stop;
      lastCode = ch;
      continue;
    }
    if (ch === "/" && startsRegex(lastCode)) {
      let j = i + 1;
      let inClass = false;
      for (; j < text.length && text[j] !== "\n"; j++) {
        const c = text[j];
        if (c === "\\") j++;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
      }
      if (j < text.length && text[j] === "/") {
        kinds.fill(Kind.String, i, j + 1);
        i = j + 1;
        lastCode = "/";
        continue;
      }
    }
    if (!/\s/.test(ch)) lastCode = ch;
    i++;
  }
  return kinds;
}

/** A `/` after one of these opens a regex literal, not a division. */
function startsRegex(lastCode: string): boolean {
  return lastCode === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastCode);
}

const NO_LITERAL: { ok: false } = { ok: false };
