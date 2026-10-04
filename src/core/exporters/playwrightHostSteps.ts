/**
 * Export-v2 step renderers: the primitives that need a host process or the
 * page probe rather than a plain Playwright action.
 *
 *  - `run:` steps and the spec `teardown:` (through the bounded command
 *    helper; only with `--preconditions inline|global`);
 *  - `capture` steps (the same in-page probe `cairn run` reads);
 *  - polled outcomes (`poll:` → `expect(...).toPass` / `cairnPoll`);
 *  - the fixture / gate wiring a `global` export hands to the tests.
 *
 * Everything here emits statements through the same IR as the rest of the
 * exporter and keeps command text, secrets and environment VALUES out of the
 * generated code: late-bound parts are `process.env.X` reads at run time.
 */
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { CaptureStep, RunStep, Step } from "../schema/spec.v1";
import type { Poll } from "../schema/verifier.v1";
import { stepFileScopeAt } from "../runner/stepFiles";
import { realpathNearest } from "./exportManifest";
import { block, comment, ifElse, raw, tryCatch, type Stmt } from "./codegen";
import {
  setTimeoutStmts,
  type PlaywrightTimeoutBudget,
} from "./playwrightTimeout";
import { redactOption, simpleCommandWords } from "./commandRuntime";
import {
  addRisk,
  declareBinding,
  oneLine,
  publishBinding,
  skipStmt,
  stepFilePath,
  wantsBinding,
  type EmitCtx,
  type Rendered,
} from "./playwrightExporter";
import {
  bindingIdent,
  emitStr,
  emitValue,
  runtimeRefKey,
} from "./templateValue";

/** The default budget of a `run:` step (`DEFAULT_RUN_STEP_TIMEOUT_MS`). */
export const RUN_STEP_DEFAULT_TIMEOUT_MS = 120_000;
/** The default wait of a `capture` step (`DEFAULT_TIMEOUT_MS` of the runner). */
export const CAPTURE_DEFAULT_TIMEOUT_MS = 5_000;

/** Mark which command-helper pieces a unit calls (for imports / inlining). */
export function markCommand(
  ctx: EmitCtx,
  ...parts: Array<"json" | "context" | "precondition">
): void {
  const used = (ctx.usedCommand ??= { command: true });
  used.command = true;
  for (const part of parts) used[part] = true;
}

function markNodePath(ctx: EmitCtx, ...names: Array<"dirname" | "resolve">) {
  const used = (ctx.usedNodePath ??= new Set());
  for (const name of names) used.add(name);
}

/** Directory of the file that declares the step being rendered. */
export function declaringDir(ctx: EmitCtx): string {
  if (ctx.stepOrigins && ctx.stepIndex !== undefined) {
    return stepFileScopeAt(ctx.stepOrigins, ctx.stepPath ?? ctx.stepIndex)
      .declaringDir;
  }
  return ctx.specDir ?? process.cwd();
}

/**
 * A machine-local ABSOLUTE source path (a precondition `cwd`, a `run.node`
 * script) as an expression resolved at test run time: `cairnProjectPath(rel)`
 * in a project export (relocatable through `CAIRN_PROJECT_ROOT`), relative
 * to the running spec file in a standalone one, else the baked absolute path
 * (reported as an `absolutePath` risk).
 */
export function hostPathExpr(abs: string, ctx: EmitCtx): string {
  if (ctx.projectRoot) {
    const rel = relative(ctx.projectRoot, realpathNearest(abs))
      .split(sep)
      .join("/");
    if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) {
      return rel === ""
        ? `cairnProjectPath()`
        : `cairnProjectPath(${JSON.stringify(rel)})`;
    }
    addRisk(
      ctx,
      "absolutePath",
      `host path ${abs} is outside the project root; the test reads the machine-local path`,
    );
    return JSON.stringify(abs);
  }
  if (ctx.outDir) {
    ctx.usesTestInfo = true;
    markNodePath(ctx, "dirname", "resolve");
    const rel = relative(ctx.outDir, abs).split(sep).join("/");
    return `resolve(dirname(test.info().file), ${JSON.stringify(rel === "" ? "." : rel)})`;
  }
  addRisk(
    ctx,
    "absolutePath",
    `host path ${abs} is baked as a machine-local absolute path (no output location to make it relative to)`,
  );
  return JSON.stringify(abs);
}

