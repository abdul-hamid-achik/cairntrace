import type { Locator, Outcome, Spec, Step } from "../schema/spec.v1";
import {
  isCredentialHeader,
  isIdentifierHeader,
  looksCredentialKey,
  numberAsSecretNote,
  looksSecretName,
  looksSecretValue,
  placeholderKey,
  redactUrlCredentials,
  renderSpecYaml,
  safeDecode,
  secretShapedSubstrings,
  slug,
  snakeId,
  summarizeCoverage,
  tokenAfterCredentialName,
  type ImportCoverage,
  type ImportItem,
  type ImportItemKind,
} from "./importCommon";
import {
  countOutcome,
  textOutcome,
  visibilityOutcome,
  type OutcomeResult,
  type TextMatcherDraft,
} from "./assertionOutcomes";
import { openZip, type ZipArchive, type ZipLimits } from "./zipReader";
import {
  chainToLocator,
  cssForTestId,
  parseWireSelector,
  type LocChain,
} from "./playwrightLocators";

/**
 * `cairn import playwright-trace`: a Playwright trace archive (the zip that
 * `context.tracing.stop({ path })` or `trace: "on"` writes) as a DRAFT spec.
 * It reads only the structured action log (`*.trace`) and the network log
 * (`*.network`): no screenshots, no sources, no resource bodies, no DOM
 * snapshots. Steps come from the recorded actions with the best locator the
 * trace holds; outcomes are drafts from the recorded `expect()` calls, the
 * final URL and the API calls the page made. Credentials never become
 * literals: typed secrets, credential headers, credential-named body keys
 * (nested values and numbers included), URL user:password, credential query
 * and fragment parameters and credential-shaped values (JWTs, long hex or
 * base64 tokens, also as path segments) are `${secrets.X}` placeholders;
 * network candidates carry no bodies. A final pass replaces every value the
 * importer identified as a credential wherever else it shows up (steps,
 * outcomes, ids, TODOs, approximations, the rendered YAML).
 */

/** Largest `.trace` / `.network` entry and total bytes read from one archive. */
export const TRACE_ZIP_LIMITS: ZipLimits = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 160 * 1024 * 1024,
};

export interface ImportTraceOptions {
  /** Spec name (default: the trace's test title, else `playwright_trace_draft`). */
  name?: string;
  /** Spec intent (default: the trace's title, else a placeholder to replace). */
  intent?: string;
  /** Shown in the header (the trace file as given). */
  sourceLabel?: string;
  /** Most network outcome candidates (default 10). */
  maxNetwork?: number;
  /** Decompression limits (default {@link TRACE_ZIP_LIMITS}). */
  limits?: ZipLimits;
}

export interface TraceSummary {
  /** Recorded protocol calls looked at. */
  calls: number;
  /** Reads (counts, text, attributes) ignored: they carry no behavior. */
  readsIgnored: number;
  /** Network responses seen, by what became of them. */
  network: { responses: number; candidates: number; skipped: number };
  baseUrl?: string;
  playwrightVersion?: string;
  browser?: string;
}

export interface ImportTraceResult {
  spec: Spec;
  yaml: string;
  todos: string[];
  coverage: ImportCoverage;
  approximations: string[];
  items: ImportItem[];
  summary: TraceSummary;
  /** `${secrets.X}` names the draft uses (never the values). */
  secrets: string[];
}

export class TraceFormatError extends Error {}

interface TraceEvent {
  type?: string;
  callId?: string;
  stepId?: string;
  parentId?: string;
  startTime?: number;
  endTime?: number;
  class?: string;
  method?: string;
  title?: string;
  params?: Record<string, unknown>;
  message?: string;
  error?: { name?: string; message?: string };
  result?: unknown;
  options?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  testIdAttributeName?: string;
  playwrightVersion?: string;
  browserName?: string;
}

interface Call {
  id: string;
  event: TraceEvent;
  logs: string[];
  error?: string;
  /** Closest enclosing `test.step` title (test-runner traces). */
  stepTitle?: string;
}

const READ_METHODS = new Set([
  "queryCount",
  "innerText",
  "innerHTML",
  "textContent",
  "inputValue",
  "getAttribute",
  "isChecked",
  "isDisabled",
  "isEditable",
  "isEnabled",
  "isHidden",
  "isVisible",
  "title",
  "content",
  "url",
  "boundingBox",
  "screenshot",
  "ariaSnapshot",
  "highlight",
  "querySelector",
  "querySelectorAll",
  "frameElement",
  "elementHandle",
  "waitForTimeoutInternal",
]);

const IGNORED_CLASSES_METHODS = new Set([
  "BrowserContext.newPage",
  "BrowserContext.close",
  "Page.close",
  "Page.__waitInfo__",
  "Page.bringToFront",
  "Tracing.tracingStart",
  "Tracing.tracingStop",
  "Tracing.tracingStartChunk",
  "Tracing.tracingStopChunk",
  "Browser.newContext",
  "Browser.close",
]);

export function importPlaywrightTrace(
  zipBuffer: Buffer,
  opts: ImportTraceOptions = {},
): ImportTraceResult {
  return new TraceImporter(
    openZip(zipBuffer, opts.limits ?? TRACE_ZIP_LIMITS),
    opts,
  ).run();
}

class TraceImporter {
  private readonly steps: Step[] = [];
  private readonly outcomes: Outcome[] = [];
  private readonly items: ImportItem[] = [];
  private readonly approximations: string[] = [];
  private readonly headerTodos: string[] = [];
  private readonly secretKeys = new Set<string>();
  /** placeholder key → the value it stands for (never written). */
  private readonly secretByKey = new Map<string, string>();
  /**
   * Every value identified as a credential (and its derived forms) → strong:
   * typed into a password field or under a credential's name (`password`,
   * `pin`, `token`, …) rather than only by a weaker signal (an `auth` /
   * `csrf` key, a URL user name). See `scrubbable`.
   */
  private readonly secretValues = new Map<string, boolean>();
  private readonly usedStepIds = new Set<string>();
  private testIdAttribute = "data-testid";
  private baseUrl: string | undefined;
  private origin: string | undefined;
  private title: string | undefined;
  private playwrightVersion: string | undefined;
  private browser: string | undefined;
  private readsIgnored = 0;
  private calls = 0;
  private lastStepTitle: string | undefined;

  constructor(
    private readonly zip: ZipArchive,
    private readonly opts: ImportTraceOptions,
  ) {}

