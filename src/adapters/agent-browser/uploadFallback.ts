import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { InvocationResult } from "../browserBackend";

/**
 * agent-browser `upload` sets a file input through CDP
 * `DOM.setFileInputFiles` with a host path. Some Chrome builds accept the path
 * (the command succeeds) but never grant the renderer read access: the page's
 * later XHR/FileReader of that File fails (`net::ERR_ACCESS_DENIED`,
 * `NotReadableError`) and the upload silently never leaves the browser.
 *
 * Before every upload the adapter marks each file input's current File
 * objects (a page-side WeakMap); after it, the target is the input whose
 * files the upload replaced — never another input that merely holds a file
 * with the same name. The adapter probes in the page whether that File is
 * readable; when it is not, it rebuilds the File from the host bytes inside
 * the page (DataTransfer), assigns it to that same input and fires
 * input/change again. The step result records which path was used (`via:
 * setInputFiles | dataTransfer`); when no input holds the uploaded file any
 * more (an app that clears the input on change), readability is reported as
 * not verified. Playwright's setInputFiles hands the renderer the bytes and
 * keeps its native path.
 */

/** Largest file the in-page fallback ships through `eval` (base64). */
export const UPLOAD_FALLBACK_MAX_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
};

export function guessMimeType(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "";
}

/** Page-side registry of each file input's File objects before an upload. */
const MARKS = "__cairnUploadMarks";

/** In-page: remember every file input's current File objects (before the upload). */
export function uploadMarkJs(): string {
  return `(() => {
  const marks = new WeakMap();
  for (const input of document.querySelectorAll("input[type=file]")) {
    marks.set(input, Array.from(input.files || []));
  }
  Object.defineProperty(window, ${JSON.stringify(MARKS)}, { value: marks, configurable: true, enumerable: false, writable: true });
  return true;
})()`;
}

/**
 * In-page: the file inputs the upload changed (their File objects differ
 * from the marked ones) that now hold a file named `name`. Without marks
 * (the mark could not run), every input holding such a file.
 */
function targetInputsJs(name: string): string {
  return `const name = ${JSON.stringify(name)};
  const marks = window[${JSON.stringify(MARKS)}];
  const changed = (input) => {
    if (!marks) return true;
    const before = marks.get(input);
    const now = Array.from(input.files || []);
    return !before || before.length !== now.length || now.some((file, i) => file !== before[i]);
  };
  const inputs = Array.from(document.querySelectorAll("input[type=file]"))
    .filter((input) => input.files && Array.from(input.files).some((f) => f.name === name) && changed(input));`;
}

/** In-page: are the File objects named `name` on the uploaded input readable? */
export function uploadProbeJs(name: string): string {
  return `(async () => {
  ${targetInputsJs(name)}
  let unreadable = 0;
  let error = "";
  for (const input of inputs) {
    for (const file of Array.from(input.files).filter((f) => f.name === name)) {
      try {
        await Promise.race([
          file.slice(0, 1).arrayBuffer(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("read timed out")), 3000)),
        ]);
      } catch (e) {
        unreadable += 1;
        error = String((e && e.name ? e.name + ": " : "") + ((e && e.message) || e));
      }
    }
  }
  return { inputs: inputs.length, marked: Boolean(marks), unreadable, error };
})()`;
}

/** In-page: replace the unreadable File with one built from `base64` bytes. */
export function uploadRebuildJs(
  name: string,
  mimeType: string,
  base64: string,
): string {
  return `(async () => {
  ${targetInputsJs(name)}
  const mime = ${JSON.stringify(mimeType)};
  const binary = atob(${JSON.stringify(base64)});
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  let rebuilt = 0;
  for (const input of inputs) {
    const transfer = new DataTransfer();
    for (const file of Array.from(input.files)) {
      transfer.items.add(file.name === name
        ? new File([bytes], name, { type: file.type || mime, lastModified: Date.now() })
        : file);
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    rebuilt += 1;
  }
  let readable = rebuilt > 0;
  for (const input of inputs) {
    for (const file of Array.from(input.files).filter((f) => f.name === name)) {
      try { await file.slice(0, 1).arrayBuffer(); } catch { readable = false; }
    }
  }
  return { rebuilt, readable, bytes: bytes.length };
})()`;
}

type Evaluate = (
  js: string,
  opts?: { timeoutMs?: number },
) => Promise<InvocationResult>;

function parseJson(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Probe the uploaded file's readability and fall back to the in-page
 * DataTransfer rebuild when the renderer cannot read it. A probe that cannot
 * run (no JSON, eval error) keeps the setInputFiles result: the fallback only
 * fires on positive evidence of an unreadable file.
 */
export async function ensureUploadReadable(
  evaluate: Evaluate,
  uploaded: InvocationResult,
  path: string,
): Promise<InvocationResult> {
  const name = basename(path);
  const native: InvocationResult = { ...uploaded, via: "setInputFiles" };
  const probeRun = await evaluate(uploadProbeJs(name), { timeoutMs: 10_000 });
  const probe = probeRun.ok ? parseJson(probeRun.stdout) : undefined;
  if (probe && probe["marked"] === true && Number(probe["inputs"]) === 0) {
    // The uploaded input no longer holds the file (an app that clears the
    // input on change): its readability cannot be checked from here.
    return {
      ...native,
      detail: `readability of ${name} not verified: no file input holds it after the upload (the app may have cleared the input)`,
    };
  }
  if (!probe || !(Number(probe["unreadable"]) > 0)) return native;
  const reason = String(probe["error"] || "file not readable");
  const failed = (why: string): InvocationResult => ({
    ...uploaded,
    ok: false,
    exitCode: uploaded.exitCode === 0 ? 1 : uploaded.exitCode,
    stderr: `upload: the page cannot read ${name} after setInputFiles (${reason}) and the in-page DataTransfer fallback failed: ${why}`,
    via: "dataTransfer",
  });
  let bytes: Buffer;
  try {
    const size = (await stat(path)).size;
    if (size > UPLOAD_FALLBACK_MAX_BYTES) {
      return failed(
        `${size} bytes is over the ${UPLOAD_FALLBACK_MAX_BYTES}-byte fallback limit`,
      );
    }
    bytes = await readFile(path);
  } catch (e) {
    return failed((e as Error).message);
  }
  const rebuildRun = await evaluate(
    uploadRebuildJs(name, guessMimeType(path), bytes.toString("base64")),
    { timeoutMs: 30_000 },
  );
  const rebuilt = rebuildRun.ok ? parseJson(rebuildRun.stdout) : undefined;
  if (!rebuilt) {
    return failed(
      rebuildRun.ok
        ? `unexpected output ${rebuildRun.stdout.slice(0, 120)}`
        : rebuildRun.stderr.trim().slice(0, 300) ||
            `exit ${rebuildRun.exitCode}`,
    );
  }
  if (!(Number(rebuilt["rebuilt"]) > 0) || rebuilt["readable"] !== true) {
    return failed(
      `rebuilt ${Number(rebuilt["rebuilt"]) || 0} input(s), readable=${String(rebuilt["readable"])}`,
    );
  }
  return {
    ...uploaded,
    durationMs:
      uploaded.durationMs + probeRun.durationMs + rebuildRun.durationMs,
    via: "dataTransfer",
    detail: `the page could not read ${name} after setInputFiles (${reason}); rebuilt it from ${bytes.length} bytes in the page`,
  };
}
