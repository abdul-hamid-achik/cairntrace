import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import type { SnapshotElement } from "../healer/snapshotParser";
import type { Locator, Step } from "../schema/spec.v1";
import { withoutQuery } from "../artifacts/stepLabel";
import { redactYamlDocument } from "../discovery/placeholderRedaction";
import { DRAFT_FILE, type SessionJournal } from "../discovery/sessionJournal";
import { replaceStepLocator } from "./replaceStepLocator";

/**
 * The journal side of an accompany session (`_sessions/<id>/`, kind
 * `accompany`): every locator the harness chose is an `action.performed`
 * (`action: "choose"`, ok once the step passed with it), an accepted choice
 * is a `step.recorded` carrying the replacement step and where it is
 * declared, and `draft.spec.yml` is a copy of the spec with every accepted
 * replacement applied. The source spec is never written.
 */

/** Where a resolved step is declared (from parseSpec origins). */
export interface StepOriginRef {
  file: string;
  stepIndex: number;
}

/** One locator decision, as reported by accompany status. */
export interface AccompanyDecision {
  /** Journal action index. */
  index: number;
  stepId: string;
  /** 0-based index among the run's resolved steps. */
  stepIndex: number;
  /** The locator recorded for the spec (semantic, never a snapshot @ref). */
  locator: Locator;
  /** undefined while the retried step is still running. */
  ok?: boolean;
  error?: string;
  /** Where the replaced step is declared (spec or imported action). */
  origin?: StepOriginRef;
}

interface Pending {
  decision: AccompanyDecision;
  url: string;
  startedAt: number;
}

export interface AccompanyRecorderOptions {
  journal: SessionJournal;
  specPath: string;
  /** Raw spec text (placeholders intact) the draft copy starts from. */
  sourceText?: string;
  /** Resolved step index → declaring file + index in that file. */
  origins: ReadonlyMap<number, StepOriginRef>;
  /** Also write the draft copy here (refused when it is the source). */
  draftTo?: string;
}

export class AccompanyRecorder {
  readonly decisions: AccompanyDecision[] = [];
  private readonly journal: SessionJournal;
  private readonly specPath: string;
  private readonly origins: ReadonlyMap<number, StepOriginRef>;
  private readonly draft?: Document;
  private readonly draftTo?: string;
  private pending?: Pending;
  private parkedUrl = "";
  private actions = 0;
  private replacements = 0;

  constructor(opts: AccompanyRecorderOptions) {
    this.journal = opts.journal;
    this.specPath = resolve(opts.specPath);
    this.origins = opts.origins;
    if (opts.sourceText !== undefined) {
      try {
        this.draft = parseDocument(opts.sourceText);
      } catch {
        // No draft for a spec the yaml library cannot load.
      }
    }
    if (opts.draftTo !== undefined) {
      const target = resolve(opts.draftTo);
      if (sameFile(target, this.specPath)) {
        throw new Error(
          "accompany draftTo must not be the source spec (the source is never written)",
        );
      }
      this.draftTo = target;
    }
  }

  /** The draft copy path (journal-relative, or the draftTo path). */
  get draftPath(): string | undefined {
    if (this.replacements === 0) return undefined;
    return this.draftTo ?? this.journal.resolve(DRAFT_FILE);
  }

  /** The run parked on a miss at `url`. A pending choice that missed again failed. */
  park(stepIndex: number, error: string, url: string): void {
    this.parkedUrl = url;
    const pending = this.pending;
    if (pending && pending.decision.stepIndex === stepIndex) {
      this.settle(false, error, url);
    }
  }

  /** The harness chose `locator` for the parked step. */
  choose(
    stepIndex: number,
    stepId: string,
    locator: Locator,
    snapshot: readonly SnapshotElement[] | undefined,
  ): void {
    const origin = this.origins.get(stepIndex);
    const decision: AccompanyDecision = {
      index: ++this.actions,
      stepId,
      stepIndex,
      locator: semanticLocator(locator, snapshot),
      ...(origin ? { origin } : {}),
    };
    this.decisions.push(decision);
    this.pending = { decision, url: this.parkedUrl, startedAt: Date.now() };
  }

  /** A step finished (runner listener). Settles the pending choice. */
  stepFinished(
    stepIndex: number,
    status: "passed" | "failed" | "skipped",
    error: string | undefined,
  ): void {
    const pending = this.pending;
    if (!pending || pending.decision.stepIndex !== stepIndex) return;
    this.settle(status === "passed", error, pending.url);
  }