  run(): ImportTraceResult {
    const traceNames = this.zip.entries
      .map((e) => e.name)
      .filter((n) => /(^|\/)(?:\d+-)?trace\.trace$|(^|\/)test\.trace$/.test(n));
    const networkNames = this.zip.entries
      .map((e) => e.name)
      .filter((n) => /(^|\/)(?:\d+-)?trace\.network$/.test(n));
    if (traceNames.length === 0) {
      throw new TraceFormatError(
        "no trace.trace in the archive: not a Playwright trace zip (expected trace.trace / trace.network / resources/)",
      );
    }
    // Browser-level traces first (`trace.trace`, `0-trace.trace`), the
    // test-runner's `test.trace` carries step titles.
    const testTrace = traceNames.filter((n) => n.endsWith("test.trace"));
    const browserTraces = traceNames
      .filter((n) => !n.endsWith("test.trace"))
      .toSorted();
    const stepTitles = this.readStepTitles(testTrace);
    const lastUrls: string[] = [];
    for (const name of browserTraces) {
      this.processTrace(name, stepTitles, lastUrls);
    }

    const responses = this.readNetwork(networkNames);
    this.finalOutcomes(lastUrls, responses.candidates);
    this.collectShapedSecrets();

    // A test-runner title is "file:line › describe › test"; the test is the last part.
    const title =
      this.scrubText(this.title?.split("›").pop()?.trim() ?? "") || undefined;
    const titleName = title ? slug(title) : undefined;
    const name = this.opts.name
      ? slug(this.opts.name)
      : titleName && !this.idLeaks(titleName)
        ? titleName
        : "playwright_trace_draft";
    const intent =
      this.opts.intent?.trim() ||
      title ||
      "TODO state the user goal this recorded session demonstrates";
    if (!this.opts.intent && !title) {
      this.headerTodos.push(
        "intent is a placeholder; pass --intent or edit it",
      );
    }

    if (this.outcomes.length === 0) {
      this.headerTodos.push(
        "No expect() call, final URL or API call mapped to an outcome; replace placeholder outcome.",
      );
      this.outcomes.push({
        id: "todo_assertion",
        description:
          "TODO replace with the behavior this recording demonstrates",
        verify: { text: { contains: "TODO_replace_me" } },
      });
    }

    // Final pass: a value identified as a credential anywhere (a later fill,
    // a header, a URL) is replaced wherever else it was recorded, including
    // calls seen before it was identified and ids derived from it.
    const steps = this.steps.map((step) => this.scrubSpecValue(step) as Step);
    const outcomes = this.outcomes.map(
      (o) => this.scrubSpecValue(o) as Outcome,
    );
    this.reidentify(steps);
    this.reidentify(outcomes);
    if (this.redactedLiterals > 0) {
      this.headerTodos.push(
        `${this.redactedLiterals} recorded value(s) held part of a credential and now read <redacted>; replace them with the right \${secrets.X} reference`,
      );
    }
    const items = this.items.map((item) => ({
      ...item,
      source: this.scrubText(item.source),
      ...(item.note !== undefined ? { note: this.scrubText(item.note) } : {}),
    }));
    const approximations = this.approximations.map((a) => this.scrubText(a));
    const headerTodos = this.headerTodos.map((t) => this.scrubText(t));

    const spec: Spec = {
      version: 1,
      name,
      intent: this.scrubSpecValue(intent) as string,
      mode: "normal",
      outcomes,
      ...(steps.length > 0 ? { steps } : {}),
    };
    const rendered = renderSpecYaml(spec, {
      generator: "cairn import playwright-trace",
      ...(this.opts.sourceLabel ? { sourceLabel: this.opts.sourceLabel } : {}),
      headerTodos,
      approximations,
      headerNotes: [
        "DRAFT: derived from a recording. Steps replay what the recording did; outcome descriptions starting with DRAFT",
        "  come from recorded expect() calls, the final URL and observed API calls. Review them: a recording shows what",
        "  happened, not what must stay true.",
        ...(this.baseUrl
          ? [
              `Recorded against ${this.baseUrl}; relative open: paths need that origin as the environment baseUrl.`,
            ]
          : []),
        ...(this.secretKeys.size > 0
          ? [
              `Secrets referenced: ${[...this.secretKeys].map((k) => `\${secrets.${k}}`).join(", ")} (values are never written; provide them via your secrets source).`,
            ]
          : []),
      ],
      items,
    });
    // Belt and braces: nothing identified as a credential survives rendering.
    const yaml = this.scrubText(rendered);
    const todos = [
      ...items
        .filter((item) => item.kind === "unmapped")
        .map((item) =>
          item.note ? `${item.source} — ${item.note}` : item.source,
        ),
      ...headerTodos,
    ];
    return {
      spec,
      yaml,
      todos,
      coverage: summarizeCoverage(items),
      approximations,
      items,
      secrets: [...this.secretKeys],
      summary: {
        calls: this.calls,
        readsIgnored: this.readsIgnored,
        network: {
          responses: responses.total,
          candidates: responses.candidates.length,
          skipped: responses.total - responses.candidates.length,
        },
        ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
        ...(this.playwrightVersion
          ? { playwrightVersion: this.playwrightVersion }
          : {}),
        ...(this.browser ? { browser: this.browser } : {}),
      },
    };
  }

  /* ----- reading ----- */

