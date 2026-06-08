import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSnapshot } from "../../../core/healer/snapshotParser";
import {
  AgentBrowserAdapter,
  buildLocatorDiagnostics,
  collapseNestedMatches,
  matchingSnapshotIndices,
  preferActionableAncestor,
} from "../AgentBrowserAdapter";

const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: execaMock,
}));

describe("AgentBrowserAdapter", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("resolves semantic downloads to an interactive ref before top-level download", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '- main\n  - button "Download template" [ref=e7]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "saved",
        stderr: "",
      });
    const adapter = new AgentBrowserAdapter({ session: "download-test" });

    const result = await adapter.runStep({
      download: {
        by: "role",
        role: "button",
        name: "Download template",
        saveAs: "/tmp/template.xlsx",
        assign: "template",
      },
    });

    expect(result.ok).toBe(true);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "agent-browser",
      ["--session", "download-test", "snapshot", "-i"],
      expect.objectContaining({ reject: false }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      ["--session", "download-test", "download", "@e7", "/tmp/template.xlsx"],
      expect.objectContaining({ reject: false }),
    );
    const secondArgv = execaMock.mock.calls[1]![1] as string[];
    expect(secondArgv).not.toContain("find");
  });

  it("pre-scrolls selector hovers before calling top-level hover", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "hover-test" });

    const result = await adapter.runStep({
      hover: {
        by: "selector",
        selector: ".question-table-wrap .table-title",
      },
    });

    expect(result.ok).toBe(true);
    const evalArgv = execaMock.mock.calls[0]![1] as string[];
    expect(evalArgv[0]).toBe("--session");
    expect(evalArgv[1]).toBe("hover-test");
    expect(evalArgv[2]).toBe("eval");
    expect(evalArgv[3]).toContain("scrollIntoView");
    expect(evalArgv[3]).toContain(".question-table-wrap .table-title");
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      ["--session", "hover-test", "hover", ".question-table-wrap .table-title"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("prefers the enclosing link ref when role=button is nested in a link", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          '- main\n  - link "Download" [ref=e10]\n    - button "Download" [ref=e11]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "saved",
        stderr: "",
      });
    const adapter = new AgentBrowserAdapter({ session: "download-nested" });

    const result = await adapter.runStep({
      download: {
        by: "role",
        role: "button",
        name: "Download",
        saveAs: "/tmp/table-export.xlsx",
        assign: "tableExport",
      },
    });

    expect(result.ok).toBe(true);
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      [
        "--session",
        "download-nested",
        "download",
        "@e10",
        "/tmp/table-export.xlsx",
      ],
      expect.objectContaining({ reject: false }),
    );
  });

  it("polls the snapshot until the locator becomes resolvable", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '- main\n  - paragraph "Generating export…"\n',
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          '- main\n  - dialog "Export ready"\n    - button "Download" [ref=e21]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "saved",
        stderr: "",
      });
    const adapter = new AgentBrowserAdapter({ session: "download-retry" });

    const result = await adapter.runStep({
      download: {
        by: "role",
        role: "button",
        name: "Download",
        saveAs: "/tmp/export.xlsx",
        assign: "export",
        timeoutMs: 5000,
      },
    });

    expect(result.ok).toBe(true);
    // First two calls are snapshot polls; third is the resolved download.
    expect(execaMock.mock.calls[0]![1]).toContain("snapshot");
    expect(execaMock.mock.calls[1]![1]).toContain("snapshot");
    expect(execaMock).toHaveBeenNthCalledWith(
      3,
      "agent-browser",
      ["--session", "download-retry", "download", "@e21", "/tmp/export.xlsx"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("reports role candidates and dialog context when resolve fails", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout:
        '- main\n  - button "Export" [ref=e1]\n  - dialog "Generate export"\n    - button "Generate" [ref=e2]\n    - button "Cancel" [ref=e3]\n',
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "download-fail" });

    const result = await adapter.runStep({
      download: {
        by: "role",
        role: "button",
        name: "Download",
        saveAs: "/tmp/x.xlsx",
        assign: "x",
        timeoutMs: 60,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("could not resolve role=button");
    expect(result.stderr).toContain("matching candidates");
    expect(result.stderr).toContain('button "Export"');
    expect(result.stderr).toMatch(
      /button "Generate".*in dialog "Generate export"/,
    );
  });
});

