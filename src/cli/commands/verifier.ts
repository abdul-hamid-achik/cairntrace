import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeVerifierSource } from "../../core/catalog/verifierContract";
import { targetChildEnv } from "../../core/processEnv";
import {
  sdkContractFromSource,
  type VerifierSchemaReport,
} from "../../sdk/contract";
import { DEFAULT_LOAD_TIMEOUT_MS, loadVerifierContract } from "../../sdk/load";
import { emit, resolveFormat } from "../format";

export interface VerifierSchemaCommandOptions {
  load?: boolean;
  timeoutMs?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * `cairn verifier schema <file> [--load] [--timeout-ms N]`: the fixtures
 * contract of a script verifier. Static by default — the file is read as
 * text, never executed. `--load` imports the module in a Node child (killed
 * after --timeout-ms) to read a contract the static reader reports as
 * dynamic; that runs the module's top-level code, so use it only on files
 * you trust. Exit 0 with a report, 2 when the file cannot be read or
 * --load fails.
 */
export async function verifierSchemaCommand(
  file: string,
  opts: VerifierSchemaCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let timeoutMs = DEFAULT_LOAD_TIMEOUT_MS;
  if (opts.timeoutMs !== undefined) {
    timeoutMs = Number(opts.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      process.stderr.write(
        "cairn verifier schema: --timeout-ms must be a positive integer\n",
      );
      process.exitCode = 2;
      return;
    }
  }
  const { report, exitCode } = await buildVerifierSchemaReport(file, {
    load: opts.load === true,
    timeoutMs,
  });
  const out = emit(format, report, renderVerifierSchemaMarkdown);
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  if (exitCode !== 0) process.exitCode = exitCode;
}

export async function buildVerifierSchemaReport(
  file: string,
  opts: { load?: boolean; timeoutMs?: number; cwd?: string } = {},
): Promise<{ report: VerifierSchemaReport; exitCode: number }> {
  const abs = resolve(opts.cwd ?? process.cwd(), file);
  let source: string;
  try {
    source = await readFile(abs, "utf8");
  } catch (e) {
    return {
      report: {
        file,
        exists: false,
        sdk: false,
        mode: "none",
        fixtures: { source: "none", keys: [] },
        error: `cannot read ${file}: ${(e as Error).message}`,
      },
      exitCode: 2,
    };
  }

  const sdk = sdkContractFromSource(source);
  const legacy = analyzeVerifierSource(source);
  const header = legacy.description;
  let report: VerifierSchemaReport;
  if (sdk) {
    const description = sdk.description ?? header;
    report = {
      file,
      exists: true,
      sdk: true,
      mode: sdk.mode,
      ...(description ? { description } : {}),
      fixtures: {
        source: "sdk",
        strict: sdk.strict,
        ...(sdk.mode === "dynamic" ? { dynamic: true } : {}),
        keys: sdk.keys,
      },
      ...(sdk.reason ? { reason: sdk.reason } : {}),
    };
  } else {
    report = {
      file,
      exists: true,
      sdk: false,
      mode: "legacy",
      ...(header ? { description: header } : {}),
      fixtures: {
        source: legacy.source,
        ...(legacy.dynamic ? { dynamic: true } : {}),
        keys: legacy.keys.map((key) => ({
          name: key.name,
          ...(key.type ? { type: key.type } : {}),
          ...(key.required !== undefined ? { required: key.required } : {}),
          ...(key.description ? { description: key.description } : {}),
        })),
      },
      reason:
        "not an SDK verifier: keys come from the header comment, an exported fixtures object, or the code's reads",
    };
  }

  if (!opts.load) return { report, exitCode: 0 };
  try {
    const loaded = await loadVerifierContract(abs, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
      env: targetChildEnv(process.env),
    });
    if (!loaded) {
      return {
        report: {
          ...report,
          reason: "--load: the module exports no defineVerifier() verifier",
        },
        exitCode: 0,
      };
    }
    const description = loaded.description ?? report.description;
    return {
      report: {
        file,
        exists: true,
        sdk: true,
        mode: "loaded",
        ...(description ? { description } : {}),
        fixtures: {
          source: "sdk",
          strict: loaded.strict,
          ...(loaded.dynamic ? { dynamic: true } : {}),
          keys: loaded.keys,
        },
        ...(loaded.reason ? { reason: loaded.reason } : {}),
      },
      exitCode: 0,
    };
  } catch (e) {
    return {
      report: { ...report, error: `--load failed: ${(e as Error).message}` },
      exitCode: 2,
    };
  }
}

export function renderVerifierSchemaMarkdown(r: VerifierSchemaReport): string {
  const lines: string[] = [`# Verifier contract: ${r.file}`, ""];
  if (r.error) lines.push(`**Error:** ${r.error}`, "");
  if (!r.exists) return lines.join("\n");
  const how =
    r.mode === "legacy"
      ? `legacy script (fixtures from ${r.fixtures.source})`
      : `SDK, ${r.mode}`;
  const strict =
    r.fixtures.strict === undefined
      ? ""
      : r.fixtures.strict
        ? " · unknown keys rejected"
        : " · unknown keys allowed";
  lines.push(
    `- contract: ${how}${strict}${r.fixtures.dynamic ? " · incomplete" : ""}`,
  );
  if (r.reason) lines.push(`- note: ${r.reason}`);
  if (r.description) lines.push("", r.description);
  lines.push("");
  if (r.fixtures.keys.length === 0) {
    lines.push("No fixture keys.");
    return lines.join("\n");
  }
  lines.push(
    "| key | type | required | default | description |",
    "|---|---|---|---|---|",
  );
  for (const key of r.fixtures.keys) {
    const type = key.values
      ? `${key.type ?? ""} (${key.values.map((v) => JSON.stringify(v)).join(", ")})`
      : (key.type ?? "");
    lines.push(
      `| ${cell(key.name)} | ${cell(type)} | ${
        key.required === undefined ? "" : key.required ? "yes" : "no"
      } | ${
        key.default === undefined ? "" : cell(JSON.stringify(key.default))
      } | ${cell(key.description ?? "")} |`,
    );
  }
  return lines.join("\n");
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
