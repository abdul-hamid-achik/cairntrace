import {
  BRIEF_RULES,
  BriefDocumentSchema,
  type BriefAction,
  type BriefDocument,
  type BriefSetup,
  type BriefStep,
  type BriefValue,
} from "../schema/brief.v1";
import type { StepResult } from "../schema/run.v1";
import {
  clickLocator,
  openPath,
  type ClickUntil,
  type Locator,
  type Outcome,
  type Spec,
  type Step,
  type WaitCondition,
} from "../schema/spec.v1";
import {
  isConsoleVerifier,
  isCountVerifier,
  isFileVerifier,
  isHttpJsonVerifier,
  isNetworkVerifier,
  isNoFailedRequestsVerifier,
  isNotTextVerifier,
  isProcessVerifier,
  isScriptVerifier,
  isTextVerifier,
  isUrlVerifier,
  isXlsxVerifier,
  type TextMatcher,
  type UrlMatcher,
} from "../schema/verifier.v1";
import { describeWaitUrl } from "../locators";
import { isSensitiveEnvKey } from "../artifacts/redaction";
import { parseTemplateValue } from "./templateValue";

export interface ExportBriefOptions {
  specPath?: string;
  fromRun?: { runId: string; runDir: string; steps: StepResult[] };
}

export function exportBrief(
  spec: Spec,
  opts: ExportBriefOptions = {},
): BriefDocument {
  const steps = spec.steps ?? [];
  const compiled: BriefStep[] = [];
  const secrets = new Set<string>();
  const skips: BriefDocument["coverage"]["skips"] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = briefStepFromSpecStep(steps[i]!, i);
    compiled.push(step);
    if (step.value?.kind === "secret") secrets.add(step.value.name);
    if (step.skip) {
      skips.push({
        kind: "step",
        id: step.id,
        reason: step.skip,
      });
    }
  }

  const outcomes = spec.outcomes.map((outcome) => {
    const doneWhen = summarizeVerifier(outcome);
    if (isNonUiOutcome(outcome)) {
      skips.push({
        kind: "outcome",
        id: outcome.id,
        reason: `${outcomeKind(outcome)} outcomes are machine-evaluated; use the description as the check`,
      });
    }
    return {
      id: outcome.id,
      description: outcome.description,
      doneWhen,
    };
  });

  const stepsBriefed = compiled.filter(
    (s) => s.action !== "machine" && s.skip === undefined,
  ).length;

  let doc: BriefDocument = BriefDocumentSchema.parse({
    $schema: "urn:cairntrace.dev:brief:v1",
    version: "1",
    spec: {
      name: spec.name,
      path: opts.specPath ?? spec.name,
      ...(spec.contractHash ? { contractHash: spec.contractHash } : {}),
    },
    intent: spec.intent,
    setup: deriveSetup(spec),
    rules: [...BRIEF_RULES],
    outcomes,
    steps: compiled,
    requiredSecrets: [...secrets],
    coverage: {
      steps: steps.length,
      stepsBriefed,
      skips,
    },
  });

  if (opts.fromRun) {
    doc = applyResolvedFromRun(doc, opts.fromRun.steps);
    doc = BriefDocumentSchema.parse({
      ...doc,
      fromRun: { runId: opts.fromRun.runId, runDir: opts.fromRun.runDir },
    });
  }
  return doc;
}

export function applyResolvedFromRun(
  doc: BriefDocument,
  steps: StepResult[],
): BriefDocument {
  const byId = new Map(
    steps.filter((s) => s.resolved).map((s) => [s.id, s.resolved!] as const),
  );
  return BriefDocumentSchema.parse({
    ...doc,
    steps: doc.steps.map((step) => {
      const resolved = byId.get(step.id);
      if (!resolved) return step;
      return {
        ...step,
        seenLocally: {
          role: resolved.role,
          ...(resolved.name ? { name: resolved.name } : {}),
        },
      };
    }),
  });
}

export function isBriefableStep(step: Step): boolean {
  return (
    "click" in step ||
    "hover" in step ||
    "focus" in step ||
    "fill" in step ||
    "type" in step ||
    "select" in step ||
    "upload" in step ||
    "download" in step ||
    "press" in step ||
    "scroll" in step ||
    "wait" in step ||
    "batch" in step
  );
}

