import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSnapshot } from "../../../core/healer/snapshotParser";
import {
  AgentBrowserAdapter,
  buildLocatorDiagnostics,
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
      [
        "--session",
        "download-retry",
        "download",
        "@e21",
        "/tmp/export.xlsx",
      ],
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
    expect(result.stderr).toMatch(/button "Generate".*in dialog "Generate export"/);
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
