import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, parseDocument } from "yaml";
import { computeContractHash } from "../../../core/contractHash";
import { resolveSpecRuntimeContext } from "../../../core/config/runtimeContext";
import {
  ContractHashMismatchError,
  parseSpec,
} from "../../../core/parser/parseSpec";
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

interface VerifyResult {
  status: "valid" | "invalid" | "stamped";
  path: string;
  contractHash?: string;
  warnings: string[];
  errors: string[];
}

export async function verifyCommand(
  specPath: string,
  opts: VerifyOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const result: VerifyResult = {
    status: "valid",
    path: specPath,
    warnings: [],
    errors: [],
  };
  let exitCode = 0;

  try {
    if (opts.stamp) {
      const hash = await stampSpecContractHash(specPath);
      result.status = "stamped";
      result.contractHash = hash;
    } else {
      const vars = parseVarFlags(opts.var);
      const runtime = await resolveSpecRuntimeContext(specPath, {
        ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
        ...(opts.config !== undefined ? { configPath: opts.config } : {}),
        ...(Object.keys(vars).length > 0 ? { vars } : {}),
      });
      const parsed = await parseSpec(specPath, {
        vars: runtime.vars,
        ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
      });
      result.contractHash = parsed.spec.contractHash;
      if (!parsed.spec.contractHash) {
        result.warnings.push(
          "spec has no contractHash; run `cairn spec verify <file> --stamp` to lock it",
        );
      }
      // Cold-start contract lint (plan §10.6)
      const c = coldStartLint(parsed.spec);
      if (c) result.warnings.push(c);
    }
  } catch (e) {
    if (e instanceof ContractHashMismatchError) {
      result.status = "invalid";
      result.errors.push(`contract hash mismatch: ${e.message}`);
      exitCode = 6;
    } else {
      result.status = "invalid";
      result.errors.push((e as Error).message);
      exitCode = 4;
    }
  }

  process.stdout.write(emit(format, result, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  process.exit(exitCode);
}

export async function stampSpecContractHash(specPath: string): Promise<string> {
  // Stamp mode: compute the contractHash from the validated spec, then update
  // ONLY the contractHash node via the YAML Document API. A full re-serialize
  // would re-emit every scalar in PLAIN style and strip hand-authored quoting
  // (e.g. "${vars.X}" / "${secrets.X}"); the Document API preserves the rest of
  // the file — quoting, comments, key order — untouched.
  const text = await readFile(specPath, "utf8");
  const raw = parseYaml(text);
  const spec = SpecSchema.parse(raw);
  const hash = computeContractHash(spec);
  const doc = parseDocument(text);
  doc.set("contractHash", hash);
  await writeFile(specPath, doc.toString());
  return hash;
}

function coldStartLint(
  spec: Awaited<ReturnType<typeof parseSpec>>["spec"],
): string | undefined {
  const hasImports = (spec.imports?.length ?? 0) > 0;
  const hasResume = !!spec.session?.resume;
  const hasPreCmds = (spec.preconditions?.commands?.length ?? 0) > 0;
  if (!hasImports && !hasResume && !hasPreCmds) {
    return "cold-start: no imports, no session.resume, and no preconditions.commands. Specs without setup likely cannot replay from a fresh browser.";
  }
  return undefined;
}

function toMarkdown(r: VerifyResult): string {
  const lines = [`# Verify: ${r.path}`, `Status: ${r.status}`];
  if (r.contractHash) lines.push(`Contract hash: ${r.contractHash}`);
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