export function briefStepFromSpecStep(step: Step, index: number): BriefStep {
  const id = step.id ?? `step_${index + 1}`;
  const built = compileStep(step, id);
  if (step.when) {
    return {
      ...built,
      goal: `Only if ${describeWhen(step.when)}: ${built.goal}`,
    };
  }
  return built;
}

function compileStep(step: Step, id: string): BriefStep {
  if ("open" in step) {
    const target = openPath(step);
    return {
      id,
      action: "open",
      goal: `Open ${target}`,
      approximations: [`navigate to ${target}`],
      doneWhen: "the document is loaded",
    };
  }
  if ("click" in step) {
    const locator = clickLocator(step);
    return {
      id,
      action: "click",
      goal: `Click ${locatorNoun(locator)}`,
      authored: locator,
      approximations: approximationsFor(locator),
      doneWhen: describeClickUntil(step.click.until),
      ...(locator.by === "selector" ? { brittle: true } : {}),
    };
  }
  if ("hover" in step) {
    return locatorAction(
      id,
      "hover",
      step.hover,
      `Hover ${locatorNoun(step.hover)}`,
      "the hover target is visible",
    );
  }
  if ("focus" in step) {
    return locatorAction(
      id,
      "focus",
      step.focus,
      `Focus ${locatorNoun(step.focus)}`,
      "the control is focused",
    );
  }
  if ("fill" in step) {
    const { value, ...loc } = step.fill;
    return inputAction(id, "fill", loc as Locator, value, "fill");
  }
  if ("type" in step) {
    const { value, delayMs: _delayMs, ...loc } = step.type;
    return inputAction(id, "type", loc as Locator, value, "type into");
  }
  if ("select" in step) {
    const { value, label, ...loc } = step.select;
    const choice = value !== undefined ? value : (label as string);
    const briefValue = valueFromTemplate(choice);
    return {
      id,
      action: "select",
      goal: `Choose ${valueLabel(briefValue)} in ${locatorNoun(loc as Locator)}`,
      value: briefValue,
      authored: loc as Locator,
      approximations: approximationsFor(loc as Locator),
      doneWhen: `the selected option is ${valueLabel(briefValue)}`,
      ...((loc as Locator).by === "selector" ? { brittle: true } : {}),
    };
  }
  if ("upload" in step) {
    const { path, ...loc } = step.upload;
    return {
      id,
      action: "upload",
      goal: `Upload ${path} via ${locatorNoun(loc as Locator)}`,
      authored: loc as Locator,
      approximations: approximationsFor(loc as Locator),
      doneWhen: "the file is attached",
      ...((loc as Locator).by === "selector" ? { brittle: true } : {}),
    };
  }
  if ("download" in step) {
    const {
      saveAs,
      assign: _assign,
      timeoutMs: _timeoutMs,
      ...loc
    } = step.download;
    return {
      id,
      action: "download",
      goal: `Download via ${locatorNoun(loc as Locator)} and save as ${saveAs}`,
      authored: loc as Locator,
      approximations: approximationsFor(loc as Locator),
      doneWhen: `the file is saved as ${saveAs}`,
      ...((loc as Locator).by === "selector" ? { brittle: true } : {}),
    };
  }
  if ("wait" in step) {
    return {
      id,
      action: "wait",
      goal: describeWait(step.wait),
      approximations: waitApproximations(step.wait),
      doneWhen: describeWait(step.wait),
    };
  }
  if ("press" in step) {
    return {
      id,
      action: "press",
      goal: step.target
        ? `Press ${step.press} on ${locatorNoun(step.target)}`
        : `Press ${step.press}`,
      ...(step.target ? { authored: step.target } : {}),
      approximations: step.target
        ? approximationsFor(step.target)
        : [`press key ${step.press}`],
      doneWhen: step.until
        ? describeClickUntil(step.until)
        : `key ${step.press} was sent`,
      ...(step.target?.by === "selector" ? { brittle: true } : {}),
    };
  }
  if ("scroll" in step) {
    if ("to" in step.scroll) {
      return locatorAction(
        id,
        "scroll",
        step.scroll.to,
        `Scroll ${locatorNoun(step.scroll.to)} into view`,
        "the target is in view",
      );
    }
    return {
      id,
      action: "scroll",
      goal: `Scroll ${step.scroll.direction}${
        step.scroll.px ? ` by ${step.scroll.px}px` : ""
      }`,
      approximations: [`scroll ${step.scroll.direction}`],
      doneWhen: "the page has scrolled",
    };
  }
  if ("batch" in step) {
    return {
      id,
      action: "batch",
      goal: "run selector-only sub-steps in one invocation so hover/focus state survives",
      approximations: [
        "keep hover/focus state; do not take a snapshot between sub-steps",
        "only by: selector is legal inside batch",
      ],
      doneWhen: "every sub-step succeeded without dropping hover state",
      brittle: true,
    };
  }
  if ("eval" in step) {
    return machine(
      id,
      "eval is machine-only; cairntrace runs it, the harness does not reimplement it in the page",
    );
  }
  if ("request" in step) {
    return machine(
      id,
      "request is machine-only; cairntrace runs the authenticated call",
    );
  }
  if ("transform" in step) {
    return machine(id, "transform is machine-only");
  }
  if ("monitor" in step) {
    return machine(id, "monitor is machine-only");
  }
  if ("snapshot" in step) {
    return machine(id, "snapshot is capture-only");
  }
  if ("use" in step) {
    return machine(id, "use: should be expanded by parseSpec before export");
  }
  return machine(id, "unrecognized step");
}

