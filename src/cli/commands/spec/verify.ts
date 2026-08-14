import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { coldStartLint } from "../../../core/coldStart";
import { computeContractHash } from "../../../core/contractHash";
import { resolveSpecRuntimeContext } from "../../../core/config/runtimeContext";
import {
  assertBatchSelectorLocators,
  ContractHashMismatchError,
  parseSpec,
} from "../../../core/parser/parseSpec";
import { auditPlaceholderReferences } from "../../../core/referenceAudit";
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
  /** Placeholder reference findings from the static audit (0 when clean). */
  referenceFindings?: number;
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

      // Static placeholder reference audit: `${env.X}` without a default and
      // `${secrets.X}` no provider supplies both substitute to an EMPTY string
      // at run time (parseSpec resolves them silently). Catch them here — in
      // seconds, before the run — instead of as a confusing mid-run failure.
      const auditFiles: Array<{ path: string; text: string }> = [
        { path: specPath, text: await readFile(specPath, "utf8") },
      ];
      for (const action of parsed.actionsByName.values()) {
        auditFiles.push({
          path: action.path,
          text: await readFile(action.path, "utf8"),
        });
      }
      const findings = auditPlaceholderReferences(auditFiles, {
        secretsRequired: runtime.config?.secrets?.required,
      });
      result.referenceFindings = findings.length;
      for (const f of findings) {
        result.errors.push(`${f.file}: ${f.token} — ${f.message}`);
      }
      if (findings.length > 0) {
        result.status = "invalid";
        exitCode = 4;
      }
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
