import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigSchema } from "../core/schema/config.v1";
import {
  ReusableActionSchema,
  SpecSchema,
  StepSchema,
} from "../core/schema/spec.v1";

// Guards the YAML examples in the public docs (docs/*.md). Every ```yaml fence
// is parsed and validated against the most specific schema it looks like:
//   - a full spec (`outcomes` + `steps`)            -> SpecSchema
//   - a YAML sequence                                -> StepSchema[]
//   - `name` + `steps` (no outcomes)                 -> ReusableActionSchema
//   - any config-only top-level key                  -> ConfigSchema (a
//     missing `version` and `environments` are padded so a fragment that
//     shows only `suites:` is still checked)
//   - a spec fragment (keys that exist on a spec)    -> each key checked
//     against its own spec schema (`fixtures:`, `outcomes:`, `requires:`, ...)
//   - anything else (incl. a foreign YAML, e.g. a
//     GitHub workflow)                              -> skipped
// `fixtures:` as a map is not checked as a spec fragment: it is a config
// registry or a script verifier payload, and a fragment cannot tell them apart.
// A fence can opt out with `<!-- yaml-guard: skip -->` on the line right
// before it. No fence uses the marker today; keep the list short and justified.

const DOCS_DIR = fileURLToPath(new URL("../../docs/", import.meta.url));
const SKIP_MARKER = "<!-- yaml-guard: skip -->";

// Top-level keys that only a config file has. `version`, `requires`, `vars`,
// `stash` and `fixtures` exist in both a spec and a config, so they never pick
// the schema on their own.
const CONFIG_ONLY_KEYS = new Set([
  "project",
  "defaultEnvironment",
  "artifactRoot",
  "workflowRoots",
  "include",
  "runtimes",
  "environments",
  "secrets",
  "retention",
  "logging",
  "report",
  "browser",
  "webServer",
  "gates",
  "run",
  "services",
  "clips",
  "investigate",
  "diagnostics",
  "annotate",
  "authoring",
  "discovery",
  "export",
  "datasources",
  "suites",
  "metrics",
]);

const SPEC_SHAPE: Record<string, z.ZodTypeAny> = SpecSchema.shape;
const StepListSchema = z.array(StepSchema);

type Fence = { file: string; line: number; code: string };
type Failure = { file: string; line: number; kind: string; issues: string[] };
type Result = { kind: string; issues: string[] } | null;

function extractFences(file: string, text: string): Fence[] {
  const lines = text.split("\n");
  const fences: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^```yaml\s*$/.test(lines[i]!)) continue;
    const skipped = i > 0 && lines[i - 1]!.trim() === SKIP_MARKER;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !/^```\s*$/.test(lines[j]!)) {
      body.push(lines[j]!);
      j++;
    }
    if (!skipped) {
      fences.push({ file, line: i + 1, code: body.join("\n") });
    }
    i = j;
  }
  return fences;
}

function issuesOf(error: z.ZodError, prefix = ""): string[] {
  return error.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].filter(Boolean);
    return `${path.length ? path.join(".") : "(root)"}: ${issue.message}`;
  });
}

function check(kind: string, schema: z.ZodTypeAny, value: unknown): Result {
  const result = schema.safeParse(value);
  return result.success ? null : { kind, issues: issuesOf(result.error) };
}

function validate(parsed: unknown): Result {
  if (Array.isArray(parsed)) return check("steps", StepListSchema, parsed);
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value);

  if ("outcomes" in value && "steps" in value) {
    return check("spec", SpecSchema, value);
  }
  if ("name" in value && "steps" in value) {
    return check("action", ReusableActionSchema, value);
  }
  if (keys.some((key) => CONFIG_ONLY_KEYS.has(key))) {
    return check("config", ConfigSchema, {
      version: 1,
      environments: {},
      ...value,
    });
  }

  // Spec fragment: check each key that exists on a spec against its schema.
  // A fragment with a key that is neither spec nor config (a GitHub workflow's
  // `on:` / `jobs:`, a Playwright config) is not a cairntrace example: skip it.
  if (keys.some((key) => !SPEC_SHAPE[key] && !CONFIG_ONLY_KEYS.has(key))) {
    return null;
  }
  const problems: string[] = [];
  let checked = 0;
  for (const key of keys) {
    const schema = SPEC_SHAPE[key];
    if (!schema) continue;
    // `fixtures:` is a list on a spec, but a map in a config registry and in
    // script verifiers. Only the list form is unambiguous enough to check here.
    if (key === "fixtures" && !Array.isArray(value[key])) continue;
    checked++;
    const result = schema.safeParse(value[key]);
    if (!result.success) problems.push(...issuesOf(result.error, key));
  }
  if (checked === 0) return null;
  return problems.length ? { kind: "fragment", issues: problems } : null;
}

function parseFence(fence: Fence): Failure | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(fence.code);
  } catch (error) {
    return {
      file: fence.file,
      line: fence.line,
      kind: "yaml",
      issues: [(error as Error).message.split("\n")[0]!],
    };
  }
  const result = validate(parsed);
  return result
    ? {
        file: fence.file,
        line: fence.line,
        kind: result.kind,
        issues: result.issues,
      }
    : null;
}

describe("docs YAML examples", () => {
  const files = readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith(".md"))
    .toSorted();
  const fences = files.flatMap((name) =>
    extractFences(basename(name), readFileSync(join(DOCS_DIR, name), "utf8")),
  );

  it("finds yaml fences to validate", () => {
    expect(fences.length).toBeGreaterThan(50);
  });

  it("every yaml fence validates against its schema", () => {
    const failures = fences
      .map(parseFence)
      .filter((failure): failure is Failure => failure !== null);
    const report = failures
      .map(
        (f) =>
          `docs/${f.file}:${f.line} [${f.kind}]\n  ${f.issues.join("\n  ")}`,
      )
      .join("\n");
    expect(report).toBe("");
  });
});