function locatorAction(
  id: string,
  action: BriefAction,
  locator: Locator,
  goal: string,
  doneWhen: string,
): BriefStep {
  return {
    id,
    action,
    goal,
    authored: locator,
    approximations: approximationsFor(locator),
    doneWhen,
    ...(locator.by === "selector" ? { brittle: true } : {}),
  };
}

function inputAction(
  id: string,
  action: "fill" | "type",
  locator: Locator,
  raw: string,
  verb: string,
): BriefStep {
  const value = valueFromTemplate(raw);
  return {
    id,
    action,
    goal: `${
      verb === "fill" ? "Fill" : "Type into"
    } ${locatorNoun(locator)} with ${valueLabel(value)}`,
    value,
    authored: locator,
    approximations: approximationsFor(locator),
    doneWhen: `the live control value equals ${valueLabel(value)}`,
    ...(locator.by === "selector" ? { brittle: true } : {}),
  };
}

function machine(id: string, skip: string): BriefStep {
  return {
    id,
    action: "machine",
    goal: skip,
    approximations: [skip],
    doneWhen: "cairntrace finished the machine-only step",
    skip,
  };
}

export function approximationsFor(locator: Locator): string[] {
  const out: string[] = [];
  if (locator.by === "role") {
    out.push(
      locator.name
        ? `role ${locator.role} named "${locator.name}"`
        : `role ${locator.role}`,
    );
    if (locator.name) out.push(`visible text "${locator.name}"`);
  } else if (locator.by === "label") {
    out.push(`control labelled "${locator.name}"`);
    out.push(`textbox named "${locator.name}"`);
  } else if (locator.by === "text") {
    out.push(`visible text "${locator.text}"`);
  } else if (locator.by === "testid") {
    out.push(`testid ${locator.testid}`);
  } else {
    out.push(`CSS ${locator.selector} (brittle)`);
    const sel = locator.selector.toLowerCase();
    for (const word of ["email", "password", "search", "submit"] as const) {
      if (sel.includes(word)) {
        out.push(`control that looks like ${word}`);
      }
    }
  }
  if (locator.near) out.push(`prefer the match nearest "${locator.near}"`);
  if (locator.hasText)
    out.push(`keep the match whose text contains "${locator.hasText}"`);
  return out;
}

export function valueFromTemplate(raw: string): BriefValue {
  const parts = parseTemplateValue(raw);
  const env = parts.find((p) => p.kind === "env");
  if (env && env.kind === "env") return { kind: "secret", name: env.name };
  return { kind: "literal", text: raw };
}

/** Env keys whose values must not appear in a compiled brief. */
export function isBriefSecretEnvKey(key: string): boolean {
  return isSensitiveEnvKey(key) || isVaultShapedEnvKey(key);
}

function isVaultShapedEnvKey(key: string): boolean {
  return /(?:database|mongo|postgres|mysql|redis|amqp|kafka|s3|blob).*(?:url|uri|dsn)|(?:^|_)(?:dsn|connection_string)$/i.test(
    key,
  );
}

export function secretNameByValue(
  env: Record<string, string | undefined>,
  knownSecretValues: Iterable<string> = [],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value && isBriefSecretEnvKey(key)) names.set(value, key);
  }
  for (const value of knownSecretValues) {
    if (value && !names.has(value)) names.set(value, "SECRET");
  }
  return names;
}

