/**
 * PROJECT export: turn a set of Cairntrace specs into a structured Playwright
 * project instead of N monolithic spec files.
 *
 *   out/
 *   ├── README.md            operating manual (env, preconditions, how to run)
 *   ├── playwright.config.ts baseURL/serial/bypassCSP/globalSetup wired
 *   ├── global-setup.ts      deduped spec preconditions as a runnable scaffold
 *   ├── actions/<name>.ts    each reusable action (imports:) as ONE exported
 *   │                        `async function(page)` — tests import it instead
 *   │                        of inlining the same login N times
 *   ├── verifiers/<file>.ts  node verifiers copied in (self-contained project)
 *   └── tests/<spec>.spec.ts steps + outcomes; `use:` steps become action calls
 *
 * The same IR/emission layers as the single-file exporter do all rendering —
 * this module only decides FILE STRUCTURE.
 */
import type { ParseResult } from "../parser/parseSpec";
import type { Spec, Step } from "../schema/spec.v1";
import { blank, block, comment, print, raw, type Stmt } from "./codegen";
import {
  exportExtension,
  newEmitCtx,
  oneLine,
  renderOutcome,
  renderStep,
  safeIdent,
  type EmitCtx,
  type ExportCoverage,
  type ExportLang,
} from "./playwrightExporter";

export interface ProjectExportOptions {
  lang?: ExportLang;
  /** baseURL for the generated playwright.config.ts. */
  baseUrl?: string;
}

export interface ProjectFile {
  /** Path relative to the project root (e.g. "tests/foo.spec.ts"). */
  relPath: string;
  source: string;
}

export interface ProjectSpecReport {
  name: string;
  file: string;
  coverage: ExportCoverage;
  requiredEnv: string[];
  preconditions: string[];
}

export interface ProjectExportResult {
  files: ProjectFile[];
  /** Absolute paths of verifier sources the CLI must copy into verifiers/. */
  verifierFiles: string[];
  specs: ProjectSpecReport[];
  requiredEnv: string[];
}