describe("strict semantic interaction resolution", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("clicks via snapshot ref with a scroll-into-view first, recording the resolved element", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '- main\n  - button "Cobrar plan" [ref=e5]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // scrollintoview
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // click
    const adapter = new AgentBrowserAdapter({ session: "click-test" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Cobrar plan" },
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedElement).toEqual({
      role: "button",
      name: "Cobrar plan",
      ref: "e5",
    });
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "agent-browser",
      ["--session", "click-test", "snapshot", "-i"],
      expect.objectContaining({ reject: false }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      ["--session", "click-test", "scrollintoview", "@e5"],
      expect.objectContaining({ reject: false }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      3,
      "agent-browser",
      ["--session", "click-test", "click", "@e5"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("fails AT the click step when nothing matches (no silent find no-op)", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: '- main\n  - button "Other" [ref=e1]\n',
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({
      session: "click-miss",
      locatorTimeoutMs: 80,
    });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "DoesNotExist" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("element not found");
    expect(result.stderr).toContain("for click");
    expect(result.stderr).toContain('button "Other"');
    // The step never reached a click invocation.
    for (const call of execaMock.mock.calls) {
      expect(call[1] as string[]).not.toContain("click");
    }
  });

  it("matches accessible names case-insensitively as whole names", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '- main\n  - button "GENERAR CHECKOUT" [ref=e3]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "case-test" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Generar checkout" },
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedElement?.ref).toBe("e3");
  });

  it("does NOT substring-match: 'Cobrar' must not bind to 'Cobrar plan'", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: '- main\n  - button "Cobrar plan" [ref=e5]\n',
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({
      session: "substr-test",
      locatorTimeoutMs: 80,
    });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Cobrar" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("element not found");
  });

  it("exact: true is case-sensitive", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: '- main\n  - button "GENERAR CHECKOUT" [ref=e3]\n',
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({
      session: "exact-test",
      locatorTimeoutMs: 80,
    });

    const result = await adapter.runStep({
      click: {
        by: "role",
        role: "button",
        name: "Generar checkout",
        exact: true,
      },
    });

    expect(result.ok).toBe(false);
  });

  it("fails fast on ambiguity, listing candidates and the nth/exact hint", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout:
        '- main\n  - button "Cobrar" [ref=e5]\n  - button "Cobrar" [ref=e9]\n',
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "ambiguous-test" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Cobrar" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("ambiguous");
    expect(result.stderr).toContain("2 visible matches");
    expect(result.stderr).toContain("ref=e5");
    expect(result.stderr).toContain("ref=e9");
    expect(result.stderr).toContain("nth");
    // Failed on the first snapshot — ambiguity doesn't poll until timeout.
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it("nth picks among multiple matches in document order", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          '- main\n  - button "Cobrar" [ref=e5]\n  - button "Cobrar" [ref=e9]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "nth-test" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Cobrar", nth: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedElement?.ref).toBe("e9");
  });

  it("fills via snapshot ref with the value as trailing arg", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '- main\n  - textbox "Email" [ref=e2]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "fill-test" });

    const result = await adapter.runStep({
      fill: { by: "label", name: "Email", value: "a@b.co" },
    });

    expect(result.ok).toBe(true);
    expect(execaMock).toHaveBeenNthCalledWith(
      3,
      "agent-browser",
      ["--session", "fill-test", "fill", "@e2", "a@b.co"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("pre-scrolls selector clicks but skips snapshot resolution", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "sel-click" });

    const result = await adapter.runStep({
      click: { by: "selector", selector: "#submit" },
    });

    expect(result.ok).toBe(true);
    const evalArgv = execaMock.mock.calls[0]![1] as string[];
    expect(evalArgv[2]).toBe("eval");
    expect(evalArgv[3]).toContain("scrollIntoView");
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      ["--session", "sel-click", "click", "#submit"],
      expect.objectContaining({ reject: false }),
    );
  });
});

describe("daemon-busy retry", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("retries a transient os-error-35 failure and succeeds", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr:
          "Failed to read: Resource temporarily unavailable (os error 35) (after 5 retries - daemon may be busy or unresponsive)",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "/page", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "busy-test" });

    const url = await adapter.getUrl();

    expect(url).toBe("/page");
    expect(execaMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("does not retry ordinary failures", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "element not found: #missing",
    });
    const adapter = new AgentBrowserAdapter({ session: "no-retry" });

    const r = await adapter.runStep({
      click: { by: "selector", selector: "#missing" },
    });

    expect(r.ok).toBe(false);
    // 1 eval (scroll) + 1 click — no extra retry invocations.
    expect(execaMock).toHaveBeenCalledTimes(2);
  });
});