export function redactBriefStep(
  step: BriefStep,
  env: Record<string, string | undefined>,
  knownSecretValues: Iterable<string> = [],
): BriefStep {
  const names = secretNameByValue(env, knownSecretValues);
  if (names.size === 0) return scrubSentinelsInStep(step);
  const scrub = (text: string): string => {
    let out = text;
    for (const [value, name] of names) {
      if (value.length === 0) continue;
      out = out.split(value).join(`secret ${name}`);
    }
    return out;
  };
  let value = step.value;
  if (value?.kind === "literal") {
    const secretName = names.get(value.text);
    if (secretName) value = { kind: "secret", name: secretName };
  }
  return scrubSentinelsInStep({
    ...step,
    ...(value ? { value } : {}),
    goal: scrub(step.goal),
    doneWhen: scrub(step.doneWhen),
    approximations: step.approximations.map(scrub),
  });
}

const SECRET_SENTINEL_RE = /__CAIRN_SECRET_REF__([A-Za-z0-9_]+)__/g;

function replaceSecretSentinels(text: string): string {
  return text.replace(
    SECRET_SENTINEL_RE,
    (_m, name: string) => `secret ${name}`,
  );
}

function scrubSentinelsInStep(step: BriefStep): BriefStep {
  let value = step.value;
  if (value?.kind === "literal") {
    const only = parseTemplateValue(value.text);
    const env = only.find((p) => p.kind === "env");
    if (env && env.kind === "env" && only.every((p) => p.kind === "env")) {
      value = { kind: "secret", name: env.name };
    } else if (/__CAIRN_SECRET_REF__[A-Za-z0-9_]+__/.test(value.text)) {
      value = { kind: "literal", text: replaceSecretSentinels(value.text) };
    }
  }
  return {
    ...step,
    ...(value ? { value } : {}),
    goal: replaceSecretSentinels(step.goal),
    doneWhen: replaceSecretSentinels(step.doneWhen),
    approximations: step.approximations.map(replaceSecretSentinels),
  };
}

export function redactBriefDocument(
  doc: BriefDocument,
  env: Record<string, string | undefined>,
  knownSecretValues: Iterable<string> = [],
): BriefDocument {
  const steps = doc.steps.map((step) =>
    redactBriefStep(step, env, knownSecretValues),
  );
  const secrets = new Set(doc.requiredSecrets);
  for (const step of steps) {
    if (step.value?.kind === "secret") secrets.add(step.value.name);
  }
  return BriefDocumentSchema.parse({
    ...doc,
    steps,
    requiredSecrets: [...secrets],
  });
}

function valueLabel(value: BriefValue): string {
  return value.kind === "secret" ? `secret ${value.name}` : value.text;
}

export function locatorNoun(locator: Locator): string {
  if (locator.by === "role") {
    return locator.name
      ? `the ${locator.role} named "${locator.name}"`
      : `a ${locator.role}`;
  }
  if (locator.by === "label") return `the control labelled "${locator.name}"`;
  if (locator.by === "text")
    return `the control whose text is "${locator.text}"`;
  if (locator.by === "testid")
    return `the control with testid ${locator.testid}`;
  return `the control matching ${locator.selector}`;
}

export function deriveSetup(spec: Spec): BriefSetup {
  const environment = spec.environment;
  if (spec.coldStart === "guest") {
    return {
      coldStart: "guest",
      detail: "public / sessionless flow",
      ...(environment ? { environment } : {}),
    };
  }
  if (spec.session?.resume) {
    return {
      coldStart: "checkpoint",
      detail: `resume checkpoint ${spec.session.resume}`,
      ...(environment ? { environment } : {}),
    };
  }
  if (spec.imports && spec.imports.length > 0) {
    return {
      coldStart: "imports",
      detail: spec.imports.join(", "),
      ...(environment ? { environment } : {}),
    };
  }
  const commands = spec.preconditions?.commands ?? [];
  if (commands.length > 0) {
    return {
      coldStart: "preconditions",
      detail: commands.map((c) => c.name ?? c.run).join("; "),
      ...(environment ? { environment } : {}),
    };
  }
  return {
    coldStart: "unspecified",
    ...(environment ? { environment } : {}),
  };
}