export function exportPlaywrightProject(
  parsedSpecs: ParseResult[],
  opts: ProjectExportOptions = {},
): ProjectExportResult {
  const lang: ExportLang = opts.lang ?? "ts";
  const ext = exportExtension(lang);
  const files: ProjectFile[] = [];
  const verifierFiles = new Set<string>();
  const specs: ProjectSpecReport[] = [];
  const allEnv = new Set<string>();
  const allPreconditions = new Map<
    string,
    { name?: string; run: string; specDir: string }
  >();

  // ----- actions: one module per reusable action, deduped by name -----
  const actionModules = new Map<
    string,
    { fnName: string; relPath: string; source: string; envNames: string[] }
  >();
  for (const parsed of parsedSpecs) {
    for (const [name, loaded] of parsed.actionsByName) {
      if (actionModules.has(name)) continue;
      const fnName = safeIdent(name);
      const ctx = newEmitCtx(lang, {
        specDir: dirOf(loaded.path),
        verifierImportPrefix: "../verifiers",
        verifierFiles,
      });
      const body: Stmt[] = [];
      for (const step of loaded.action.steps) {
        body.push(...renderStep(step, undefined, ctx).stmts);
      }
      const stmts: Stmt[] = [
        comment(
          `Generated from reusable action ${JSON.stringify(name)} (${loaded.path}).`,
        ),
        comment(`Re-exporting overwrites this file.`),
        blank,
        raw(`import { expect, type Page } from "@playwright/test";`),
        ...runTokenConst(ctx),
        blank,
        block(
          `export async function ${fnName}(page: Page): Promise<void> {`,
          body,
        ),
      ];
      for (const e of ctx.usage.envNames) allEnv.add(e);
      actionModules.set(name, {
        fnName,
        relPath: `actions/${name}${lang === "js" ? ".js" : ".ts"}`,
        source: `${print(stmts)}\n`,
        envNames: [...ctx.usage.envNames],
      });
    }
  }
  for (const m of actionModules.values()) {
    files.push({ relPath: m.relPath, source: m.source });
  }

  // ----- tests: use: steps become action calls -----
  for (const parsed of parsedSpecs) {
    const spec = parsed.spec;
    const steps = spec.steps ?? [];
    const ctx = newEmitCtx(lang, {
      specDir: dirOf(parsed.path),
      verifierImportPrefix: "../verifiers",
      verifierFiles,
    });
    ctx.coverage.stepsTotal = steps.length;
    ctx.coverage.outcomesTotal = spec.outcomes.length;

    const usedActions = new Set<string>();
    const body: Stmt[] = [
      // Causation floor for node verifiers - see single-file exporter note.
      raw(`process.env.CAIRN_RUN_START_FLOOR_MS = String(Date.now());`),
      blank,
    ];
    if (steps.length > 0) {
      body.push(comment(`--- steps ---`));
      for (const step of steps) {
        if ("use" in step) {
          const mod = actionModules.get(step.use);
          if (mod) {
            usedActions.add(step.use);
            body.push(
              comment(`step: ${oneLine(step.id ?? step.use)} (action)`),
              raw(`await ${mod.fnName}(page);`),
            );
            ctx.coverage.stepsExported += 1;
            continue;
          }
        }
        const rendered = renderStep(step as Step, spec.settleMs, ctx);
        if (rendered.exported) ctx.coverage.stepsExported += 1;
        body.push(...rendered.stmts);
      }
      body.push(blank);
    }
    body.push(comment(`--- outcomes (the contract) ---`));
    for (const outcome of spec.outcomes) {
      body.push(comment(`${outcome.id}: ${oneLine(outcome.description)}`));
      const rendered = renderOutcome(outcome, ctx);
      if (rendered.exported) ctx.coverage.outcomesExported += 1;
      body.push(...rendered.stmts, blank);
    }

    const preconditionLines = collectPreconditions(spec).map((p) => {
      allPreconditions.set(p.run, { ...p, specDir: dirOf(parsed.path) });
      return `${p.name ? `[${p.name}] ` : ""}${oneLine(p.run).slice(0, 160)}`;
    });

    const head: Stmt[] = [
      comment(
        `Generated by \`cairn export playwright --project\`. Source: ${parsed.path}`,
      ),
      comment(`Intent: ${oneLine(spec.intent)}`),
    ];
    const specPreconditions = collectPreconditions(spec);
    if (preconditionLines.length > 0) {
      head.push(
        comment(`Preconditions run in this file's beforeAll — see README.`),
      );
    }
    head.push(blank, raw(`import { expect, test } from "@playwright/test";`));
    if (specPreconditions.length > 0) {
      head.push(raw(`import { execSync } from "node:child_process";`));
    }
    for (const name of [...usedActions].toSorted()) {
      const mod = actionModules.get(name)!;
      head.push(
        raw(
          `import { ${mod.fnName} } from "../actions/${name}${
            lang === "js" ? ".js" : ""
          }";`,
        ),
      );
    }
    head.push(...runTokenConst(ctx));
    if (specPreconditions.length > 0) {
      // Cairntrace runs preconditions PER SPEC (pipeline gates, data resets)
      // — beforeAll preserves that semantic; globalSetup alone would gate the
      // suite only once and let test debris pile up between tests.
      head.push(
        blank,
        block(
          `test.beforeAll(() => {`,
          [
            raw(`if (process.env.SKIP_PRECONDITIONS === "1") return;`),
            ...specPreconditions.map((p) =>
              raw(
                `execSync(${JSON.stringify(p.run)}, { stdio: "inherit", shell: "/bin/bash", cwd: ${JSON.stringify(dirOf(parsed.path))} });`,
              ),
            ),
          ],
          `});`,
        ),
      );
    }
    head.push(
      blank,
      block(
        `test(${JSON.stringify(spec.name)}, async ({ page }) => {`,
        body,
        `});`,
      ),
    );

    for (const e of ctx.usage.envNames) allEnv.add(e);
    const relPath = `tests/${spec.name}${ext}`;
    files.push({ relPath, source: `${print(head)}\n` });
    specs.push({
      name: spec.name,
      file: relPath,
      coverage: ctx.coverage,
      requiredEnv: [...ctx.usage.envNames].toSorted(),
      preconditions: preconditionLines,
    });
  }

  // ----- playwright.config -----
  files.push({
    relPath: `playwright.config${lang === "js" ? ".js" : ".ts"}`,
    source: renderConfig(opts.baseUrl, lang),
  });

  // ----- global-setup: one-time stack sanity note (per-spec preconditions
  // run in each file's beforeAll, mirroring cairn semantics) -----
  files.push({
    relPath: `global-setup${lang === "js" ? ".js" : ".ts"}`,
    source: renderGlobalSetup([...allPreconditions.values()]),
  });

  // ----- README -----
  files.push({
    relPath: "README.md",
    source: renderProjectReadme(specs, [...allEnv].toSorted(), actionModules),
  });

  return {
    files,
    verifierFiles: [...verifierFiles].toSorted(),
    specs,
    requiredEnv: [...allEnv].toSorted(),
  };
}

function runTokenConst(ctx: EmitCtx): Stmt[] {
  if (!ctx.usage.runToken) return [];
  return [
    blank,
    raw(
      `const RUN_TOKEN = process.env.CAIRN_RUN_TOKEN ?? Math.random().toString(36).slice(2, 10);`,
    ),
  ];
}