describe("child timeout enforcement", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("stamps every invocation with the 60s default deadline", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "deadline" });

    await adapter.runStep({ open: "/dashboard" });

    expect(execaMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "deadline", "navigate", "/dashboard"],
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  it("gives wait steps the spec timeout plus a kill grace period", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "wait-deadline" });

    await adapter.runStep({ wait: { text: "Done", timeoutMs: 12_000 } });

    expect(execaMock).toHaveBeenCalledWith(
      "agent-browser",
      [
        "--session",
        "wait-deadline",
        "wait",
        "--text",
        "Done",
        "--timeout",
        "12000",
      ],
      expect.objectContaining({ timeout: 17_000 }),
    );
  });

  it("fails a killed wait with a normal timeout error (no retry)", async () => {
    execaMock.mockResolvedValue({
      timedOut: true,
      exitCode: undefined,
      stdout: "",
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "wedged" });

    const r = await adapter.runStep({
      wait: { text: "Never", timeoutMs: 1_000 },
    });

    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("timed out after 6000ms");
    expect(r.stderr).toContain("daemon may be unresponsive");
    // A kill is not a daemon-busy hiccup — no backoff retries.
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it("honors an explicit defaultTimeoutMs over the built-in backstop", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({
      session: "custom-deadline",
      defaultTimeoutMs: 5_000,
    });

    await adapter.getUrl();

    expect(execaMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "custom-deadline", "get", "url"],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });
});

describe("batch step", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("runs the whole chain as one `batch --json --bail` invocation", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "batch-test" });

    const result = await adapter.runStep({
      batch: [
        { hover: { by: "selector", selector: "#subcontractor-table" } },
        {
          click: {
            by: "selector",
            selector: '.hover-actions button[aria-label="Upload data"]',
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    // Exactly one CLI invocation — that's the whole point of batch.
    expect(execaMock).toHaveBeenCalledTimes(1);
    const argv = execaMock.mock.calls[0]![1] as string[];
    expect(argv).toEqual([
      "--session",
      "batch-test",
      "batch",
      "--json",
      "--bail",
      "hover #subcontractor-table",
      // selector has spaces + quotes → quoted and escaped for the batch parser
      'click ".hover-actions button[aria-label=\\"Upload data\\"]"',
    ]);
  });

  it("fails the step and names the bailing sub-step", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify([
        { success: true },
        { success: false, error: "element not found: #missing" },
      ]),
      stderr: "batch stopped at command 2",
    });
    const adapter = new AgentBrowserAdapter({ session: "batch-fail" });

    const result = await adapter.runStep({
      batch: [
        { hover: { by: "selector", selector: "#ok" } },
        { click: { by: "selector", selector: "#missing" } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("sub-step #2");
    expect(result.stderr).toContain("click #missing");
    expect(result.stderr).toContain("element not found");
    expect(execaMock).toHaveBeenCalledTimes(1);
  });
});

describe("daemon teardown", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  async function pidFixture(session: string): Promise<{
    stateDir: string;
    exitSignal: Promise<NodeJS.Signals | null>;
  }> {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const stateDir = await mkdtemp(join(tmpdir(), "cairn-ab-state-"));
    const child = spawn("sleep", ["30"]);
    // Attach before the kill so the assertion can't miss the event.
    const exitSignal = new Promise<NodeJS.Signals | null>((r) =>
      child.once("exit", (_code, sig) => r(sig)),
    );
    await writeFile(join(stateDir, `${session}.pid`), `${child.pid}\n`);
    return { stateDir, exitSignal };
  }

  it("close() escalates to a daemon kill after a child timeout", async () => {
    const { stateDir, exitSignal } = await pidFixture("wedged-close");
    execaMock.mockResolvedValue({
      timedOut: true,
      exitCode: undefined,
      stdout: "",
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({
      session: "wedged-close",
      stateDir,
    });

    const wait = await adapter.runStep({
      wait: { text: "Never", timeoutMs: 1_000 },
    });
    expect(wait.ok).toBe(false);

    const closed = await adapter.close();
    expect(closed.ok).toBe(true);
    expect(closed.stdout).toContain("daemon terminated");
    // The graceful `close` command was never issued — only the wait ran.
    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(await exitSignal).toBe("SIGTERM");
  });

  it("terminateSync() kills the session daemon without invoking agent-browser", async () => {
    const { stateDir, exitSignal } = await pidFixture("sig-teardown");
    const adapter = new AgentBrowserAdapter({
      session: "sig-teardown",
      stateDir,
    });

    adapter.terminateSync();

    expect(execaMock).not.toHaveBeenCalled();
    expect(await exitSignal).toBe("SIGTERM");
  });

  it("terminateSync() is a no-op without a pid file", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateDir = await mkdtemp(join(tmpdir(), "cairn-ab-empty-"));
    const adapter = new AgentBrowserAdapter({
      session: "no-daemon",
      stateDir,
    });

    adapter.terminateSync();

    expect(execaMock).not.toHaveBeenCalled();
  });
});

describe("open with waitUntil", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("navigates then waits for the load state", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "open-wait" });

    const result = await adapter.runStep({
      open: { path: "/admin", waitUntil: "networkidle", timeoutMs: 45000 },
    });

    expect(result.ok).toBe(true);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      "agent-browser",
      ["--session", "open-wait", "navigate", "/admin"],
      expect.objectContaining({ reject: false }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      [
        "--session",
        "open-wait",
        "wait",
        "--load",
        "networkidle",
        "--timeout",
        "45000",
      ],
      expect.objectContaining({ reject: false }),
    );
  });

  it("string form stays a single navigate", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "open-plain" });

    const result = await adapter.runStep({ open: "/admin" });

    expect(result.ok).toBe(true);
    expect(execaMock).toHaveBeenCalledTimes(1);
  });
});