export function describeLocator(locator: Locator): string {
  if (locator.by === "role") {
    return locator.name
      ? `role=${locator.role} name="${locator.name}"`
      : `role=${locator.role}`;
  }
  if (locator.by === "label") return `label "${locator.name}"`;
  if (locator.by === "text") return `text "${locator.text}"`;
  if (locator.by === "testid") return `testid ${locator.testid}`;
  return `selector ${locator.selector}`;
}

function describeClickUntil(until: ClickUntil | undefined): string {
  if (!until) return "the authored effect is visible";
  if ("selectorGone" in until) return `selector ${until.selectorGone} is gone`;
  if ("selector" in until) return `selector ${until.selector} is present`;
  if ("text" in until) return `text "${until.text}" is visible`;
  if ("notText" in until) return `text "${until.notText}" is gone`;
  return `url ${describeWaitUrl(until.url)}`;
}

function describeWait(wait: WaitCondition): string {
  if ("ms" in wait) return `Wait ${wait.ms}ms`;
  if ("text" in wait) return `Wait until the page shows "${wait.text}"`;
  if ("notText" in wait) return `Wait until "${wait.notText}" is gone`;
  if ("load" in wait) return `Wait for load state ${wait.load}`;
  if ("selector" in wait) {
    return `Wait for selector ${wait.selector}${
      wait.state ? ` (${wait.state})` : ""
    }`;
  }
  if ("value" in wait) {
    const { equals, ...loc } = wait.value;
    return `Wait until ${locatorNoun(loc as Locator)} equals ${equals}`;
  }
  return `Wait until the URL ${describeWaitUrl(wait.url)}`;
}

function waitApproximations(wait: WaitCondition): string[] {
  if ("text" in wait) return [`visible text "${wait.text}"`];
  if ("notText" in wait) return [`text "${wait.notText}" is gone`];
  if ("selector" in wait) return [`CSS ${wait.selector} (brittle)`];
  if ("value" in wait) {
    const { equals: _equals, ...loc } = wait.value;
    return approximationsFor(loc as Locator);
  }
  if ("url" in wait) return [`url ${describeWaitUrl(wait.url)}`];
  if ("load" in wait) return [`load ${wait.load}`];
  return [`pause ${wait.ms}ms`];
}

function describeWhen(when: Step["when"]): string {
  if (typeof when === "string") return when;
  if (!when) return "the gate holds";
  const parts: string[] = [];
  if (when.urlContains) parts.push(`url contains ${when.urlContains}`);
  if (when.urlNotContains)
    parts.push(`url does not contain ${when.urlNotContains}`);
  if (when.urlMatches) parts.push(`url matches ${when.urlMatches}`);
  if (when.text) parts.push(`text "${when.text}" is visible`);
  if (when.notText) parts.push(`text "${when.notText}" is gone`);
  if (when.selector) parts.push(`selector ${when.selector} exists`);
  if (when.notSelector) parts.push(`selector ${when.notSelector} is absent`);
  if (when.hasText) parts.push(`hasText ${when.hasText}`);
  return parts.join(" and ") || "the gate holds";
}

export function summarizeVerifier(outcome: Outcome): string {
  const v = outcome.verify;
  if (isTextVerifier(v)) return `text ${summarizeText(v.text)}`;
  if (isNotTextVerifier(v)) return `notText ${summarizeText(v.notText)}`;
  if (isUrlVerifier(v)) return `url ${summarizeUrl(v.url)}`;
  if (isNetworkVerifier(v)) {
    return `network ${v.network.method ?? "ANY"} ${v.network.urlContains}`;
  }
  if (isNoFailedRequestsVerifier(v)) {
    return `no failed requests matching ${v.noFailedRequests.urlContains}`;
  }
  if (isConsoleVerifier(v)) {
    return `console errorsMax ${v.console.errorsMax}`;
  }
  if (isCountVerifier(v)) {
    const target = v.count.role
      ? `role ${v.count.role}`
      : `selector ${v.count.selector}`;
    if (v.count.equals !== undefined)
      return `count ${target} equals ${v.count.equals}`;
    if (v.count.atLeast !== undefined)
      return `count ${target} atLeast ${v.count.atLeast}`;
    if (v.count.atMost !== undefined)
      return `count ${target} atMost ${v.count.atMost}`;
    return `count ${target} between ${v.count.between?.[0]}-${v.count.between?.[1]}`;
  }
  if (isXlsxVerifier(v)) return outcome.description;
  if (isFileVerifier(v)) return `file ${v.file.glob} exists`;
  if (isHttpJsonVerifier(v))
    return `httpJson ${v.httpJson.url} ${v.httpJson.jsonPath}`;
  if (isScriptVerifier(v) || isProcessVerifier(v)) return outcome.description;
  return outcome.description;
}

