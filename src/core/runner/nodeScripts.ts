import { execa } from "execa";

const RESULT_MARKER = "__CAIRNTRACE_RESULT__";

export interface NodeScriptInvocation {
  file?: string;
  source?: string;
  ctx: unknown;
  cwd?: string;
  entryNames: string[];
}

export interface NodeScriptResult {
  ok: boolean;
  result?: unknown;
  error?: { name?: string; message: string; stack?: string };
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runNodeScript(
  invocation: NodeScriptInvocation,
): Promise<NodeScriptResult> {
  const r = await execa("node", ["--input-type=module", "-e", NODE_BOOTSTRAP], {
    cwd: invocation.cwd,
    input: JSON.stringify(invocation),
    reject: false,
    all: false,
  });

  const stdout = String(r.stdout ?? "");
  const stderr = String(r.stderr ?? "");
  const exitCode =
    typeof r.exitCode === "number" ? r.exitCode : r.failed ? 1 : 0;
  const markerIdx = stdout.lastIndexOf(RESULT_MARKER);
  if (markerIdx < 0) {
    return {
      ok: false,
      error: {
        message: "node script did not emit a Cairntrace result",
        stack: stderr || stdout,
      },
      stdout,
      stderr,
      exitCode,
    };
  }

  const beforeMarker = stdout.slice(0, markerIdx);
  const afterMarker = stdout.slice(markerIdx + RESULT_MARKER.length);
  const newlineIdx = afterMarker.search(/\r?\n/);
  const resultText = (
    newlineIdx < 0 ? afterMarker : afterMarker.slice(0, newlineIdx)
  ).trim();
  const afterResult =
    newlineIdx < 0 ? "" : afterMarker.slice(newlineIdx).trim();
  try {
    const parsed = JSON.parse(resultText) as {
      ok: boolean;
      result?: unknown;
      error?: { name?: string; message: string; stack?: string };
    };
    return {
      ok: parsed.ok && exitCode === 0,
      ...(parsed.result !== undefined ? { result: parsed.result } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
      stdout: [beforeMarker.trimEnd(), afterResult].filter(Boolean).join("\n"),
      stderr,
      exitCode,
    };
  } catch (e) {
    return {
      ok: false,
      error: {
        message: `failed to parse node script result: ${(e as Error).message}`,
        stack: resultText,
      },
      stdout: [beforeMarker.trimEnd(), afterResult].filter(Boolean).join("\n"),
      stderr,
      exitCode,
    };
  }
}

const NODE_BOOTSTRAP = `
import { pathToFileURL } from "node:url";
import process from "node:process";

const marker = ${JSON.stringify(RESULT_MARKER)};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function serializeError(error) {
  if (error && typeof error === "object") {
    return {
      name: typeof error.name === "string" ? error.name : undefined,
      message: typeof error.message === "string" ? error.message : String(error),
      stack: typeof error.stack === "string" ? error.stack : undefined,
    };
  }
  return { message: String(error) };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  let fn;
  if (payload.file) {
    const mod = await import(pathToFileURL(payload.file).href + "?cairntrace=" + Date.now());
    for (const name of payload.entryNames) {
      if (typeof mod[name] === "function") {
        fn = mod[name];
        break;
      }
    }
    if (!fn && typeof mod.default === "function") fn = mod.default;
  } else if (payload.source) {
    fn = new AsyncFunction("ctx", payload.source);
  }
  if (typeof fn !== "function") {
    throw new Error("node script must export a function or provide script.run source");
  }
  return await fn(payload.ctx);
}

try {
  const result = await main();
  process.stdout.write("\\n" + marker + JSON.stringify({ ok: true, result }) + "\\n");
} catch (error) {
  const serialized = serializeError(error);
  if (serialized.stack) process.stderr.write(serialized.stack + "\\n");
  else process.stderr.write(serialized.message + "\\n");
  process.stdout.write("\\n" + marker + JSON.stringify({ ok: false, error: serialized }) + "\\n");
  process.exitCode = 1;
}
`;