/** `String(<value>)` entries of an authored `env:` map. */
function envMapExpr(
  env: Record<string, string | number | boolean> | undefined,
  ctx: EmitCtx,
): string | undefined {
  if (env === undefined || Object.keys(env).length === 0) return undefined;
  const entries = Object.entries(env).map(
    ([key, value]) =>
      `${JSON.stringify(key)}: String(${emitValue(value, ctx.usage)})`,
  );
  return `{ ${entries.join(", ")} }`;
}

/** Label of a run step in errors: never the command text (it may hold secrets). */
function runLabel(step: RunStep): string {
  const run = typeof step.run === "string" ? { shell: step.run } : step.run;
  const what = run.node !== undefined ? `node ${basename(run.node)}` : "shell";
  return "assign" in run && run.assign
    ? `run ${what} → ${run.assign}`
    : `run ${what}`;
}

/**
 * A `run:` step as a bounded host command. A `node:` script is spawned
 * without a shell; a shell command that needs none is spawned as an argument
 * vector, anything else runs through `/bin/sh -c` like `cairn run`. `assign`
 * binds the last stdout line (JSON) for later `${runs.<assign>…}` splices.
 */
export function renderRunStep(step: RunStep, ctx: EmitCtx): Rendered {
  const run = typeof step.run === "string" ? { shell: step.run } : step.run;
  const options = ctx.runStepOptions;
  const timeoutMs =
    ("timeoutMs" in run ? run.timeoutMs : undefined) ??
    RUN_STEP_DEFAULT_TIMEOUT_MS;
  const declDir = declaringDir(ctx);
  const authoredCwd = "cwd" in run ? run.cwd : undefined;
  const cwdAbs =
    authoredCwd === undefined
      ? declDir
      : isAbsolute(authoredCwd)
        ? authoredCwd
        : resolve(declDir, authoredCwd);
  const args = ("args" in run ? (run.args ?? []) : []).map(String);
  const label = runLabel(step);

  let command: string;
  const extra: string[] = [];
  if ("node" in run && run.node !== undefined) {
    const script = stepFilePath(run.node, ctx, "run.node");
    const words = args.map((arg) => emitStr(arg, ctx.usage));
    command = `{ argv: ["node", ${[hostPathExpr(script, ctx), ...words].join(", ")}] }`;
  } else {
    const shell = (run as { shell: string }).shell;
    const words = args.length === 0 ? simpleCommandWords(shell) : undefined;
    if (words) {
      command = `{ argv: [${words.map((word) => emitStr(word, ctx.usage)).join(", ")}] }`;
    } else {
      command = emitStr(shell, ctx.usage);
      if (args.length > 0) {
        extra.push(
          `args: [${args.map((arg) => emitStr(arg, ctx.usage)).join(", ")}]`,
        );
      }
    }
  }
  const env = envMapExpr("env" in run ? run.env : undefined, ctx);
  if (env) extra.push(`env: ${env}`);
  const redact = redactOption(
    "shell" in run ? run.shell : undefined,
    args,
    "env" in run ? run.env : undefined,
  );
  if (redact) extra.push(redact);

  ctx.usage.runToken = true;
  ctx.usesTestInfo = true;
  markCommand(ctx, "context");
  const context = `cairnTestContext(test.info(), RUN_TOKEN${
    options?.statusVar ? `, ${options.statusVar}` : ""
  })`;
  const timeout = options?.deadlineVar
    ? `Math.max(1, Math.min(${timeoutMs}, ${options.deadlineVar} - Date.now()))`
    : String(timeoutMs);

  const assign = "assign" in run ? run.assign : undefined;
  const key = assign ? runtimeRefKey("runs", assign) : undefined;
  const bindIdent =
    key && wantsBinding(ctx, key)
      ? declareBinding(ctx, key, bindingIdent("cairnRuns", assign!))
      : undefined;
  const callOptions = [
    `cwd: ${hostPathExpr(cwdAbs, ctx)}`,
    `timeoutMs: ${timeout}`,
    `label: ${JSON.stringify(label)}`,
    `context: ${context}`,
    ...(assign ? [`capture: true`] : []),
    ...extra,
  ].join(", ");
  const call = `await cairnCommand(${command}, { ${callOptions} })`;
  let stmt: string;
  if (assign) {
    markCommand(ctx, "json");
    const parsed = `cairnLastJson(${call}, ${JSON.stringify(label)})`;
    stmt = bindIdent ? `${bindIdent} = ${parsed};` : `${parsed};`;
  } else {
    stmt = `${call};`;
  }
  if (key && bindIdent) publishBinding(ctx, key, bindIdent);
  return { stmts: [raw(stmt)], exported: true };
}