function summarizeText(m: TextMatcher): string {
  if (m.equals !== undefined) return `equals ${JSON.stringify(m.equals)}`;
  if (m.contains !== undefined) return `contains ${JSON.stringify(m.contains)}`;
  return `matches /${m.matches}/`;
}

function summarizeUrl(m: UrlMatcher): string {
  if (m.equals !== undefined) return `equals ${m.equals}`;
  if (m.startsWith !== undefined) return `startsWith ${m.startsWith}`;
  if (m.endsWith !== undefined) return `endsWith ${m.endsWith}`;
  return `matches /${m.matches}/`;
}

function isNonUiOutcome(outcome: Outcome): boolean {
  const v = outcome.verify;
  return (
    isScriptVerifier(v) ||
    isProcessVerifier(v) ||
    isXlsxVerifier(v) ||
    isHttpJsonVerifier(v)
  );
}

function outcomeKind(outcome: Outcome): string {
  const v = outcome.verify;
  if (isScriptVerifier(v)) return "script";
  if (isProcessVerifier(v)) return "process";
  if (isXlsxVerifier(v)) return "xlsx";
  if (isHttpJsonVerifier(v)) return "httpJson";
  return "outcome";
}

export function renderBriefMarkdown(doc: BriefDocument): string {
  const lines: string[] = [
    `# Brief: ${doc.spec.name}`,
    "",
    "Contract (do not change these):",
    `- Intent: ${doc.intent}`,
    ...doc.outcomes.map((o) => `- ${o.id}: ${o.description}`),
    "",
    ...(doc.setup
      ? [
          "Setup:",
          ...(doc.setup.environment
            ? [`- Environment: ${doc.setup.environment}`]
            : []),
          `- Cold start: ${doc.setup.coldStart}${
            doc.setup.detail ? ` (${doc.setup.detail})` : ""
          }`,
          "",
        ]
      : []),
    "Rules:",
    ...doc.rules.map((r) => `- ${r}`),
    "",
  ];
  if (doc.requiredSecrets.length > 0) {
    lines.push(
      "Required secrets (do not inline):",
      ...doc.requiredSecrets.map((s) => `- ${s}`),
      "",
    );
  }
  if (doc.fromRun) {
    lines.push(`From run: ${doc.fromRun.runId}`, "");
  }
  for (const step of doc.steps) {
    lines.push(...renderBriefStepMarkdownLines(step), "");
  }
  if (doc.coverage.skips.length > 0) {
    lines.push(
      "Coverage skips:",
      ...doc.coverage.skips.map(
        (s) => `- ${s.kind}${s.id ? ` ${s.id}` : ""}: ${s.reason}`,
      ),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderBriefStepMarkdown(step: BriefStep): string {
  return `${renderBriefStepMarkdownLines(step).join("\n")}\n`;
}

function renderBriefStepMarkdownLines(step: BriefStep): string[] {
  const lines = [
    `## Step ${step.id}`,
    `Action: ${step.action}`,
    `Goal: ${step.goal}`,
  ];
  if (step.value) {
    lines.push(
      step.value.kind === "secret"
        ? `Value: use secret ${step.value.name} from the environment`
        : `Value: ${step.value.text}`,
    );
  }
  if (step.authored) {
    lines.push(`Authored: ${describeLocator(step.authored)}`);
  }
  if (step.seenLocally) {
    lines.push(
      `Seen locally: role=${step.seenLocally.role}${
        step.seenLocally.name ? ` name="${step.seenLocally.name}"` : ""
      }`,
    );
  }
  if (step.approximations.length > 0) {
    lines.push("Search approximations (try in order):");
    step.approximations.forEach((a, i) => {
      lines.push(`${i + 1}. ${a}`);
    });
  }
  lines.push(`Done when: ${step.doneWhen}`);
  if (step.brittle) lines.push("Brittle: authored selector is a stale hint");
  if (step.skip) lines.push(`Skip: ${step.skip}`);
  return lines;
}