function collectPreconditions(
  spec: Spec,
): Array<{ name?: string; run: string }> {
  const out: Array<{ name?: string; run: string }> = [];
  for (const c of spec.preconditions?.commands ?? []) {
    if (typeof c === "string") out.push({ run: c });
    else out.push({ ...(c.name ? { name: c.name } : {}), run: c.run });
  }
  return out;
}

function renderConfig(baseUrl: string | undefined, lang: ExportLang): string {
  const lines = [
    `// Generated by \`cairn export playwright --project\` — edit knowingly;`,
    `// re-exporting overwrites this file.`,
    lang === "js"
      ? `const { defineConfig } = require("@playwright/test");`
      : `import { defineConfig } from "@playwright/test";`,
    ``,
    lang === "js"
      ? `module.exports = defineConfig({`
      : `export default defineConfig({`,
    `  testDir: "./tests",`,
    `  // Specs share one backend pipeline — they must never overlap.`,
    `  workers: 1,`,
    `  fullyParallel: false,`,
    `  // Durable-processing verifiers legitimately wait minutes.`,
    `  timeout: 30 * 60 * 1000,`,
    `  globalSetup: "./global-setup",`,
    `  use: {`,
    ...(baseUrl ? [`    baseURL: ${JSON.stringify(baseUrl)},`] : []),
    `    headless: true,`,
    `    // The app ships a strict CSP (script-src without unsafe-eval) which`,
    `    // blocks exported string-eval steps — standard test-context bypass.`,
    `    bypassCSP: true,`,
    `  },`,
    `  reporter: [["list"]],`,
    `});`,
    ``,
  ];
  return lines.join("\n");
}

function renderGlobalSetup(
  preconditions: Array<{ name?: string; run: string; specDir: string }>,
): string {
  const names = preconditions
    .map((p) => `//   - ${p.name ?? oneLine(p.run).slice(0, 80)}`)
    .join("\n");
  return `// Generated by \`cairn export playwright --project\`.
//
// Per-spec preconditions run in each test file's beforeAll (mirroring the
// Cairntrace per-spec semantics — a single global gate would let backend
// debris pile up between tests). This hook is the place for ONE-TIME suite
// setup (auth warmup, seeding); it currently only logs. Known per-spec
// preconditions, for reference:
${names}
export default async function globalSetup(): Promise<void> {
  console.log("[global-setup] per-spec preconditions run in each file's beforeAll");
}
`;
}

function renderProjectReadme(
  specs: ProjectSpecReport[],
  env: string[],
  actions: Map<string, { fnName: string; relPath: string }>,
): string {
  const lines = [
    "# Exported Playwright project",
    "",
    "Generated by `cairn export playwright --project` from Cairntrace specs —",
    "the specs remain the source of truth; re-exporting overwrites these files.",
    "",
    "```",
    "playwright.config.*   serial, bypassCSP, 30m timeout, globalSetup wired",
    "global-setup.*        spec preconditions (data resets, pipeline gates)",
    "actions/              shared UI flows (login, …) imported by tests",
    "verifiers/            node-context durable-processing verifiers (copied)",
    "tests/                one spec file per Cairntrace spec",
    "```",
    "",
    "## Run",
    "",
    "```bash",
    "npx playwright test",
    "```",
    "",
    "## Required environment",
    "",
    env.length > 0
      ? "Provide from ANY secret source (CI secrets, dotenv, a vault CLI):"
      : "No secret env vars required.",
    ...env.map((e) => `- \`${e}\``),
    "",
    "Optional:",
    "- `CAIRN_RUN_TOKEN` — pins the per-run uniqueness token (default: random per run).",
    "- `CAIRN_COMPLETION_TIMEOUT_MS` — widens verifier completion waits on slow machines.",
    "- `SKIP_PRECONDITIONS=1` — skip global-setup preconditions (wire your own in CI).",
    "- `MONGO_URI` — point verifiers at a remote MongoDB instead of local docker.",
    "",
    "## Actions",
    "",
    ...[...actions.entries()].map(
      ([name, a]) =>
        `- \`${a.relPath}\` → \`${a.fnName}(page)\` (from action \`${name}\`)`,
    ),
    "",
    "## Specs",
    "",
  ];
  for (const s of specs) {
    lines.push(
      `### ${s.name} (\`${s.file}\`)`,
      `- coverage: steps ${s.coverage.stepsExported}/${s.coverage.stepsTotal}, outcomes ${s.coverage.outcomesExported}/${s.coverage.outcomesTotal}`,
      ...(s.preconditions.length > 0
        ? [`- preconditions:`, ...s.preconditions.map((p) => `  - ${p}`)]
        : []),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}