/** One `capture` step: the page probe, retried until the target resolves. */
export function renderCaptureStep(step: CaptureStep, ctx: EmitCtx): Rendered {
  const c = step.capture;
  const kind =
    c.text !== undefined
      ? "text"
      : c.value !== undefined
        ? "value"
        : c.attribute !== undefined
          ? "attribute"
          : "table";
  const target = (c.text ?? c.value ?? c.attribute ?? c.table) as Record<
    string,
    unknown
  >;
  const { attributeName, ...locatorFields } = target;
  const semantic =
    locatorFields.by === "role" ||
    locatorFields.by === "label" ||
    locatorFields.by === "text";
  const includeHidden = !semantic || locatorFields.visible === false;
  (ctx.usedProbe ??= {}).capture = true;
  const key = runtimeRefKey("captures", c.assign);
  const bindIdent = wantsBinding(ctx, key)
    ? declareBinding(ctx, key, bindingIdent("cairnCaptures", c.assign))
    : undefined;
  const options = [
    `timeoutMs: ${c.timeoutMs ?? CAPTURE_DEFAULT_TIMEOUT_MS}`,
    `includeHidden: ${includeHidden}`,
    ...(typeof attributeName === "string"
      ? [`attribute: ${emitStr(attributeName, ctx.usage)}`]
      : []),
    ...(ctx.testIdAttribute
      ? [`testIdAttribute: ${JSON.stringify(ctx.testIdAttribute)}`]
      : []),
  ].join(", ");
  const call = `await cairnCapture(page, ${JSON.stringify(kind)}, ${emitValue(locatorFields, ctx.usage)}, { ${options} });`;
  if (bindIdent) publishBinding(ctx, key, bindIdent);
  return {
    stmts: [raw(bindIdent ? `${bindIdent} = ${call}` : call)],
    exported: true,
  };
}

/** The reason a hard skip names when a run step cannot be exported. */
export function legacyRunSkip(step: RunStep, ctx: EmitCtx): Rendered {
  // The command text stays out of the generated code and the report: its
  // substituted placeholders may hold secrets (as in run-step events).
  const run = typeof step.run === "string" ? { shell: step.run } : step.run;
  const target =
    "node" in run && run.node !== undefined
      ? `node ${basename(run.node)}`
      : "shell command";
  const assign = "assign" in run ? run.assign : undefined;
  return skipStmt(
    ctx,
    "step",
    `run step not exported (${target}): host commands export only with --preconditions inline|global${
      assign ? `; later \${runs.${assign}…} references stay unresolved` : ""
    }`,
    `run step (${target}) skipped — a host command; export with --preconditions inline|global or run it with cairn run`,
    step.id,
  );
}

/* ----- teardown ----- */

export interface TeardownPlan {
  steps: Step[];
  failRun: boolean;
  timeoutMs: number;
}

/**
 * The spec `teardown:` as `finally` semantics: after the steps and outcomes
 * on every exit path of the test body, each item in order, each in its own
 * try/catch so a failing item never blocks the next. A failed item is
 * reported (a `teardown-failed` annotation + a warning) and keeps the test's
 * verdict, unless `failRun: true`, which fails a passed test after the whole
 * teardown ran. The budget of the whole teardown is `timeoutMs`; an item that
 * starts past it is reported, not run. A test timeout or a failed
 * `beforeAll` precondition can still skip the `finally`: cairn's SIGINT /
 * early-stop teardown paths have no Playwright equivalent.
 */
