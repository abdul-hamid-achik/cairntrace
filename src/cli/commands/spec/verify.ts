import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { CheckpointStore } from "../../../core/checkpoint/CheckpointStore";
import { coldStartLint } from "../../../core/coldStart";
import {
  environmentEligibility,
  type EnvironmentEligibility,
  evaluateEnvPolicy,
  requiredEnvNames,
} from "../../../core/envPolicy";
import { auditFileReferences } from "../../../core/fileReferenceAudit";
import { specFixtureRefParts } from "../../../core/fixtures/schema";
import { gateRefNames } from "../../../core/gates/schema";
import { computeContractHash } from "../../../core/contractHash";
import { resolveSpecRuntimeContext } from "../../../core/config/runtimeContext";
import {
  assertBatchSelectorLocators,
  ContractHashMismatchError,
  parseSpec,
} from "../../../core/parser/parseSpec";
import { auditPlaceholderReferences } from "../../../core/referenceAudit";
import type { ConfigVarValue } from "../../../core/schema/config.v1";
import { SpecSchema } from "../../../core/schema/spec.v1";
import { emit, resolveFormat } from "../../format";
import { parseVarFlags } from "../run";

export interface VerifyOptions {
  stamp?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
  env?: string;
  config?: string;
  /** Repeatable `--var key=value` overrides; win over config env vars. */
  var?: string[];
}

/**
 * One structured verify finding (additive; the same text is also in
 * `errors` / `warnings`). `severity: "error"` makes verify exit 4.
 */
export interface VerifyFinding {
  kind:
    | "env-not-allowed"
    | "unknown-env"
    | "missing-file"
    | "absolute-path"
    | "deprecated-path"
    | "checkpoint-missing"
    | "checkpoint-expired"
    | "checkpoint-base-url-mismatch"
    | "unknown-gate"
    | "unknown-fixture";
  severity: "error" | "warning";
  message: string;
  /** File the finding is about (spec or imported action). */
  file?: string;
  /** Step/outcome location, e.g. `action login step 2`. */
  where?: string;
  /** Field, e.g. `eval.file`, `upload.path`. */
  field?: string;
  /**
   * Environment name (env findings), checkpoint (checkpoint findings), gate
   * name (unknown-gate) or fixture name (unknown-fixture).
   */
  subject?: string;
}

export interface VerifyResult {
  status: "valid" | "invalid" | "stamped";
  path: string;
  contractHash?: string;
  warnings: string[];
  errors: string[];
  /** Placeholder reference findings from the static audit (0 when clean). */
  referenceFindings?: number;
  /** False when the cold-start lint flagged the spec (see `warnings`). */
  coldStartSatisfied?: boolean;
  /** Structured env-policy, file-reference and checkpoint findings. */
  findings?: VerifyFinding[];
  /**
   * The environment verify resolved (`--env`, else the spec/config
   * default) and whether the environment policy lets the spec run there.
   */
  environment?: {
    name: string;
    allowed: boolean;
    /** True when `--env` named it (a refusal is then an error, exit 4). */
    explicit: boolean;
    code?: string;
    reason?: string;
  };
  /** The policy verdict in every environment the config defines. */
  environments?: EnvironmentEligibility[];
}

export interface VerifySpecOptions {
  /** Environment override (CLI `--env`, MCP `env`). */
  env?: string;
  /** Explicit cairntrace.config.yml path. */
  config?: string;
  /** Runtime var overrides; win over config env vars. */
  vars?: Record<string, ConfigVarValue>;
  /**
   * Hint appended to the "no contractHash" warning — the CLI says
   * `--stamp`, MCP says `stamp=true`.
   */
  stampHint?: string;
  /** Caller environment for `requires.env` opt-in variables (default process.env). */
  callerEnv?: Record<string, string | undefined>;
  /** Checkpoint store for `session.resume` findings (default ~/.cairntrace/checkpoints). */
  checkpointStore?: CheckpointStore;
}

/**
 * Lint one spec without running it: resolve config/env/vars exactly like a
 * run, parse + validate (imports included), surface the stamp and cold-start
 * warnings, and run the static placeholder reference audit. This is the ONE
 * verify code path — `cairn spec verify` and MCP `cairn_spec_verify` both call
 * it, so the two can never disagree about whether a spec is valid.
 *
 * Exit codes: 0 valid, 4 lint/config error (parse, schema, unknown env,
 * reference audit), 6 contract-hash mismatch.
 */