  /**
   * The JSON-lines events of one entry, parsed line by line from the bytes
   * (no whole-entry string, no array of lines).
   */
  private *events(name: string): Generator<TraceEvent> {
    const bytes = this.zip.read(name);
    let start = 0;
    while (start < bytes.length) {
      let end = bytes.indexOf(0x0a, start);
      if (end < 0) end = bytes.length;
      const line = bytes.toString("utf8", start, end);
      start = end + 1;
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as TraceEvent;
      } catch {
        // a truncated trailing line from an interrupted trace
      }
    }
  }

  /** stepId → title of its closest `test.step` ancestor (test-runner traces). */
  private readStepTitles(testTraces: string[]): Map<string, string> {
    const titles = new Map<string, string>();
    for (const name of testTraces) {
      const parentOf = new Map<string, string | undefined>();
      const own = new Map<string, string>();
      for (const e of this.events(name)) {
        if (e.type === "context-options") this.noteContext(e);
        if (e.type !== "before" || !e.stepId) continue;
        parentOf.set(e.stepId, e.parentId);
        if (e.method === "test.step" && e.title) own.set(e.stepId, e.title);
      }
      for (const stepId of parentOf.keys()) {
        // A hostile or corrupt trace can make parent links cycle.
        const visited = new Set<string>();
        let cursor: string | undefined = stepId;
        while (cursor && !visited.has(cursor)) {
          visited.add(cursor);
          const t = own.get(cursor);
          if (t) {
            titles.set(stepId, t);
            break;
          }
          cursor = parentOf.get(cursor);
        }
      }
    }
    return titles;
  }

  private noteContext(e: TraceEvent): void {
    const version = (e as { version?: unknown }).version;
    if (typeof version === "number" && (version < 5 || version > 8)) {
      const note = `trace format version ${version} is outside the versions this importer was checked against (5-8); review the draft`;
      if (!this.headerTodos.includes(note)) this.headerTodos.push(note);
    }
    if (typeof e.testIdAttributeName === "string")
      this.testIdAttribute = e.testIdAttributeName;
    if (typeof e.playwrightVersion === "string")
      this.playwrightVersion ??= e.playwrightVersion;
    if (typeof e.browserName === "string" && e.browserName)
      this.browser ??= e.browserName;
    const base = e.options?.["baseURL"];
    if (typeof base === "string" && base) {
      this.baseUrl ??= this.cleanBaseUrl(base);
      this.origin ??= safeOrigin(base);
    }
    if (typeof e.title === "string" && e.title && !this.title)
      this.title = e.title;
  }

  private processTrace(
    name: string,
    stepTitles: Map<string, string>,
    lastUrls: string[],
  ): void {
    const calls = new Map<string, Call>();
    const order: Call[] = [];
    for (const e of this.events(name)) {
      switch (e.type) {
        case "context-options":
          this.noteContext(e);
          break;
        case "before":
          if (e.callId) {
            const call: Call = {
              id: e.callId,
              event: e,
              logs: [],
              ...(e.stepId && stepTitles.get(e.stepId)
                ? { stepTitle: stepTitles.get(e.stepId)! }
                : {}),
            };
            calls.set(e.callId, call);
            order.push(call);
          }
          break;
        case "log": {
          const c = e.callId ? calls.get(e.callId) : undefined;
          if (c && typeof e.message === "string") c.logs.push(e.message);
          break;
        }
        case "after": {
          const c = e.callId ? calls.get(e.callId) : undefined;
          if (c && e.error)
            c.error = e.error.message ?? e.error.name ?? "failed";
          break;
        }
        case "frame-snapshot": {
          const snap = e.snapshot;
          if (
            snap &&
            snap["isMainFrame"] === true &&
            typeof snap["frameUrl"] === "string" &&
            !String(snap["frameUrl"]).startsWith("about:")
          ) {
            lastUrls.push(snap["frameUrl"]);
          }
          break;
        }
        default:
          break;
      }
    }
    for (const call of order) this.handleCall(call);
  }

  /* ----- recording ----- */

  private record(kind: ImportItemKind, source: string, note?: string): void {
    this.items.push({
      kind,
      source,
      ...(note ? { note } : {}),
      beforeStep: this.steps.length,
    });
  }

  private describe(call: Call): string {
    const e = call.event;
    const p = e.params ?? {};
    const selector =
      typeof p["selector"] === "string" ? ` ${p["selector"]}` : "";
    const url =
      typeof p["url"] === "string"
        ? ` ${this.redactUrl(String(p["url"]), "text")}`
        : "";
    return `${e.class ?? "?"}.${e.method ?? "?"}${selector}${url}`;
  }

  private unmapped(call: Call, reason: string): void {
    this.record("unmapped", this.scrubText(this.describe(call)), reason);
  }

  /**
   * Known credential values the final pass replaces wherever else they were
   * recorded, longest first (a value inside another goes last). Replacing a
   * short value elsewhere rewrites ordinary words and ids (`north` in a
   * URL, `en-US` in a title), so: a strong credential from 4 characters, any
   * other from 8 or when credential-shaped. Where it was identified it is a
   * placeholder whatever its length.
   */
  private scrubbable(): string[] {
    return [...this.secretValues]
      .filter(([v, strong]) =>
        strong ? v.length >= 4 : v.length >= 8 || looksSecretValue(v),
      )
      .map(([v]) => v)
      .toSorted((a, b) => b.length - a.length);
  }

  /** Free text with every known credential value as `<redacted>` (placeholders kept). */
  private scrubText(text: string): string {
    const values = this.scrubbable();
    if (values.length === 0) return text;
    return mapOutsidePlaceholders(text, (part) => {
      let out = part;
      for (const v of values) out = out.split(v).join("<redacted>");
      return out;
    });
  }

  private redactedLiterals = 0;

  /**
   * A spec value with every known credential replaced: by its own
   * `${secrets.X}` when the whole value is one, else `<redacted>` (counted,
   * reported as a TODO).
   */
  private scrubSpecValue(value: unknown): unknown {
    if (typeof value === "string") {
      const values = this.scrubbable();
      if (values.length === 0) return value;
      const keyOf = new Map<string, string>();
      for (const [k, v] of this.secretByKey) if (!keyOf.has(v)) keyOf.set(v, k);
      return mapOutsidePlaceholders(value, (part) => {
        let out = part;
        for (const v of values) {
          if (!out.includes(v)) continue;
          const key = keyOf.get(v);
          if (key === undefined) this.redactedLiterals += 1;
          out = out
            .split(v)
            .join(key !== undefined ? `\${secrets.${key}}` : "<redacted>");
        }
        return out;
      });
    }
    if (Array.isArray(value)) return value.map((v) => this.scrubSpecValue(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // An id never holds a placeholder: reidentify renames one derived
        // from a credential (`click_redacted`).
        out[k] =
          k === "id" && typeof v === "string" ? v : this.scrubSpecValue(v);
      }
      return out;
    }
    return value;
  }

  /** Whether an id (a slug) carries a known credential, whole or cut short. */
  private idLeaks(id: string): boolean {
    for (const v of this.scrubbable()) {
      const s = slug(v).replace(/^imported_/, "");
      if (s.length < 4) continue;
      if (id.includes(s)) return true;
      for (let k = Math.min(s.length, id.length); k >= 5; k -= 1) {
        if (id.endsWith(s.slice(0, k))) return true;
      }
    }
    return false;
  }

  /** Ids derived from a credential become `<verb>_redacted`, still unique. */
  private reidentify(list: Array<{ id?: string | undefined }>): void {
    const used = new Set<string>();
    for (const item of list) {
      if (item.id === undefined) continue;
      let base = item.id;
      if (this.idLeaks(base)) base = `${base.split("_")[0] || "step"}_redacted`;
      let id = base;
      for (let n = 2; used.has(id); n += 1) id = `${base}_${n}`;
      used.add(id);
      item.id = id;
    }
  }

  /**
   * Credential-shaped substrings (JWTs) anywhere in what will be written
   * become known secrets, so the final pass replaces them. A hex digest is a
   * credential only where its context says so (a credential key, header or
   * path segment): a commit SHA or request id elsewhere stays as recorded.
   */
  private collectShapedSecrets(): void {
    const texts: string[] = [
      JSON.stringify(this.steps),
      JSON.stringify(this.outcomes),
      ...this.items.flatMap((i) => [i.source, i.note ?? ""]),
      ...this.approximations,
      ...this.headerTodos,
      this.title ?? "",
    ];
    for (const text of texts) {
      for (const found of secretShapedSubstrings(text, { hexDigests: false })) {
        if (!this.secretValues.has(found)) this.noteSecret("token", found);
      }
    }
  }

  private noteSecretValue(value: string, strong = false): void {
    if (!value) return;
    const add = (v: string, isStrong = strong): void => {
      this.secretValues.set(v, isStrong || this.secretValues.get(v) === true);
    };
    add(value);
    const scheme = /^(bearer|basic|token|digest)\s+(\S+)$/i.exec(value.trim());
    if (scheme) {
      add(scheme[2]!, true);
      if (scheme[1]!.toLowerCase() === "basic") {
        const decoded = Buffer.from(scheme[2]!, "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        if (colon >= 0) {
          add(decoded, true);
          if (decoded.length > colon + 1) add(decoded.slice(colon + 1), true);
        }
      }
    }
    const encoded = encodeURIComponent(value);
    if (encoded !== value) add(encoded);
    const json = JSON.stringify(value).slice(1, -1);
    if (json !== value) add(json);
  }

  /** A context baseURL without user:password, query or fragment. */
  private cleanBaseUrl(base: string): string {
    try {
      const u = new URL(base);
      if (u.username && (!u.password || looksSecretValue(u.username)))
        this.noteSecretValue(safeDecode(u.username));
      if (u.password) this.noteSecretValue(safeDecode(u.password), true);
      return `${u.origin}${u.pathname}`.replace(/\/$/, "");
    } catch {
      return this.redactUrl(base, "text").replace(/\/$/, "");
    }
  }

  /**
   * A URL with every credential it carries replaced: user:password, query and
   * fragment parameters with a credential name or a credential-shaped value,
   * credential-shaped path segments (and a token-like segment after a
   * credential-named one, as in `/reset-password/<token>`). `placeholder`
   * writes `${secrets.X}` (and lists it); `text` writes `<redacted>` for
   * descriptions. Both remember the values for the final pass.
   */
  private redactUrl(
    url: string,
    mode: "placeholder" | "text",
    approx?: string[],
  ): string {
    const sink = (
      hint: string,
      value: string,
      what: string,
      scrubElsewhere = true,
    ): string => {
      if (mode === "text") {
        if (scrubElsewhere)
          this.noteSecretValue(
            value,
            /password/.test(hint) || looksSecretName(hint),
          );
        return "<redacted>";
      }
      const ph = this.noteSecret(hint, value, scrubElsewhere);
      approx?.push(`${what} became ${ph}`);
      return ph;
    };
    return redactUrlCredentials(url, sink);
  }

  private addStep(
    step: Step,
    call: Call,
    kindWord: string,
    approx: readonly string[] = [],
  ): void {
    const id = this.stepId(call, kindWord);
    this.steps.push({ id, ...step } as Step);
    this.noted(call, approx);
  }

  private noted(call: Call, approx: readonly string[]): void {
    const source = this.scrubText(this.describe(call));
    if (approx.length === 0) {
      this.record("mapped", source);
      return;
    }
    this.record("approximated", source, approx.join("; "));
    for (const entry of approx) {
      const line = `${source}: ${entry}`;
      if (!this.approximations.includes(line)) this.approximations.push(line);
    }
  }

  private stepId(call: Call, kindWord: string): string {
    const fromTitle =
      call.stepTitle && call.stepTitle !== this.lastStepTitle
        ? snakeId(call.stepTitle)
        : undefined;
    this.lastStepTitle = call.stepTitle;
    const base = fromTitle ?? kindWord;
    let id = base;
    for (let n = 2; this.usedStepIds.has(id); n += 1) id = `${base}_${n}`;
    this.usedStepIds.add(id);
    return id;
  }

  private addOutcome(result: OutcomeResult, call: Call): void {
    if ("unmapped" in result) {
      this.unmapped(call, result.unmapped);
      return;
    }
    this.pushOutcome(result.baseId, result.description, result.verify);
    this.noted(call, result.approx);
  }

  private pushOutcome(
    baseId: string,
    description: string,
    verify: Outcome["verify"],
  ): void {
    let id = baseId;
    for (let n = 2; this.outcomes.some((o) => o.id === id); n += 1)
      id = `${baseId}_${n}`;
    this.outcomes.push({ id, description: `DRAFT: ${description}`, verify });
  }

  /* ----- calls ----- */

  private handleCall(call: Call): void {
    const e = call.event;
    const key = `${e.class ?? ""}.${e.method ?? ""}`;
    if (IGNORED_CLASSES_METHODS.has(key)) return;
    const cls = e.class ?? "";
    const method = e.method ?? "";
    if (
      ![
        "Frame",
        "Page",
        "APIRequestContext",
        "BrowserContext",
        "Request",
        "Response",
      ].includes(cls)
    ) {
      return;
    }
    if (cls === "Frame" && READ_METHODS.has(method)) {
      this.readsIgnored += 1;
      return;
    }
    if (cls === "Page" && READ_METHODS.has(method)) {
      this.readsIgnored += 1;
      return;
    }
    this.calls += 1;
    if (call.error) {
      this.unmapped(
        call,
        `the recorded call failed (${firstLine(call.error)}); it is not imported`,
      );
      return;
    }
    const p = e.params ?? {};
    switch (key) {
      case "Frame.goto":
        return this.mapGoto(call);
      case "Frame.click":
      case "Frame.dblclick":
      case "Frame.tap":
        return this.mapClick(call, method);
      case "Frame.hover":
        return this.mapLocatorStep(call, "hover", (l) => ({ hover: l }));
      case "Frame.focus":
        return this.mapLocatorStep(call, "focus", (l) => ({ focus: l }));
      case "Frame.check":
        return this.mapLocatorStep(call, "check", (l) => ({ check: l }));
      case "Frame.uncheck":
        return this.mapLocatorStep(call, "uncheck", (l) => ({ uncheck: l }));
      case "Frame.fill":
        return this.mapFill(call, "fill", String(p["value"] ?? ""));
      case "Frame.type":
        return this.mapFill(call, "type", String(p["text"] ?? ""));
      case "Frame.press": {
        const keyName = typeof p["key"] === "string" ? p["key"] : undefined;
        if (!keyName) return this.unmapped(call, "press without a key");
        return this.mapLocatorStep(call, `press_${slug(keyName)}`, (l) => ({
          press: keyName,
          target: l,
        }));
      }
      case "Page.keyboardPress": {
        const keyName = typeof p["key"] === "string" ? p["key"] : undefined;
        if (!keyName) return this.unmapped(call, "press without a key");
        return this.addStep({ press: keyName }, call, `press_${slug(keyName)}`);
      }
      case "Frame.selectOption":
        return this.mapSelect(call);
      case "Frame.waitForSelector":
        return this.mapWaitForSelector(call);
      case "Frame.waitForTimeout": {
        const ms =
          typeof p["waitTimeout"] === "number"
            ? Math.round(p["waitTimeout"])
            : 0;
        if (ms >= 1 && ms <= 300_000)
          return this.addStep({ wait: { ms } }, call, "wait");
        return this.unmapped(call, "wait duration outside 1..300000ms");
      }
      case "Frame.expect":
        return this.mapExpect(call);
      case "APIRequestContext.fetch":
        return this.mapRequest(call);
      case "Frame.setInputFiles":
        return this.unmapped(
          call,
          "file payloads in a trace are not paths; add an upload: step with a real path",
        );
      case "Page.keyboardType":
      case "Page.keyboardInsertText":
      case "Page.keyboardDown":
      case "Page.keyboardUp":
        return this.unmapped(
          call,
          "raw keyboard input has no Cairntrace step; type into a locator or press a key",
        );
      case "Page.reload":
      case "Page.goBack":
      case "Page.goForward":
        return this.unmapped(
          call,
          `${method} has no Cairntrace step; open the URL again`,
        );
      case "Frame.evaluateExpression":
      case "Frame.evaluateExpressionHandle":
        return this.unmapped(
          call,
          "page evaluate has no mapped equivalent; use an eval: step by hand",
        );
      case "BrowserContext.addCookies":
      case "BrowserContext.setExtraHTTPHeaders":
      case "BrowserContext.route":
      case "Page.route":
        return this.unmapped(
          call,
          "context state / network mocking has no Cairntrace step (cookies and headers belong to a login or checkpoint)",
        );
      default:
        return this.unmapped(call, `${cls}.${method} is not imported`);
    }
  }

  private baseOf(url: string): string | undefined {
    return this.origin ?? (this.origin = safeOrigin(url));
  }

  private mapGoto(call: Call): void {
    const p = call.event.params ?? {};
    const raw = typeof p["url"] === "string" ? p["url"] : "";
    if (!raw) return this.unmapped(call, "goto without a URL");
    const approx: string[] = [];
    let target = raw;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      const origin = this.baseOf(raw);
      if (origin && safeOrigin(raw) === origin) {
        this.baseUrl ??= origin;
        target = this.sameOriginPath(raw);
      }
    }
    const redacted = this.redactUrl(target, "placeholder", approx);
    const waitUntil =
      typeof p["waitUntil"] === "string" ? p["waitUntil"] : undefined;
    const step: Step =
      waitUntil === "networkidle" || waitUntil === "domcontentloaded"
        ? { open: { path: redacted, waitUntil } }
        : { open: redacted };
    this.addStep(step, call, "open", approx);
  }

  /**
   * The path, query and fragment of a same-origin URL. A user:password the
   * origin drops is remembered as a credential for the final pass.
   */
  private sameOriginPath(url: string): string {
    try {
      const u = new URL(url);
      if (u.username && (!u.password || looksSecretValue(u.username)))
        this.noteSecretValue(safeDecode(u.username));
      if (u.password) this.noteSecretValue(safeDecode(u.password), true);
    } catch {
      // not parseable: pathOf keeps it whole and redactUrl handles it
    }
    return pathOf(url);
  }

  /**
   * `${secrets.KEY}` for a credential value. KEY comes from the hint; a
   * different value under the same hint gets its own numbered key.
   */
  private noteSecret(
    hint: string,
    value: string,
    scrubElsewhere = true,
    strong = /password/.test(hint) || looksSecretName(hint),
  ): string {
    const base = placeholderKey(hint, "SECRET");
    let key = base;
    for (
      let n = 2;
      this.secretByKey.has(key) && this.secretByKey.get(key) !== value;
      n += 1
    ) {
      key = `${base}_${n}`;
    }
    this.secretByKey.set(key, value);
    this.secretKeys.add(key);
    if (scrubElsewhere) this.noteSecretValue(value, strong);
    return `\${secrets.${key}}`;
  }

  /* ----- locators ----- */

  private locatorOf(call: Call):
    | {
        locator: Locator;
        approx: string[];
        chain: LocChain;
        element?: ElementInfo;
      }
    | undefined {
    const selector = call.event.params?.["selector"];
    if (typeof selector !== "string" || !selector) {
      this.unmapped(call, "no selector recorded");
      return undefined;
    }
    const parsed = parseWireSelector(selector, this.testIdAttribute);
    if ("error" in parsed) {
      this.unmapped(call, parsed.error);
      return undefined;
    }
    const element = resolvedElement(call.logs);
    const upgraded = this.upgrade(parsed.chain, element);
    const resolved = chainToLocator(upgraded.chain);
    if (!resolved.locator) {
      this.unmapped(call, resolved.error ?? "locator cannot be expressed");
      return undefined;
    }
    return {
      locator: resolved.locator,
      approx: [...resolved.approx, ...upgraded.notes],
      chain: upgraded.chain,
      ...(element ? { element } : {}),
    };
  }

  /**
   * A CSS-only selector is the author's choice of "no better handle"; the
   * resolved element in the call log can name a better one:
   * role+name > label > testid > text > css.
   */
  private upgrade(
    chain: LocChain,
    element: ElementInfo | undefined,
  ): { chain: LocChain; notes: string[] } {
    const only = chain.parts.length === 1 ? chain.parts[0] : undefined;
    if (!only || only.kind !== "css" || !element || chain.nth !== undefined) {
      return { chain, notes: [] };
    }
    const role = roleOf(element);
    const name =
      element.attrs["aria-label"] ??
      (element.text && !element.truncated ? element.text : undefined);
    if (role && name && name.length <= 80) {
      return {
        chain: { ...chain, parts: [{ kind: "role", role, name }] },
        notes: [
          `css ${only.selector} was upgraded to role ${role} "${name}" from the resolved element (uniqueness is not verified)`,
        ],
      };
    }
    const testid = element.attrs[this.testIdAttribute];
    if (testid) {
      return {
        chain: { ...chain, parts: [{ kind: "testid", testid }] },
        notes: [
          `css ${only.selector} was upgraded to test id "${testid}" from the resolved element`,
        ],
      };
    }
    return { chain, notes: [] };
  }

  private wordsFor(l: Locator): string {
    switch (l.by) {
      case "role":
        return slug(l.name ?? l.role);
      case "label":
        return slug(l.name);
      case "text":
        return slug(l.text);
      case "testid":
        return slug(l.testid);
      case "selector":
        return slug(l.selector);
    }
  }

  private mapLocatorStep(
    call: Call,
    verb: string,
    build: (l: Locator) => Step,
  ): void {
    const target = this.locatorOf(call);
    if (!target) return;
    this.addStep(
      build(target.locator),
      call,
      `${verb}_${this.wordsFor(target.locator)}`.slice(0, 48),
      target.approx,
    );
  }

  private mapClick(call: Call, method: string): void {
    const p = call.event.params ?? {};
    const target = this.locatorOf(call);
    if (!target) return;
    const approx = [...target.approx];
    if (method === "dblclick")
      approx.push("dblclick became a single click (no double-click step)");
    if (method === "tap") approx.push("tap became a click");
    if (typeof p["button"] === "string" && p["button"] !== "left") {
      return this.unmapped(
        call,
        `click with button ${String(p["button"])} has no Cairntrace step`,
      );
    }
    if (
      typeof p["clickCount"] === "number" &&
      p["clickCount"] > 1 &&
      method !== "dblclick"
    ) {
      approx.push(`clickCount ${p["clickCount"]} became a single click`);
    }
    this.addStep(
      { click: target.locator },
      call,
      `click_${this.wordsFor(target.locator)}`.slice(0, 48),
      approx,
    );
  }

  private secretField(target: {
    chain: LocChain;
    element?: ElementInfo;
  }): string | undefined {
    const el = target.element;
    if (el) {
      if (el.attrs["type"] === "password") {
        return (
          el.attrs["aria-label"] ??
          el.attrs["name"] ??
          el.attrs["id"] ??
          "password"
        );
      }
      for (const attr of [
        "name",
        "id",
        "aria-label",
        "autocomplete",
        "placeholder",
      ]) {
        const v = el.attrs[attr];
        if (v && looksSecretName(v)) return v;
      }
    }
    for (const part of target.chain.parts) {
      if (part.kind === "label" && looksSecretName(part.name)) return part.name;
      if (part.kind === "role" && looksSecretName(part.name)) return part.name;
      if (part.kind === "testid" && looksSecretName(part.testid))
        return part.testid;
      if (part.kind === "css" && looksSecretName(part.selector))
        return part.selector;
    }
    return undefined;
  }

  private mapFill(call: Call, kind: "fill" | "type", raw: string): void {
    const target = this.locatorOf(call);
    if (!target) return;
    const approx = [...target.approx];
    let value = raw;
    const hint = this.secretField(target);
    if (hint !== undefined && raw !== "") {
      value = this.noteSecret(hint, raw, true, true);
      approx.push(`value typed into a credential field became ${value}`);
    } else if (looksSecretValue(raw)) {
      value = this.noteSecret(
        `${this.wordsFor(target.locator) || "typed"}_token`,
        raw,
      );
      approx.push(`a credential-shaped typed value became ${value}`);
    }
    const delay = call.event.params?.["delay"];
    const step: Step =
      kind === "fill"
        ? ({ fill: { ...target.locator, value } } as Step)
        : ({
            type: {
              ...target.locator,
              value,
              ...(typeof delay === "number" && delay > 0
                ? { delayMs: Math.round(delay) }
                : {}),
            },
          } as Step);
    this.addStep(
      step,
      call,
      `${kind}_${this.wordsFor(target.locator)}`.slice(0, 48),
      approx,
    );
  }

  private mapSelect(call: Call): void {
    const target = this.locatorOf(call);
    if (!target) return;
    const options = call.event.params?.["options"];
    const list = Array.isArray(options)
      ? (options as Array<Record<string, unknown>>)
      : [];
    if (list.length !== 1)
      return this.unmapped(
        call,
        "selectOption with several options has no Cairntrace step",
      );
    const o = list[0]!;
    const approx = [...target.approx];
    let choice: { value: string } | { label: string };
    if (typeof o["label"] === "string") choice = { label: o["label"] };
    else if (typeof o["value"] === "string") choice = { value: o["value"] };
    else if (typeof o["valueOrLabel"] === "string") {
      choice = { value: o["valueOrLabel"] };
      approx.push(
        "selectOption(string) matches value or label in Playwright; mapped as the option value",
      );
    } else
      return this.unmapped(
        call,
        "selectOption by index has no Cairntrace step",
      );
    this.addStep(
      { select: { ...target.locator, ...choice } } as Step,
      call,
      `select_${this.wordsFor(target.locator)}`.slice(0, 48),
      approx,
    );
  }

  private mapWaitForSelector(call: Call): void {
    const target = this.locatorOf(call);
    if (!target) return;
    const state =
      typeof call.event.params?.["state"] === "string"
        ? String(call.event.params["state"])
        : "visible";
    const timeout = call.event.params?.["timeout"];
    const t =
      typeof timeout === "number" && timeout > 0 && timeout !== 30000
        ? { timeoutMs: Math.round(timeout) }
        : {};
    const l = target.locator;
    const approx = [...target.approx];
    if (!["attached", "visible", "hidden", "detached"].includes(state)) {
      return this.unmapped(call, `waitFor state ${state} is not mapped`);
    }
    if (l.by === "selector" || l.by === "testid") {
      const selector =
        l.by === "selector"
          ? l.selector
          : cssForTestId(l.testid, this.testIdAttribute);
      return this.addStep(
        {
          wait: {
            selector,
            state: state as "attached" | "visible" | "hidden" | "detached",
            ...("hasText" in l && l.hasText ? { hasText: l.hasText } : {}),
            ...t,
          },
        },
        call,
        `wait_${this.wordsFor(l)}`.slice(0, 48),
        approx,
      );
    }
    const text = l.by === "text" ? l.text : l.by === "label" ? l.name : l.name;
    if (!text)
      return this.unmapped(
        call,
        "waiting for a role without a name has no Cairntrace wait",
      );
    approx.push(
      `waiting for ${l.by} ${JSON.stringify(text)} became a wait on its text`,
    );
    this.addStep(
      state === "hidden" || state === "detached"
        ? { wait: { notText: text, ...t } }
        : { wait: { text, ...t } },
      call,
      `wait_${slug(text)}`.slice(0, 48),
      approx,
    );
  }

  /* ----- expect ----- */

  private mapExpect(call: Call): void {
    const p = call.event.params ?? {};
    const expression =
      typeof p["expression"] === "string" ? p["expression"] : "";
    const isNot = p["isNot"] === true;
    const expected = Array.isArray(p["expectedText"])
      ? (p["expectedText"] as Array<Record<string, unknown>>)
      : [];
    if (expression === "to.have.url") {
      const e = expected[0];
      if (isNot || !e)
        return this.unmapped(
          call,
          "negated or empty URL assertion has no mapped outcome",
        );
      if (typeof e["regexSource"] === "string") {
        this.pushOutcome("url_matches", "page URL matches", {
          url: { matches: e["regexSource"] },
        });
        return this.noted(
          call,
          typeof e["regexFlags"] === "string" && e["regexFlags"].includes("i")
            ? ["regex flag i dropped"]
            : [],
        );
      }
      if (typeof e["string"] === "string") {
        const expectedUrl = e["string"];
        const raw = expectedUrl.startsWith("/")
          ? expectedUrl
          : (() => {
              const origin = this.origin;
              return origin && safeOrigin(expectedUrl) === origin
                ? this.sameOriginPath(expectedUrl)
                : expectedUrl;
            })();
        const approx: string[] = [];
        const path = this.redactUrl(raw, "placeholder", approx);
        this.pushOutcome("url_matches", "page URL matches", {
          url: path.startsWith("/") ? { endsWith: path } : { equals: path },
        });
        return this.noted(call, approx);
      }
      return this.unmapped(
        call,
        "URL assertion without a string or regular expression",
      );
    }
    if (expression === "to.have.title") {
      return this.unmapped(call, "page title has no mapped outcome");
    }
    const target = this.locatorOf(call);
    if (!target) return;
    const l = target.locator;
    const base = target.approx;
    switch (expression) {
      case "to.be.visible":
      case "to.be.attached":
        return this.addOutcome(
          visibilityOutcome(l, !isNot, base, this.testIdAttribute),
          call,
        );
      case "to.be.hidden":
        return this.addOutcome(
          visibilityOutcome(l, isNot, base, this.testIdAttribute),
          call,
        );
      case "to.have.text":
      case "to.have.text.array": {
        const e = expected[0];
        if (!e || expected.length > 1)
          return this.unmapped(
            call,
            "text assertion over several values is not imported",
          );
        let matcher: TextMatcherDraft;
        const approx = [...base];
        if (typeof e["regexSource"] === "string") {
          matcher = { matches: e["regexSource"] };
          if (
            typeof e["regexFlags"] === "string" &&
            e["regexFlags"].includes("i")
          )
            approx.push(
              "regex flag i dropped (text.matches is case-sensitive)",
            );
        } else if (typeof e["string"] === "string") {
          matcher =
            e["matchSubstring"] === true
              ? { contains: e["string"] }
              : { equals: e["string"] };
        } else
          return this.unmapped(
            call,
            "text assertion without a string or regular expression",
          );
        return this.addOutcome(
          textOutcome(l, matcher, isNot, approx, this.testIdAttribute),
          call,
        );
      }
      case "to.have.count": {
        const n = p["expectedNumber"];
        if (typeof n !== "number" || isNot)
          return this.unmapped(
            call,
            "count assertion without a literal number",
          );
        return this.addOutcome(
          countOutcome(l, n, base, this.testIdAttribute),
          call,
        );
      }
      case "to.have.value": {
        const e = expected[0];
        if (!e || typeof e["string"] !== "string" || isNot)
          return this.unmapped(call, "value assertion without a string");
        return this.addStep(
          { wait: { value: { ...l, equals: e["string"] } } } as Step,
          call,
          `wait_value_${this.wordsFor(l)}`.slice(0, 48),
          base,
        );
      }
      case "to.be.enabled":
      case "to.be.disabled": {
        const enabled = (expression === "to.be.enabled") !== isNot;
        return this.addStep(
          { expect: { ...l, enabled } } as Step,
          call,
          `expect_${this.wordsFor(l)}`.slice(0, 48),
          base,
        );
      }
      default:
        return this.unmapped(
          call,
          `${expression || "expect"} has no mapped outcome`,
        );
    }
  }

  /* ----- requests ----- */

  private mapRequest(call: Call): void {
    const p = call.event.params ?? {};
    const url = typeof p["url"] === "string" ? p["url"] : "";
    const method = String(p["method"] ?? "GET").toUpperCase();
    if (!url) return this.unmapped(call, "request without a URL");
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
        method,
      )
    ) {
      return this.unmapped(call, `request method ${method} is not supported`);
    }
    const approx: string[] = [];
    let target = url;
    if (
      /^[a-z][a-z0-9+.-]*:\/\//i.test(url) &&
      this.origin &&
      safeOrigin(url) === this.origin
    ) {
      target = this.sameOriginPath(url);
    }
    target = this.redactUrl(target, "placeholder", approx);
    const headers: Record<string, string> = {};
    const rawHeaders = Array.isArray(p["headers"])
      ? (p["headers"] as Array<{ name?: string; value?: string }>)
      : [];
    for (const h of rawHeaders) {
      if (!h.name) continue;
      if (
        isCredentialHeader(h.name) ||
        looksSecretName(h.name) ||
        // a request / trace id is hex-shaped, not a key
        (!isIdentifierHeader(h.name) && looksSecretValue(String(h.value ?? "")))
      ) {
        headers[h.name] = this.noteSecret(h.name, String(h.value ?? ""));
        approx.push(`header ${h.name} became ${headers[h.name]}`);
      } else if (
        !/^(content-length|host|user-agent|accept-encoding|connection)$/i.test(
          h.name,
        )
      ) {
        headers[h.name] = String(h.value ?? "");
      }
    }
    let body: unknown;
    if (typeof p["jsonData"] === "string") {
      try {
        body = this.maskBody(JSON.parse(p["jsonData"]) as unknown, "", approx);
      } catch {
        approx.push("request body was not JSON and was dropped");
      }
    } else if (
      p["postData"] !== undefined ||
      p["formData"] !== undefined ||
      p["multipartData"] !== undefined
    ) {
      approx.push("non-JSON request body was dropped");
    }
    this.addStep(
      {
        request: {
          method: method as "GET",
          url: target,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(body !== undefined ? { body } : {}),
        },
      },
      call,
      // the id comes from the redacted URL (placeholders dropped), never the raw one
      `request_${method.toLowerCase()}_${slug(
        (target.split(/[?#]/)[0] ?? "").replace(/\$\{[^}]*\}/g, ""),
      )}`.slice(0, 48),
      approx,
    );
  }

  /**
   * A JSON body with credentials as placeholders: string or number values
   * under a credential-named key, everything nested under one (the parent's
   * name is inherited), and credential-shaped strings under any key.
   */
  private maskBody(
    value: unknown,
    keyHint: string,
    approx: string[],
    underCredential = false,
  ): unknown {
    const credential = underCredential || looksCredentialKey(keyHint);
    const secret = (raw: string): string => {
      const hint = keyHint || "body";
      const ph = this.noteSecret(hint, raw);
      approx.push(`value of ${hint} became ${ph}`);
      return ph;
    };
    if (typeof value === "string") {
      if (value !== "" && (credential || looksSecretValue(value)))
        return secret(value);
      return value;
    }
    if (
      (typeof value === "number" || typeof value === "bigint") &&
      credential
    ) {
      const ph = secret(String(value));
      approx.push(numberAsSecretNote(keyHint || "body"));
      return ph;
    }
    if (Array.isArray(value))
      return value.map((v) => this.maskBody(v, keyHint, approx, credential));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.maskBody(
          v,
          credential && keyHint ? `${keyHint}_${k}` : k,
          approx,
          credential,
        );
      }
      return out;
    }
    return value;
  }

  /* ----- network + final URL ----- */

  private readNetwork(names: string[]): {
    total: number;
    candidates: NetworkCandidate[];
  } {
    const seen = new Map<string, NetworkCandidate>();
    let total = 0;
    const appOrigin = () => this.origin;
    for (const name of names) {
      for (const e of this.events(name)) {
        if (e.type !== "resource-snapshot" || !e.snapshot) continue;
        const snap = e.snapshot as {
          request?: { method?: string; url?: string };
          response?: { status?: number };
        };
        total += 1;
        const type = (e.snapshot as Record<string, unknown>)["_resourceType"];
        const url = snap.request?.url;
        const method = snap.request?.method?.toUpperCase();
        const status = snap.response?.status;
        if (!url || !method || typeof status !== "number" || status <= 0)
          continue;
        if (type !== "fetch" && type !== "xhr") continue;
        if (method === "OPTIONS" || method === "HEAD") continue;
        if (appOrigin() && safeOrigin(url) !== appOrigin()) continue;
        const pattern = pathPattern(url);
        const key = `${method} ${pattern}`;
        if (!seen.has(key))
          seen.set(key, { method, path: pattern, status, count: 0 });
        seen.get(key)!.count += 1;
      }
    }
    return {
      total,
      candidates: [...seen.values()].slice(0, this.opts.maxNetwork ?? 10),
    };
  }

  private finalOutcomes(lastUrls: string[], network: NetworkCandidate[]): void {
    const last = lastUrls[lastUrls.length - 1];
    if (last) {
      const origin = safeOrigin(last);
      if (!this.origin && origin) this.origin = origin;
      const path =
        origin && origin === this.origin ? new URL(last).pathname : last;
      if (path.startsWith("/")) {
        const segments = path.split("/");
        const volatile = segments.map(
          (seg) => isIdSegment(seg) || looksSecretValue(safeDecode(seg)),
        );
        if (volatile.some(Boolean)) {
          // Ids and tokens change per run: match the shape, never the value.
          const shown = segments
            .map((seg, i) => (volatile[i] ? "{id}" : seg))
            .join("/");
          const pattern = segments
            .map((seg, i) => (volatile[i] ? "[^/?#]+" : escapeRegex(seg)))
            .join("/");
          this.pushOutcome("final_url", `the session ends on ${shown}`, {
            url: { matches: `${pattern}(?:[?#]|$)` },
          });
          this.record(
            "approximated",
            `final page URL (${shown})`,
            "id-like path segments became [^/?#]+ (recorded values change per run)",
          );
        } else {
          this.pushOutcome("final_url", `the session ends on ${path}`, {
            url: { endsWith: path },
          });
          this.record("mapped", `final page URL (${path})`);
        }
      }
    }
    for (const c of network) {
      const id = `api_${c.method.toLowerCase()}_${slug(c.path)}`
        .replace(/_+$/, "")
        .slice(0, 60);
      this.pushOutcome(id, `${c.method} ${c.path} answers ${c.status}`, {
        network: {
          method: c.method as "GET",
          urlContains: c.path,
          status: { equals: c.status },
        },
      });
      this.record(
        "mapped",
        `network ${c.method} ${c.path} -> ${c.status}${
          c.count > 1 ? ` (x${c.count})` : ""
        }`,
      );
    }
    if (!this.baseUrl && this.origin) this.baseUrl = this.origin;
  }
}