export function renderTeardownFinally(
  plan: TeardownPlan,
  ctx: EmitCtx,
  renderItem: (step: Step, index: number) => Rendered,
): Stmt[] {
  const total = plan.steps.length;
  const items: Stmt[] = [];
  const previous = ctx.runStepOptions;
  ctx.runStepOptions = {
    statusVar: "cairnRunStatus",
    deadlineVar: "cairnTeardownDeadline",
  };
  const savedIndex = ctx.stepIndex;
  const savedWrap = ctx.wrapSteps;
  delete ctx.stepIndex;
  // Each item gets ONE `teardown: <id>` test.step, not the usual per-step one.
  ctx.wrapSteps = false;
  try {
    plan.steps.forEach((step, index) => {
      const id = oneLine(step.id ?? `teardown_${index + 1}`);
      const rendered = renderItem(step, index);
      const wrapped = savedWrap
        ? [
            block(
              `await test.step(${JSON.stringify(`teardown: ${id}`)}, async () => {`,
              rendered.stmts.length > 0 ? rendered.stmts : [comment("no-op")],
              `});`,
            ),
          ]
        : rendered.stmts;
      items.push(
        comment(`teardown ${index + 1}/${total}: ${id}`),
        ifElse(
          `Date.now() >= cairnTeardownDeadline`,
          [
            raw(
              `cairnTeardownErrors.push(${JSON.stringify(`${id}: teardown budget of ${plan.timeoutMs}ms exhausted`)});`,
            ),
          ],
          [
            tryCatch(wrapped, "error", [
              raw(
                `cairnTeardownErrors.push(${JSON.stringify(`${id}: `)} + (error instanceof Error ? error.message : String(error)));`,
              ),
            ]),
          ],
        ),
      );
    });
  } finally {
    if (savedWrap !== undefined) ctx.wrapSteps = savedWrap;
    else delete ctx.wrapSteps;
    if (savedIndex !== undefined) ctx.stepIndex = savedIndex;
    if (previous) ctx.runStepOptions = previous;
    else delete ctx.runStepOptions;
  }
  ctx.usesTestInfo = true;
  return [
    block(`finally {`, [
      comment(
        `spec teardown: runs on every exit path (CAIRN_RUN_STATUS = cairnRunStatus)`,
      ),
      raw(`const cairnTeardownDeadline = Date.now() + ${plan.timeoutMs};`),
      raw(
        `const cairnTeardownErrors${
          ctx.lang === "ts" ? ": string[]" : ""
        } = [];`,
      ),
      ...items,
      block(`for (const message of cairnTeardownErrors) {`, [
        raw(`console.warn("[teardown] " + message);`),
        raw(
          `test.info().annotations.push({ type: "teardown-failed", description: message });`,
        ),
      ]),
      ...(plan.failRun
        ? [
            block(
              `if (cairnTeardownErrors.length > 0 && cairnRunStatus === "passed") {`,
              [
                raw(
                  `throw new Error("teardown failed (failRun): " + cairnTeardownErrors.join("; "));`,
                ),
              ],
            ),
          ]
        : []),
    ]),
  ];
}

/* ----- polled outcomes ----- */

/** The non-retrying `expect` of a `cairnPoll` sample. */
const SAMPLE_EXPECT = "cairnSampleExpect";