export async function verifySpec(
  specPath: string,
  opts: VerifySpecOptions = {},
): Promise<{ result: VerifyResult; exitCode: 0 | 4 | 6 }> {
  const result: VerifyResult = {
    status: "valid",
    path: specPath,
    warnings: [],
    errors: [],
  };
  try {
    const runtime = await resolveSpecRuntimeContext(specPath, {
      ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(opts.vars && Object.keys(opts.vars).length > 0
        ? { vars: opts.vars }
        : {}),
    });
    result.warnings.push(...runtime.warnings);
    const parsed = await parseSpec(specPath, {
      vars: runtime.vars,
      configDir: runtime.configDir,
      ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    });
    result.contractHash = parsed.spec.contractHash;
    if (!parsed.spec.contractHash) {
      result.warnings.push(
        `spec has no contractHash; ${
          opts.stampHint ?? "run `cairn spec verify <file> --stamp`"
        } to lock it`,
      );
    }
    // Cold-start contract lint (plan §10.6)
    const coldStartWarning = coldStartLint(parsed.spec);
    if (coldStartWarning) result.warnings.push(coldStartWarning);
    result.coldStartSatisfied = coldStartWarning === undefined;

    // Static placeholder reference audit: `${env.X}` without a default and
    // `${secrets.X}` no provider supplies both substitute to an EMPTY string
    // at run time (parseSpec resolves them silently). Catch them here — in
    // seconds, before the run — instead of as a confusing mid-run failure.
    const auditFiles: Array<{ path: string; text: string }> = [
      { path: specPath, text: await readFile(parsed.path, "utf8") },
    ];
    for (const action of parsed.actionsByName.values()) {
      auditFiles.push({
        path: action.path,
        text: await readFile(action.path, "utf8"),
      });
    }
    // The EFFECTIVE secrets block: an environment-level `secrets:` replaces
    // the top-level one, so its `required` list is what providers supply.
    const findings = auditPlaceholderReferences(auditFiles, {
      secretsRequired: runtime.secrets?.required,
    });
    result.referenceFindings = findings.length;
    for (const f of findings) {
      result.errors.push(`${f.file}: ${f.token} — ${f.message}`);
    }

    const structured: VerifyFinding[] = [];
    // Environment policy: where may this spec run? An explicit --env the
    // policy refuses is an error; the default environment only warns.
    const callerEnv =
      opts.callerEnv ?? (process.env as Record<string, string | undefined>);
    const requires = parsed.spec.requires;
    const envPolicy = runtime.config?.environments[runtime.envName]?.policy;
    const verdict = evaluateEnvPolicy({
      ...(requires ? { requires } : {}),
      envName: runtime.envName,
      ...(envPolicy ? { policy: envPolicy } : {}),
      env: callerEnv,
    });
    const explicit = opts.env !== undefined;
    result.environment = {
      name: runtime.envName,
      allowed: verdict.allowed,
      explicit,
      ...(verdict.allowed
        ? {}
        : { code: verdict.code, reason: verdict.reason }),
    };
    if (runtime.config) {
      result.environments = environmentEligibility(
        requires,
        runtime.config,
        callerEnv,
      );
      for (const name of requiredEnvNames(requires)) {
        if (!Object.hasOwn(runtime.config.environments, name)) {
          structured.push({
            kind: "unknown-env",
            severity: "warning",
            subject: name,
            message: `requires.env names "${name}", which ${runtime.configPath ?? "the config"} does not define`,
          });
        }
      }
    }
    // Names a run would only reject once it reached them: a
    // `preconditions.wait` gate and a `fixtures:` entry the config lacks.
    const gates = runtime.config?.gates ?? {};
    for (const name of new Set(gateRefNames(parsed.spec.preconditions?.wait))) {
      if (!Object.hasOwn(gates, name)) {
        structured.push({
          kind: "unknown-gate",
          severity: "error",
          subject: name,
          field: "preconditions.wait",
          message: `preconditions.wait names gate "${name}", which ${runtime.configPath ?? "the config"} does not define (gates: ${Object.keys(gates).join(", ") || "none"})`,
        });
      }
    }
    const registry = runtime.config?.fixtures ?? {};
    for (const name of new Set(
      (parsed.spec.fixtures ?? []).map((ref) => specFixtureRefParts(ref).name),
    )) {
      if (!Object.hasOwn(registry, name)) {
        structured.push({
          kind: "unknown-fixture",
          severity: "error",
          subject: name,
          field: "fixtures",
          message: `fixtures names "${name}", which ${runtime.configPath ?? "the config"} does not define (fixtures: ${Object.keys(registry).join(", ") || "none"})`,
        });
      }
    }
    if (!verdict.allowed) {
      structured.push({
        kind: "env-not-allowed",
        severity: explicit ? "error" : "warning",
        subject: runtime.envName,
        message: `environment "${runtime.envName}" refuses this spec (${verdict.code}): ${verdict.reason}`,
      });
    }

    // Every file the spec and its actions reference, resolved like a run.
    const projectRoot = runtime.configPath
      ? dirname(runtime.configPath)
      : dirname(parsed.path);
    for (const f of auditFileReferences(parsed, { projectRoot })) {
      structured.push({
        kind: f.kind,
        severity: f.severity,
        file: f.file,
        where: f.where,
        field: f.field,
        message: `${f.file}: ${f.message}`,
      });
    }

    // A session.resume checkpoint this machine cannot use (host-local
    // state, so a warning: CI runners usually have none).
    const resume = parsed.spec.session?.resume;
    if (resume) {
      const check = await (
        opts.checkpointStore ?? new CheckpointStore()
      ).checkResume(
        resume,
        runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {},
      );
      if (check.problem) {
        structured.push({
          kind: `checkpoint-${check.problem.code}`,
          severity: "warning",
          subject: resume,
          message: check.problem.message,
        });
      }
    }

    if (structured.length > 0) result.findings = structured;
    for (const f of structured) {
      (f.severity === "error" ? result.errors : result.warnings).push(
        f.message,
      );
    }
    if (findings.length > 0 || structured.some((f) => f.severity === "error")) {
      result.status = "invalid";
      return { result, exitCode: 4 };
    }
    return { result, exitCode: 0 };
  } catch (e) {
    result.status = "invalid";
    if (e instanceof ContractHashMismatchError) {
      result.errors.push(`contract hash mismatch: ${e.message}`);
      return { result, exitCode: 6 };
    }
    result.errors.push((e as Error).message);
    return { result, exitCode: 4 };
  }
}