describe("scroll-to with semantic locator", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("resolves the locator and issues scrollintoview @ref", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '- main\n  - button "Submit" [ref=e8]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "scroll-test" });

    const result = await adapter.runStep({
      scroll: { to: { by: "role", role: "button", name: "Submit" } },
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedElement?.ref).toBe("e8");
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      ["--session", "scroll-test", "scrollintoview", "@e8"],
      expect.objectContaining({ reject: false }),
    );
  });
});

describe("collapseNestedMatches", () => {
  it("collapses a same-named control nested in its container to one match", () => {
    const snap = parseSnapshot(
      '- main\n  - link "Download" [ref=e10]\n    - button "Download" [ref=e11]\n',
    );
    const idx = matchingSnapshotIndices({ by: "text", text: "Download" }, snap);
    expect(idx).toEqual([1, 2]);
    expect(collapseNestedMatches(idx, snap)).toEqual([1]);
  });

  it("keeps true siblings as separate matches", () => {
    const snap = parseSnapshot(
      '- main\n  - button "Save" [ref=e1]\n  - button "Save" [ref=e2]\n',
    );
    const idx = matchingSnapshotIndices(
      { by: "role", role: "button", name: "Save" },
      snap,
    );
    expect(collapseNestedMatches(idx, snap)).toEqual([1, 2]);
  });
});

describe("matchingSnapshotIndices", () => {
  it("returns indices of elements matching role+name with refs", () => {
    const snap = parseSnapshot(
      '- main\n  - link "Download" [ref=e10]\n    - button "Download" [ref=e11]\n  - button "Download" [ref=e12]\n',
    );
    const idx = matchingSnapshotIndices(
      { by: "role", role: "button", name: "Download" },
      snap,
    );
    // Two buttons match: the nested one and the standalone.
    expect(idx.length).toBe(2);
  });

  it("skips elements without a ref", () => {
    const snap = parseSnapshot('- main\n  - button "Download"\n');
    const idx = matchingSnapshotIndices(
      { by: "role", role: "button", name: "Download" },
      snap,
    );
    expect(idx).toEqual([]);
  });
});

describe("preferActionableAncestor", () => {
  it("returns the enclosing link when a button is nested in a > button", () => {
    const snap = parseSnapshot(
      '- main\n  - link "Download" [ref=e10]\n    - button "Download" [ref=e11]\n',
    );
    // Button is at index 2; link is at index 1.
    const ancestor = preferActionableAncestor(2, snap);
    expect(ancestor?.ref).toBe("e10");
    expect(ancestor?.role).toBe("link");
  });

  it("returns undefined when no link ancestor exists", () => {
    const snap = parseSnapshot('- main\n  - button "Download" [ref=e7]\n');
    expect(preferActionableAncestor(1, snap)).toBeUndefined();
  });

  it("walks past intermediate wrappers to find a link ancestor", () => {
    const snap = parseSnapshot(
      '- main\n  - link "Download" [ref=e10]\n    - generic\n      - button "Download" [ref=e11]\n',
    );
    expect(preferActionableAncestor(3, snap)?.ref).toBe("e10");
  });
});

describe("buildLocatorDiagnostics", () => {
  it("marks candidates inside a dialog", () => {
    const snap = parseSnapshot(
      '- main\n  - button "Export" [ref=e1]\n  - dialog "Export ready"\n    - button "Generate" [ref=e2]\n',
    );
    const lines = buildLocatorDiagnostics(
      { by: "role", role: "button", name: "Download" },
      snap,
    );
    expect(lines.some((l) => l.includes('button "Export"'))).toBe(true);
    expect(
      lines.some((l) => /button "Generate".*in dialog "Export ready"/.test(l)),
    ).toBe(true);
  });

  it("reports an empty-snapshot case clearly", () => {
    expect(
      buildLocatorDiagnostics(
        { by: "role", role: "button", name: "Download" },
        [],
      ),
    ).toEqual(["snapshot was empty"]);
  });
});
