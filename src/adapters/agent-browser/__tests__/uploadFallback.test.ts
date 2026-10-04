import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext, Script } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvocationResult } from "../../browserBackend";
import {
  ensureUploadReadable,
  guessMimeType,
  uploadMarkJs,
  uploadProbeJs,
  uploadRebuildJs,
} from "../uploadFallback";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));

const uploaded: InvocationResult = {
  ok: true,
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 5,
  argv: ["upload"],
};

function evalResult(value: unknown, ok = true): InvocationResult {
  return {
    ok,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: ok ? "" : "eval failed",
    exitCode: ok ? 0 : 1,
    durationMs: 2,
    argv: ["eval"],
  };
}

async function fixtureFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cairntrace-upload-"));
  const path = join(dir, "upload-sample.pdf");
  await writeFile(path, Buffer.from("%PDF-1.4 fake bytes"));
  return path;
}

/** A fake page File whose bytes can (or cannot) be read. */
function file(name: string, readable = true) {
  return {
    name,
    slice: () => ({
      arrayBuffer: () =>
        readable
          ? Promise.resolve(new ArrayBuffer(1))
          : Promise.reject(new Error("NotReadableError")),
    }),
  };
}

describe("upload readability fallback (agent-browser)", () => {
  it("keeps setInputFiles when the page can read the file", async () => {
    const evaluate = vi.fn(async () =>
      evalResult({ inputs: 1, unreadable: 0, error: "" }),
    );
    const result = await ensureUploadReadable(
      evaluate,
      uploaded,
      await fixtureFile(),
    );
    expect(result).toMatchObject({ ok: true, via: "setInputFiles" });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("keeps setInputFiles when the probe cannot run (no evidence of an unreadable file)", async () => {
    const evaluate = vi.fn(async () => evalResult("ok"));
    const result = await ensureUploadReadable(
      evaluate,
      uploaded,
      await fixtureFile(),
    );
    expect(result).toMatchObject({ ok: true, via: "setInputFiles" });
  });

  it("rebuilds an unreadable file from bytes in the page (DataTransfer) and records why", async () => {
    const path = await fixtureFile();
    const scripts: string[] = [];
    const evaluate = vi.fn(async (js: string) => {
      scripts.push(js);
      return scripts.length === 1
        ? evalResult({
            inputs: 1,
            unreadable: 1,
            error: "NotReadableError: The requested file could not be read",
          })
        : evalResult({ rebuilt: 1, readable: true, bytes: 19 });
    });
    const result = await ensureUploadReadable(evaluate, uploaded, path);
    expect(result).toMatchObject({ ok: true, via: "dataTransfer" });
    expect(result.detail).toContain("NotReadableError");
    expect(result.detail).toContain("rebuilt it from 19 bytes");
    expect(scripts[1]).toContain(
      Buffer.from("%PDF-1.4 fake bytes").toString("base64"),
    );
    expect(scripts[1]).toContain('"application/pdf"');
  });

  it("fails the upload when the rebuild cannot make the file readable", async () => {
    let call = 0;
    const evaluate = vi.fn(async () =>
      ++call === 1
        ? evalResult({ inputs: 1, unreadable: 1, error: "read timed out" })
        : evalResult({ rebuilt: 1, readable: false }),
    );
    const result = await ensureUploadReadable(
      evaluate,
      uploaded,
      await fixtureFile(),
    );
    expect(result.ok).toBe(false);
    expect(result.via).toBe("dataTransfer");
    expect(result.stderr).toContain("DataTransfer fallback failed");
  });

  it("probes only the input the upload changed, never another holding a same-named file", async () => {
    const other = { files: [file("sample.pdf", false)] };
    const target = { files: [] as unknown[] };
    const page: Record<string, unknown> = {
      document: { querySelectorAll: () => [other, target] },
      setTimeout,
    };
    page["window"] = page;
    const context = createContext(page);
    runInContext(uploadMarkJs(), context);
    // The upload replaces the target's files; the other input is untouched.
    target.files = [file("sample.pdf")];
    const probe = (await runInContext(
      uploadProbeJs("sample.pdf"),
      context,
    )) as { inputs: number; unreadable: number; marked: boolean };
    expect(probe).toMatchObject({ inputs: 1, unreadable: 0, marked: true });
    // An app that clears the input on change leaves nothing to verify.
    target.files = [];
    expect(
      await runInContext(uploadProbeJs("sample.pdf"), context),
    ).toMatchObject({ inputs: 0, marked: true });
    const cleared = await ensureUploadReadable(
      async () => evalResult({ inputs: 0, unreadable: 0, marked: true }),
      uploaded,
      await fixtureFile(),
    );
    expect(cleared).toMatchObject({ ok: true, via: "setInputFiles" });
    expect(cleared.detail).toContain("not verified");
  });

  it("emits page scripts that compile and guesses common MIME types", () => {
    expect(() => new Script(uploadProbeJs('weird "name".pdf'))).not.toThrow();
    expect(
      () =>
        new Script(uploadRebuildJs("a.xlsx", guessMimeType("a.xlsx"), "QQ==")),
    ).not.toThrow();
    expect(guessMimeType("/x/Report.XLSX")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(guessMimeType("/x/unknown.bin")).toBe("");
  });
});

describe("AgentBrowserAdapter upload + eval transport", () => {
  beforeEach(() => execaMock.mockReset());

  it("probes readability after an upload and records via setInputFiles", async () => {
    const { AgentBrowserAdapter } = await import("../AgentBrowserAdapter");
    execaMock.mockImplementation(async (_bin: string, argv?: string[]) =>
      (argv ?? []).at(-1)?.includes("upload-sample.pdf") &&
      (argv ?? []).includes("eval")
        ? {
            exitCode: 0,
            stdout: JSON.stringify({ inputs: 1, unreadable: 0, error: "" }),
            stderr: "",
          }
        : { exitCode: 0, stdout: "ok", stderr: "" },
    );
    const adapter = new AgentBrowserAdapter({ session: "upload-probe" });
    const result = await adapter.runStep({
      upload: {
        by: "selector",
        selector: "input[type=file]",
        path: await fixtureFile(),
      },
    });
    expect(result).toMatchObject({ ok: true, via: "setInputFiles" });
    const calls = execaMock.mock.calls.map(
      (call) => (call[1] as string[] | undefined) ?? [],
    );
    const uploadAt = calls.findIndex((argv) => argv.includes("upload"));
    const probeAt = calls.findLastIndex((argv) => argv.includes("eval"));
    expect(uploadAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeGreaterThan(uploadAt);
    expect(calls[probeAt]!.at(-1)).toContain("upload-sample.pdf");
  });

  it("sends a credential-carrying or byte-heavy script on stdin, a small one in argv", async () => {
    const { AgentBrowserAdapter } = await import("../AgentBrowserAdapter");
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "1", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "stdin-small" });
    await adapter.evaluate("1 + 1");
    await adapter.evaluate("fetch('/api', { headers: {} })", {
      sensitive: true,
    });
    // 40k three-byte characters: under 96k characters, over 96 KiB of UTF-8.
    const wide = `(() => ${JSON.stringify("\u20ac".repeat(40_000))}.length)()`;
    await adapter.evaluate(wide);
    const argvs = execaMock.mock.calls.map((call) => call[1] as string[]);
    expect(argvs[0]).toEqual(["--session", "stdin-small", "eval", "1 + 1"]);
    expect(argvs[1]).toEqual(["--session", "stdin-small", "eval", "--stdin"]);
    expect(argvs[2]).toEqual(["--session", "stdin-small", "eval", "--stdin"]);
  });

  it("sends a large eval script on stdin instead of argv", async () => {
    const { AgentBrowserAdapter } = await import("../AgentBrowserAdapter");
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "1", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "stdin" });
    const big = `(() => { const pad = ${JSON.stringify("x".repeat(120_000))}; return pad.length; })()`;
    await adapter.evaluate(big);
    const [, argv, options] = execaMock.mock.calls[0]! as [
      string,
      string[],
      { input?: string },
    ];
    expect(argv).toEqual(["--session", "stdin", "eval", "--stdin"]);
    expect(options.input).toBe(big);
  });
});