interface NetworkCandidate {
  method: string;
  path: string;
  status: number;
  count: number;
}

interface ElementInfo {
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  truncated: boolean;
}

/** `locator resolved to <button id="x">Load items</button>` from a call's log. */
function resolvedElement(logs: string[]): ElementInfo | undefined {
  for (const line of logs) {
    const m = /locator resolved to (?:visible )?(<[^]*)$/.exec(line.trim());
    if (!m) continue;
    const html = m[1]!;
    const open = /^<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\/?>/.exec(html);
    if (!open) continue;
    const attrs: Record<string, string> = {};
    for (const a of open[2]!.matchAll(/([\w:-]+)="([^"]*)"/g))
      attrs[a[1]!] = a[2]!;
    const rest = html.slice(open[0].length);
    const close = rest.indexOf(`</${open[1]}>`);
    const inner = close >= 0 ? rest.slice(0, close) : rest;
    const hasChildren = /</.test(inner);
    const truncated = inner.includes("…") || close < 0;
    const text = hasChildren ? undefined : inner.replace(/\s+/g, " ").trim();
    return {
      tag: open[1]!.toLowerCase(),
      attrs,
      ...(text ? { text } : {}),
      truncated: truncated || hasChildren,
    };
  }
  return undefined;
}

function roleOf(el: ElementInfo): string | undefined {
  const explicit = el.attrs["role"];
  if (explicit) return explicit;
  switch (el.tag) {
    case "button":
      return "button";
    case "a":
      return el.attrs["href"] !== undefined ? "link" : undefined;
    case "input": {
      const type = (el.attrs["type"] ?? "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset")
        return "button";
      return undefined;
    }
    default:
      return undefined;
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

/** A response URL as a path pattern: no origin, no query, id-like segments cut. */
function pathPattern(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "/";
  }
  const segments = pathname.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (
      isIdSegment(seg) ||
      looksSecretValue(safeDecode(seg)) ||
      (prev !== undefined && tokenAfterCredentialName(prev, seg))
    ) {
      return `${out.join("/")}/`;
    }
    out.push(seg);
  }
  return pathname || "/";
}

/** A path segment that names one record: digits, a hex id, a UUID. */
function isIdSegment(seg: string): boolean {
  return (
    /^\d+$/.test(seg) ||
    /^[0-9a-f]{8,}$/i.test(seg) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)
  );
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `fn` over the parts of `text` outside `${…}` placeholders. */
function mapOutsidePlaceholders(
  text: string,
  fn: (part: string) => string,
): string {
  return text
    .split(/(\$\{[^}]*\})/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? text).slice(0, 120);
}