  private settle(ok: boolean, error: string | undefined, url: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const { decision } = pending;
    decision.ok = ok;
    if (!ok && error) decision.error = this.journal.redactText(error);
    const ts = new Date().toISOString();
    this.journal.append({
      ts,
      type: "action.performed",
      index: decision.index,
      action: "choose",
      locator: decision.locator as Record<string, unknown>,
      ok,
      ...(decision.error ? { error: decision.error } : {}),
      // The page URL at the miss (the retry runs inside the runner).
      urlBefore: withoutQuery(this.journal.redactText(pending.url)),
      urlAfter: withoutQuery(this.journal.redactText(url)),
      durationMs: Math.max(0, Date.now() - pending.startedAt),
      stepId: decision.stepId,
    });
    if (!ok) return;
    const replacement =
      this.applyToDraft(decision) ?? this.replacementInAction(decision);
    if (!replacement) return;
    this.journal.append({
      ts,
      type: "step.recorded",
      index: decision.index,
      step: replacement,
      ...(decision.origin
        ? {
            origin: {
              file: decision.origin.file,
              stepIndex: decision.origin.stepIndex,
              stepId: decision.stepId,
            },
          }
        : {}),
    });
  }

  /** Patch the draft copy; returns the replacement step (placeholders kept). */
  private applyToDraft(
    decision: AccompanyDecision,
  ): Record<string, unknown> | undefined {
    const origin = decision.origin;
    const draft = this.draft;
    if (!origin || !draft || resolve(origin.file) !== this.specPath) {
      return undefined;
    }
    const steps = draft.get("steps", true);
    if (!isSeq(steps)) return undefined;
    const node = steps.items[origin.stepIndex];
    if (!isMap(node)) return undefined;
    // The raw node keeps `${secrets.X}` / `${vars.X}` as written; the
    // parsed step would carry resolved values.
    const raw = node.toJSON() as Step;
    const replaced = replaceStepLocator(raw, decision.locator) as Record<
      string,
      unknown
    >;
    steps.items[origin.stepIndex] = draft.createNode(replaced);
    this.replacements++;
    this.writeDraft();
    return replaced;
  }

  /**
   * The replacement for a step declared in an imported action: recorded in
   * the journal as a suggestion, the action file is left alone.
   */
  private replacementInAction(
    decision: AccompanyDecision,
  ): Record<string, unknown> | undefined {
    const origin = decision.origin;
    if (!origin) return undefined;
    try {
      const doc = parseDocument(readFileSync(origin.file, "utf8"));
      const steps = doc.get("steps", true);
      if (!isSeq(steps)) return undefined;
      const node = steps.items[origin.stepIndex];
      if (!isMap(node)) return undefined;
      return replaceStepLocator(
        node.toJSON() as Step,
        decision.locator,
      ) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private writeDraft(): void {
    if (!this.draft) return;
    // Redacted node by node: a known secret value is scrubbed, while the
    // spec's own placeholders (`?token=${vars.t}`, `Bearer ${env.X}`) and
    // formatting survive — a text pass would cut them and break the YAML.
    let redacted: Document;
    try {
      redacted = redactYamlDocument(this.draft, (value) =>
        this.journal.redactValue(value),
      );
    } catch {
      // Never write a copy that could not be redacted.
      return;
    }
    const text = [
      "# Cairntrace accompany DRAFT — the spec with the locators chosen during",
      `# accompany session ${this.journal.sessionId} applied (source: ${this.specPath}).`,
      "# Review the diff, then run it; the source spec was not modified.",
      String(redacted),
    ].join("\n");
    const written = this.journal.writeText(DRAFT_FILE, text, {
      preRedacted: true,
    });
    // Checked again at write time: the target may have become the source
    // (a link created since the session opened).
    if (this.draftTo && !sameFile(this.draftTo, this.specPath)) {
      try {
        mkdirSync(dirname(this.draftTo), { recursive: true });
        writeFileSync(this.draftTo, text, "utf8");
      } catch {
        // The journal copy remains.
      }
    }
    if (!written) return;
    this.journal.update({
      draftPath: this.draftTo ?? DRAFT_FILE,
      stepCount: this.replacements,
      actionCount: this.actions,
      lastActivityAt: new Date().toISOString(),
    });
    this.journal.append({
      ts: new Date().toISOString(),
      type: "draft.updated",
      path: DRAFT_FILE,
      steps: this.replacements,
    });
  }
}

/**
 * Whether two paths name one file: the same path, or (when both exist) the
 * same device + inode — a symlink, a hard link, or a path differing only in
 * case on a case-insensitive volume (the APFS default).
 */
function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    // A path that does not exist is not the (existing) source.
    return false;
  }
}

/**
 * A snapshot `@ref` is how agent-browser acts on the live page, but it cannot
 * replay: the draft records the element's role + accessible name instead
 * (with `nth` among identical peers).
 */
export function semanticLocator(
  locator: Locator,
  snapshot: readonly SnapshotElement[] | undefined,
): Locator {
  if (locator.by !== "selector" || !locator.selector.startsWith("@")) {
    return locator;
  }
  const ref = locator.selector.slice(1);
  const el = snapshot?.find((e) => e.ref === ref || e.ref === `@${ref}`);
  if (!el) return locator;
  const peers = (snapshot ?? []).filter(
    (e) => e.role === el.role && e.name === el.name,
  );
  const nth = peers.findIndex((e) => e.ref === el.ref);
  return {
    by: "role",
    role: el.role,
    ...(el.name ? { name: el.name } : {}),
    ...(peers.length > 1 && nth >= 0 ? { nth } : {}),
  } as Locator;
}
