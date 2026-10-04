/**
 * `--preconditions global`: the generated project's `global-setup`.
 *
 * Runs ONCE before the suite, in cairn's own order: readiness gates
 * (`cairn wait <gate>`), the specs' preconditions through the bounded command
 * helper, then the config fixtures (`cairn fixtures ensure <name> --json`).
 * The outputs of the fixtures are written to a private temp file named by
 * `CAIRN_FIXTURES_FILE` (workers inherit the env), which the tests read
 * through `cairnFixtureOutputs`; the file is removed — and the run-scoped
 * fixtures are torn down — when the suite ends. Gates and fixtures need the
 * `cairn` CLI (`CAIRN_BIN`, default `cairn` on PATH) and the source project
 * (`CAIRN_PROJECT_ROOT`); command text, `with:` values and secrets stay
 * `process.env` reads at run time, never baked into the generated file.
 */
import { realpathNearest } from "./exportManifest";
import { relative, resolve as resolvePath, sep } from "node:path";
import { redactOption, simpleCommandWords } from "./commandRuntime";
import type { HostFixture, HostGate, HostPrecondition } from "./exportModes";
import { newRefUsage, emitStr, emitValue } from "./templateValue";

type ExportLang = "ts" | "js";

export interface GlobalSetupInput {
  preconditions: readonly HostPrecondition[];
  gates: readonly HostGate[];
  fixtures: readonly (HostFixture & {
    reset?: boolean;
    write?: boolean;
  })[];
  lang: ExportLang;
  /** Source project root (host paths are relative to it). */
  projectRoot: string | undefined;
  /** Config file (absolute) passed to `cairn` as `--config`. */
  configPath?: string;
  /** Environment passed to `cairn` as `--env`. */
  envName?: string;
  /**
   * E9: API logins (export map) to sign in once for the suite: each writes
   * its storageState through `lib/authState`, with the project's baseURL.
   */
  authStates?: readonly string[];
}

export interface GlobalSetupResult {
  source: string;
  /** Env vars the generated file reads (late-bound secrets). */
  envNames: string[];
}

const GATE_TIMEOUT_MS = 10 * 60 * 1000;
const FIXTURE_TIMEOUT_MS = 10 * 60 * 1000;

function hostPath(abs: string, projectRoot: string | undefined): string {
  if (!projectRoot) return JSON.stringify(abs);
  const rel = relative(projectRoot, realpathNearest(abs)).split(sep).join("/");
  if (rel === "") return "cairnProjectPath()";
  if (rel === ".." || rel.startsWith("../")) return JSON.stringify(abs);
  return `cairnProjectPath(${JSON.stringify(rel)})`;
}