export async function verifyCommand(
  specPath: string,
  opts: VerifyOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let result: VerifyResult;
  let exitCode: number;

  if (opts.stamp) {
    try {
      const hash = await stampSpecContractHash(specPath);
      result = {
        status: "stamped",
        path: specPath,
        contractHash: hash,
        warnings: [],
        errors: [],
      };
      exitCode = 0;
    } catch (e) {
      result = {
        status: "invalid",
        path: specPath,
        warnings: [],
        errors: [(e as Error).message],
      };
      exitCode = 4;
    }
  } else {
    let vars: Record<string, ConfigVarValue> | Error;
    try {
      vars = parseVarFlags(opts.var);
    } catch (e) {
      vars = e as Error;
    }
    if (vars instanceof Error) {
      result = {
        status: "invalid",
        path: specPath,
        warnings: [],
        errors: [vars.message],
      };
      exitCode = 4;
    } else {
      ({ result, exitCode } = await verifySpec(specPath, {
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.config !== undefined ? { config: opts.config } : {}),
        vars,
      }));
    }
  }

  process.stdout.write(emit(format, result, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  process.exit(exitCode);
}

export async function stampSpecContractHash(specPath: string): Promise<string> {
  // Stamp only the contractHash line. Re-serializing via the YAML Document
  // API still rewrites scalar quoting (`"#element_…"` / `"${vars.X}"`),
  // which turns a `#` selector into a comment on the next read.
  const text = await readFile(specPath, "utf8");
  const raw = parseYaml(text);
  assertBatchSelectorLocators(raw, specPath);
  const spec = SpecSchema.parse(raw);
  const hash = computeContractHash(spec);
  await writeFile(specPath, replaceContractHashLine(text, hash));
  return hash;
}

/** Replace or append the top-level `contractHash:` line without rewriting YAML. */
export function replaceContractHashLine(text: string, hash: string): string {
  const line = `contractHash: ${hash}`;
  if (/^contractHash:[^\n]*$/m.test(text)) {
    return text.replace(/^contractHash:[^\n]*$/m, line);
  }
  const prefix = text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
  return `${prefix}${line}\n`;
}

function toMarkdown(r: VerifyResult): string {
  const lines = [`# Verify: ${r.path}`, `Status: ${r.status}`];
  if (r.contractHash) lines.push(`Contract hash: ${r.contractHash}`);
  if (r.referenceFindings !== undefined) {
    lines.push(`Reference audit: ${r.referenceFindings} finding(s)`);
  }
  if (r.environment) {
    lines.push(
      `Environment: ${r.environment.name} — ${
        r.environment.allowed ? "allowed" : `refused (${r.environment.code})`
      }`,
    );
  }
  if (r.environments && r.environments.length > 0) {
    lines.push("", "## Environments");
    for (const e of r.environments) {
      lines.push(
        `- ${e.allowed ? "✓" : "✗"} ${e.name}${e.trait ? ` (${e.trait})` : ""}${
          e.optIn ? ` — needs ${e.optIn}=1` : ""
        }${e.allowed ? "" : ` — ${e.reason}`}${
          e.defined ? "" : " — not defined in the config"
        }`,
      );
    }
  }
  if (r.warnings.length > 0) {
    lines.push("", "## Warnings");
    for (const w of r.warnings) lines.push(`- ${w}`);
  }
  if (r.errors.length > 0) {
    lines.push("", "## Errors");
    for (const e of r.errors) lines.push(`- ${e}`);
  }
  return lines.join("\n");
}