/** An assertion that STARTS a statement: `expect(…)`, `await expect.poll(…)`, `x = await expect(…)`. */
const STATEMENT_EXPECT_RE =
  /^((?:return\s+)?(?:await\s+)?|[A-Za-z_$][\w$]*\s*=\s*await\s+)expect(?=[.(])/;

/**
 * Route the assertions of a poll sample through the non-retrying `expect`.
 * Only statement-start calls are rewritten (never text inside a string);
 * comments and embedded user code are left alone.
 */
function sampleAssertions(stmt: Stmt, hits: { count: number }): Stmt {
  const rewrite = (code: string): string =>
    code.replace(STATEMENT_EXPECT_RE, (_match, prefix: string) => {
      hits.count += 1;
      return `${prefix}${SAMPLE_EXPECT}`;
    });
  const each = (list: Stmt[]): Stmt[] =>
    list.map((item) => sampleAssertions(item, hits));
  switch (stmt.kind) {
    case "raw":
      return raw(rewrite(stmt.code));
    case "block":
      return block(rewrite(stmt.open), each(stmt.body), stmt.close);
    case "tryCatch":
      return tryCatch(each(stmt.body), stmt.errName, each(stmt.handler));
    case "ifElse":
      return ifElse(stmt.condition, each(stmt.body), each(stmt.otherwise));
    default:
      return stmt;
  }
}

/**
 * Wrap an outcome's assertion statements in its `poll:`: Playwright's
 * `toPass({ timeout, intervals })` with the same `timeoutMs` / `everyMs`, or
 * `cairnPoll` when a `stableMs` window must hold (the runner's semantics).
 *
 * A `cairnPoll` sample must be instantaneous like the runner's: a web-first
 * assertion would retry a red sample until it turns green (5s by default)
 * and report a flapping state as stable. Inside the sample every assertion
 * goes through `expect.configure({ timeout: 1 })` — one check (a timeout of
 * 0 would mean NO timeout in Playwright).
 */
export function wrapPolled(stmts: Stmt[], poll: Poll, ctx: EmitCtx): Stmt[] {
  const everyMs = poll.everyMs ?? 1000;
  const inner = stmts.length > 0 ? stmts : [comment("no-op")];
  if (poll.stableMs !== undefined && poll.stableMs > 0) {
    ctx.usedPoll = true;
    const hits = { count: 0 };
    const sampled = inner.map((stmt) => sampleAssertions(stmt, hits));
    return [
      block(
        `await cairnPoll(async () => {`,
        hits.count > 0
          ? [
              comment(
                "one instantaneous sample, like cairn run: each assertion checks once (no auto-retry)",
              ),
              raw(`const ${SAMPLE_EXPECT} = expect.configure({ timeout: 1 });`),
              ...sampled,
            ]
          : sampled,
        `}, { timeoutMs: ${poll.timeoutMs}, everyMs: ${everyMs}, stableMs: ${poll.stableMs} });`,
      ),
    ];
  }
  return [
    block(
      `await expect(async () => {`,
      inner,
      `}).toPass({ timeout: ${poll.timeoutMs}, intervals: [${everyMs}] });`,
    ),
  ];
}

/* ----- preconditions (inline) ----- */

export interface HookPrecondition {
  name?: string;
  run: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * `--preconditions inline`: the executable preconditions of one spec as a
 * `beforeAll` hook. Each runs through the bounded helper with its own
 * `cwd` (resolved against the spec's directory like `cairn run`), `timeoutMs`
 * and the authored `preconditions.env`; the command text keeps its late-bound
 * `\${env.X}` / `\${secrets.X}` as `process.env` reads at run time.
 * `SKIP_PRECONDITIONS=1` skips the hook (wire your own in CI).
 */
export function renderPreconditionHook(
  commands: readonly HookPrecondition[],
  env: Record<string, string | number | boolean> | undefined,
  ctx: EmitCtx,
  specDir: string,
  budget: PlaywrightTimeoutBudget,
  budgetComment: string,
  hostTimeoutMs?: number,
): Stmt {
  ctx.usage.runToken = true;
  ctx.usesTestInfo = true;
  markCommand(ctx, "precondition", "context");
  const envExpr = envMapExpr(env, ctx);
  const calls = commands.map((command, index) => {
    const label = command.name
      ? `Precondition ${JSON.stringify(command.name)}`
      : `Precondition ${index + 1}`;
    const words = simpleCommandWords(command.run);
    const commandExpr = words
      ? `{ argv: [${words.map((word) => emitStr(word, ctx.usage)).join(", ")}] }`
      : emitStr(command.run, ctx.usage);
    const cwdAbs =
      command.cwd !== undefined ? resolve(specDir, command.cwd) : specDir;
    const redact = redactOption(command.run, env);
    const options = [
      `cwd: ${hostPathExpr(cwdAbs, ctx)}`,
      `timeoutMs: ${command.timeoutMs ?? RUN_STEP_DEFAULT_TIMEOUT_MS}`,
      `label: ${JSON.stringify(label)}`,
      `context: cairnTestContext(test.info(), RUN_TOKEN)`,
      ...(envExpr ? [`env: ${envExpr}`] : []),
      ...(redact ? [redact] : []),
    ].join(", ");
    return raw(`await runPrecondition(${commandExpr}, { ${options} });`);
  });
  return block(
    `test.beforeAll(async () => {`,
    [
      block(`if (process.env.SKIP_PRECONDITIONS === "1") {`, [raw(`return;`)]),
      ...setTimeoutStmts(budget, budgetComment, hostTimeoutMs),
      ...calls,
    ],
    `});`,
  );
}