export function renderGlobalSetupModule(
  input: GlobalSetupInput,
): GlobalSetupResult {
  const ts = input.lang === "ts";
  const t = (annotation: string): string => (ts ? annotation : "");
  const usage = newRefUsage();
  const hasCairnCalls = input.gates.length > 0 || input.fixtures.length > 0;
  const usesRoot = input.projectRoot !== undefined;
  const body: string[] = [];

  const scopeArgs: string[] = [];
  if (input.configPath) {
    scopeArgs.push(
      `"--config"`,
      hostPath(resolvePath(input.configPath), input.projectRoot),
    );
  }
  if (input.envName) scopeArgs.push(`"--env"`, JSON.stringify(input.envName));
  if (hasCairnCalls) {
    body.push(
      `  // \`cairn\` CLI calls (gates, fixtures) run from the source project.`,
      `  const cairnScope${t(": string[]")} = [${scopeArgs.join(", ")}];`,
      `  const cairnCwd = ${
        usesRoot ? "cairnProjectRoot()" : "process.cwd()"
      };`,
    );
  }

  for (const gate of input.gates) {
    body.push(
      `  await cairnCommand(`,
      `    { argv: [CAIRN_BIN, "wait", ${JSON.stringify(gate.target)}, ...cairnScope] },`,
      `    { cwd: cairnCwd, timeoutMs: ${GATE_TIMEOUT_MS}, label: ${JSON.stringify(`cairn wait ${gate.target}`)} },`,
      `  );`,
    );
  }

  for (const [index, pre] of input.preconditions.entries()) {
    const words = simpleCommandWords(pre.run);
    const command = words
      ? `{ argv: [${words.map((word) => emitStr(word, usage)).join(", ")}] }`
      : emitStr(pre.run, usage);
    const env =
      pre.env && Object.keys(pre.env).length > 0
        ? `, env: { ${Object.entries(pre.env)
            .map(
              ([key, value]) =>
                `${JSON.stringify(key)}: String(${emitValue(value, usage)})`,
            )
            .join(", ")} }`
        : "";
    const label = pre.name
      ? `Precondition ${JSON.stringify(pre.name)}`
      : `Precondition ${index + 1}`;
    const redact = redactOption(pre.run, pre.env);
    body.push(
      `  await runPrecondition(${command}, { cwd: ${hostPath(pre.cwd, input.projectRoot)}, timeoutMs: ${pre.timeoutMs}, label: ${JSON.stringify(label)}${env}${
        redact ? `, ${redact}` : ""
      } });`,
    );
  }

  const authStates = input.authStates ?? [];
  if (authStates.length > 0) {
    body.push(
      `  const authBaseURL = config.projects.find((project) => project.use.baseURL)?.use.baseURL;`,
      ...authStates.map(
        (name) =>
          `  await cairnWriteState(${JSON.stringify(name)}, authBaseURL);`,
      ),
    );
  }

  const runScoped: string[] = [];
  if (input.fixtures.length > 0) {
    body.push(
      `  const fixtureOutputs${t(": Record<string, Record<string, unknown>>")} = {};`,
    );
    for (const fixture of input.fixtures) {
      const withArgs = Object.entries(fixture.with ?? {}).flatMap(
        ([key, value]) => [
          `"--with"`,
          emitStr(
            `${key}=${
              typeof value === "string" ? value : JSON.stringify(value)
            }`,
            usage,
          ),
        ],
      );
      const flags = [
        `"--json"`,
        ...scopeArgsRef(hasCairnCalls),
        ...withArgs,
        ...(fixture.write ? [`"--allow-writes"`] : []),
      ];
      body.push(
        `  {`,
        `    const ensured = await cairnCommand(`,
        `      { argv: [CAIRN_BIN, "fixtures", "ensure", ${JSON.stringify(fixture.name)}, ${flags.join(", ")}] },`,
        `      { cwd: cairnCwd, timeoutMs: ${FIXTURE_TIMEOUT_MS}, label: ${JSON.stringify(`cairn fixtures ensure ${fixture.name}`)}, capture: true },`,
        `    );`,
        `    Object.assign(fixtureOutputs, (parseJsonReport(ensured).outputs ?? {})${t(" as Record<string, Record<string, unknown>>")});`,
        ...(fixture.runScoped
          ? [
              `    cleanups.push(async () => {`,
              `      await cairnCommand(`,
              `        { argv: [CAIRN_BIN, "fixtures", "teardown", ${JSON.stringify(fixture.name)}, ...cairnScope] },`,
              `        { cwd: cairnCwd, timeoutMs: ${FIXTURE_TIMEOUT_MS}, label: ${JSON.stringify(`cairn fixtures teardown ${fixture.name}`)} },`,
              `      );`,
              `    });`,
            ]
          : [
              `    // not run-scoped: cairn keeps it between runs, so there is no teardown here`,
            ]),
        `  }`,
      );
      if (fixture.runScoped) runScoped.push(fixture.name);
      if (fixture.reset) {
        body.push(
          `  await cairnCommand(`,
          `    { argv: [CAIRN_BIN, "fixtures", "reset", ${JSON.stringify(fixture.name)}, ...cairnScope${
            fixture.write ? `, "--allow-writes"` : ""
          }] },`,
          `    { cwd: cairnCwd, timeoutMs: ${FIXTURE_TIMEOUT_MS}, label: ${JSON.stringify(`cairn fixtures reset ${fixture.name}`)} },`,
          `  );`,
        );
      }
    }
    body.push(
      `  const fixturesDir = mkdtempSync(join(tmpdir(), "cairn-fixtures-"));`,
      `  const fixturesFile = join(fixturesDir, "fixtures.json");`,
      `  writeFileSync(fixturesFile, JSON.stringify(fixtureOutputs), { mode: 0o600 });`,
      `  process.env.CAIRN_FIXTURES_FILE = fixturesFile;`,
      `  cleanups.push(async () => {`,
      `    rmSync(fixturesDir, { recursive: true, force: true });`,
      `  });`,
    );
  }

  const usesRunToken = usage.runToken;
  const imports = [
    ...(authStates.length > 0
      ? [
          ...(ts
            ? [`import type { FullConfig } from "@playwright/test";`]
            : []),
          `import { cairnWriteState } from "./lib/authState";`,
        ]
      : []),
    ...(input.fixtures.length > 0
      ? [
          `import { mkdtempSync, rmSync, writeFileSync } from "node:fs";`,
          `import { tmpdir } from "node:os";`,
          `import { join } from "node:path";`,
        ]
      : []),
    `import { ${[
      ...(hasCairnCalls || input.preconditions.length > 0
        ? ["cairnCommand"]
        : []),
      ...(input.preconditions.length > 0 ? ["runPrecondition"] : []),
    ].join(", ")} } from "./preconditions";`,
    ...(usesRoot && (hasCairnCalls || input.preconditions.length > 0)
      ? [
          `import { ${[
            ...(body.some((line) => line.includes("cairnProjectPath("))
              ? ["cairnProjectPath"]
              : []),
            ...(hasCairnCalls ? ["cairnProjectRoot"] : []),
          ].join(", ")} } from "./lib/projectRoot";`,
        ]
      : []),
  ].filter((line) => !/import \{  \} from/.test(line));
  const ext = input.lang === "js" ? ".js" : "";
  const importLines = imports.map((line) =>
    line.replace(/from "(\.\/[^"]+)";$/, `from "$1${ext}";`),
  );

  const lines = [
    `// Generated by \`cairn export playwright --project --preconditions global\`.`,
    `//`,
    `// Runs ONCE before the suite: readiness gates (\`cairn wait\`), the specs'`,
    `// preconditions, then the config fixtures (\`cairn fixtures ensure\`) whose`,
    `// outputs the tests read from CAIRN_FIXTURES_FILE. Gates and fixtures need the`,
    `// \`cairn\` CLI (CAIRN_BIN, default: \`cairn\` on PATH) and the source project`,
    `// (CAIRN_PROJECT_ROOT). The commands run once for the whole suite, not before`,
    `// each spec; SKIP_PRECONDITIONS=1 skips this hook (wire your own in CI).`,
    ...importLines,
    ``,
    ...(hasCairnCalls
      ? [`const CAIRN_BIN = process.env.CAIRN_BIN ?? "cairn";`, ``]
      : []),
    ...(input.fixtures.length > 0
      ? [
          `/** \`cairn … --json\` prints one JSON document (tolerate leading log lines). */`,
          `function parseJsonReport(text${t(": string")})${t(": { outputs?: unknown }")} {`,
          `  const start = text.indexOf("{");`,
          `  return JSON.parse(start >= 0 ? text.slice(start) : text)${t(" as { outputs?: unknown }")};`,
          `}`,
          ``,
        ]
      : []),
    `export default async function globalSetup(${
      authStates.length > 0 ? `config${t(": FullConfig")}` : ""
    })${t(": Promise<() => Promise<void>>")} {`,
    `  const noop = async ()${t(": Promise<void>")} => {};`,
    `  if (process.env.SKIP_PRECONDITIONS === "1") return noop;`,
    `  // One token for the setup and the tests: workers inherit this env.`,
    `  process.env.CAIRN_RUN_TOKEN ??= Math.random().toString(36).slice(2, 10);`,
    ...(usesRunToken
      ? [`  const RUN_TOKEN = process.env.CAIRN_RUN_TOKEN;`]
      : []),
    `  const cleanups${t(": Array<() => Promise<void>>")} = [];`,
    `  const runCleanups = async ()${t(": Promise<void>")} => {`,
    `    for (const cleanup of [...cleanups].reverse()) {`,
    `      try {`,
    `        await cleanup();`,
    `      } catch (error) {`,
    `        console.warn("[global-setup] cleanup failed: " + (error instanceof Error ? error.message : String(error)));`,
    `      }`,
    `    }`,
    `  };`,
    `  try {`,
    ...body.map((line) => `  ${line}`),
    `  } catch (error) {`,
    `    await runCleanups();`,
    `    throw error;`,
    `  }`,
    `  return runCleanups;`,
    `}`,
    ``,
  ];
  return { source: lines.join("\n"), envNames: [...usage.envNames] };
}

function scopeArgsRef(hasCairnCalls: boolean): string[] {
  return hasCairnCalls ? ["...cairnScope"] : [];
}
