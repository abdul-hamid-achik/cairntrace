import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSnapshot } from "../../../core/healer/snapshotParser";
import {
  AgentBrowserAdapter,
  allMatchesTextJs,
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

  it("does not expose the file.cheap ingest credential to agent-browser", async () => {
    const previous = process.env.FILECHEAP_INGEST_TOKEN;
    process.env.FILECHEAP_INGEST_TOKEN = "publisher-only";
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    try {
      const adapter = new AgentBrowserAdapter({ session: "protected-env" });
      await adapter.runStep({ open: "https://example.com" });
    } finally {
      if (previous === undefined) delete process.env.FILECHEAP_INGEST_TOKEN;
      else process.env.FILECHEAP_INGEST_TOKEN = previous;
    }

    expect(execaMock).toHaveBeenCalledWith(
      "agent-browser",
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({
          FILECHEAP_INGEST_TOKEN: expect.anything(),
        }),
      }),
    );
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

/**
 * Mocked `get box @ref --json` + `eval ... --json` pair reporting the target
 * comfortably inside a 1280x800 viewport at (0,0) scroll — the "scroll
 * actually worked" case that `click`'s post-scroll viewport check should let
 * through without blocking the action.
 */
const IN_VIEWPORT_BOX_AND_METRICS = [
  {
    exitCode: 0,
    stdout: JSON.stringify({
      success: true,
      data: { x: 100, y: 200, width: 80, height: 40 },
      error: null,
    }),
    stderr: "",
  },
  {
    exitCode: 0,
    stdout: JSON.stringify({
      success: true,
      data: {
        origin: "http://example.test",
        result: { scrollX: 0, scrollY: 0, innerWidth: 1280, innerHeight: 800 },
      },
      error: null,
    }),
    stderr: "",
  },
];

type MockExecaResponse = {
  exitCode?: number | undefined;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
};

const respond = (r: MockExecaResponse = {}) =>
  Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...r });
const evalResult = (result: unknown) =>
  respond({
    stdout: JSON.stringify({ success: true, data: { result }, error: null }),
  });

interface MockClickSequenceOpts {
  /** Interactive snapshot body for semantic locator resolution. */
  snapshot?: string;
  /** `data.result` payload of the link classification / folded probe eval. */
  probe?: Record<string, unknown>;
  /** Full response for the probe eval; wins over `probe` when set. */
  onProbe?: () => MockExecaResponse;
  /** `data.result` of the scroll-only rect-settle eval (probe disabled). */
  scrollSettle?: Record<string, unknown> | null;
  /** `data.result` payload of the selector low-level retry-point eval. */
  retryPoint?: Record<string, unknown>;
  /** Response for each delivery `wait --fn` attempt. */
  onDeliveryWait?: () => MockExecaResponse;
  /** Response for the click invocation itself. */
  onClick?: () => MockExecaResponse;
  /** Response for the post-click networkidle settle wait. */
  onSettle?: () => MockExecaResponse;
}

/**
 * Mock the full click invocation sequence by classifying each argv — snapshot,
 * box read, classification/probe eval, viewport-metrics eval, retry-point
 * eval, delivery wait, settle wait, click, low-level retry batch — instead of
 * hard-coding an ordered response queue or matching exact eval script text.
 * Folding a new concern into an existing invocation (the exact shape of the
 * selector rect-settle guard) then changes no test plumbing; ordered queues
 * broke ten of these tests when a settle gate briefly shipped as extra
 * subprocess calls.
 */
function mockClickSequence(opts: MockClickSequenceOpts = {}) {
  execaMock.mockImplementation((_bin: string, argv: string[]) => {
    if (argv.includes("snapshot")) {
      return respond({ stdout: opts.snapshot ?? "" });
    }
    if (argv.includes("box")) return respond(IN_VIEWPORT_BOX_AND_METRICS[0]!);
    if (argv.includes("--fn")) return respond(opts.onDeliveryWait?.());
    if (argv.includes("wait")) return respond(opts.onSettle?.());
    if (argv.includes("click")) return respond(opts.onClick?.());
    if (argv.includes("is") && argv.includes("enabled")) {
      return respond({ stdout: JSON.stringify({ data: { enabled: true } }) });
    }
    if (argv.includes("batch")) {
      return respond({
        stdout: JSON.stringify([
          { success: true },
          { success: true },
          { success: true },
        ]),
      });
    }
    if (argv.includes("eval")) {
      const script = argv[argv.indexOf("eval") + 1] ?? "";
      if (script.includes("scrollX")) {
        return respond(IN_VIEWPORT_BOX_AND_METRICS[1]!);
      }
      if (script.includes("present")) return evalResult(opts.retryPoint ?? {});
      if (script.includes("linkLike")) {
        if (opts.onProbe) return respond(opts.onProbe());
        return evalResult(opts.probe ?? {});
      }
      if (script.includes("__rectSettle")) {
        return evalResult(opts.scrollSettle ?? null);
      }
      return respond();
    }
    return respond();
  });
}

/** A rect-settle report for a target that held still inside the viewport. */
const SETTLED_IN_VIEWPORT = {
  stable: true,
  inViewport: true,
  cx: 640,
  cy: 400,
  innerWidth: 1280,
  innerHeight: 800,
};

describe("strict semantic interaction resolution", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("clicks via snapshot ref with a scroll-into-view first, recording the resolved element", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '- main\n  - button "Pay for plan" [ref=e5]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // scrollintoview
      .mockResolvedValueOnce(IN_VIEWPORT_BOX_AND_METRICS[0]!) // get box (post-scroll check)
      .mockResolvedValueOnce(IN_VIEWPORT_BOX_AND_METRICS[1]!) // eval viewport metrics
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // click
    const adapter = new AgentBrowserAdapter({ session: "click-test" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Pay for plan" },
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedElement).toEqual({
      role: "button",
      name: "Pay for plan",
      ref: "e5",
    });
    // Ordinary buttons do not pay a default networkidle wait.
    // 1 snapshot + 1 scrollintoview + 1 get box + 1 eval metrics + 1 click = 5.
    expect(execaMock).toHaveBeenCalledTimes(5);
    expect(execaMock).toHaveBeenNthCalledWith(
      5,
      "agent-browser",
      ["--session", "click-test", "click", "@e5"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("fails the click loudly instead of silently no-op'ing when the target stays off-viewport after scrollIntoView", async () => {
    // The off-viewport confirmation polls (smooth-scroll tolerance), so the
    // mock must answer by command rather than by call order — the box/metrics
    // pair is re-read every poll tick until the settle budget runs out.
    execaMock.mockImplementation((_bin: string, argv: string[]) => {
      if (argv.includes("snapshot")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: '- main\n  - button "Save" [ref=e9]\n',
          stderr: "",
        });
      }
      if (argv.includes("box")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: { x: 100, y: 2358, width: 80, height: 40 },
            error: null,
          }),
          stderr: "",
        }); // still far below the fold, every read
      }
      if (argv.includes("eval")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: {
              origin: "http://example.test",
              result: {
                scrollX: 0,
                scrollY: 0,
                innerWidth: 1280,
                innerHeight: 577,
              },
            },
            error: null,
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); // scrollintoview
    });
    const adapter = new AgentBrowserAdapter({ session: "fixed-footer-test" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Save" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("stayed off-viewport");
    expect(result.stderr).toContain("position:fixed/sticky");
    // The step never reached a real `click` invocation — no silent no-op.
    for (const call of execaMock.mock.calls) {
      expect(call[1] as string[]).not.toContain("click");
    }
  });

  it("recovers when a smooth scroll lands the target in-viewport mid-poll", async () => {
    // First box read races the CSS scroll-behavior:smooth animation
    // (off-viewport), the poll's second read sees it landed — the click
    // must proceed instead of failing the step.
    let boxReads = 0;
    execaMock.mockImplementation((_bin: string, argv: string[]) => {
      if (argv.includes("snapshot")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: '- main\n  - button "ELEGIR PLAN" [ref=e22]\n',
          stderr: "",
        });
      }
      if (argv.includes("box")) {
        boxReads += 1;
        const y = boxReads === 1 ? 1286 : 420; // travelling → landed
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: { x: 798, y, width: 80, height: 40 },
            error: null,
          }),
          stderr: "",
        });
      }
      if (argv.includes("eval")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: {
              origin: "http://example.test",
              result: {
                scrollX: 0,
                scrollY: 0,
                innerWidth: 1280,
                innerHeight: 900,
              },
            },
            error: null,
          }),
          stderr: "",
        });
      }
      // scrollintoview, click, post-click settle wait
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const adapter = new AgentBrowserAdapter({ session: "smooth-scroll-test" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "ELEGIR PLAN" },
    });

    expect(result.ok).toBe(true);
    expect(boxReads).toBe(2);
    const clicked = execaMock.mock.calls.some((call) =>
      (call[1] as string[]).includes("click"),
    );
    expect(clicked).toBe(true);
  });

  it("does not flag an in-view target on a scrolled page (box is viewport-relative)", async () => {
    // Regression: `get box` coordinates are viewport-relative, so a target
    // properly centered after scrolling far down the page (scrollY=816)
    // must NOT be treated as off-viewport. The old check subtracted
    // scrollY from an already-viewport-relative y and failed every
    // legitimately-scrolled click.
    execaMock.mockImplementation((_bin: string, argv: string[]) => {
      if (argv.includes("snapshot")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: '- main\n  - link "CREAR CUENTA" [ref=e17]\n',
          stderr: "",
        });
      }
      if (argv.includes("box")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: { x: 673, y: 266.765625, width: 422, height: 44 },
            error: null,
          }),
          stderr: "",
        });
      }
      if (argv.includes("eval")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: {
              origin: "http://example.test",
              result: {
                scrollX: 0,
                scrollY: 816,
                innerWidth: 1280,
                innerHeight: 577,
              },
            },
            error: null,
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const adapter = new AgentBrowserAdapter({ session: "scrolled-in-view" });

    const result = await adapter.runStep({
      click: { by: "role", role: "link", name: "CREAR CUENTA" },
    });

    expect(result.ok).toBe(true);
    const clicked = execaMock.mock.calls.some((call) =>
      (call[1] as string[]).includes("click"),
    );
    expect(clicked).toBe(true);
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
      .mockResolvedValueOnce(IN_VIEWPORT_BOX_AND_METRICS[0]!)
      .mockResolvedValueOnce(IN_VIEWPORT_BOX_AND_METRICS[1]!)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "/x", stderr: "" }) // pre-settle get url
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // wait
      .mockResolvedValueOnce({ exitCode: 0, stdout: "/x", stderr: "" }); // post-settle get url
    const adapter = new AgentBrowserAdapter({ session: "case-test" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Generar checkout" },
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedElement?.ref).toBe("e3");
  });

  it("does NOT substring-match: 'Pay' must not bind to 'Pay for plan'", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: '- main\n  - button "Pay for plan" [ref=e5]\n',
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({
      session: "substr-test",
      locatorTimeoutMs: 80,
    });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Pay" },
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
        '- main\n  - button "Pay" [ref=e5]\n  - button "Pay" [ref=e9]\n  - button "Pay" [ref=e10]\n  - button "Pay" [ref=e11]\n',
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "ambiguous-test" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Pay" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("ambiguous");
    expect(result.stderr).toContain("4 visible matches");
    expect(result.stderr).toContain("ref=e5");
    expect(result.stderr).toContain("ref=e9");
    expect(result.stderr).toContain("ref=e10");
    expect(result.stderr).not.toContain("ref=e11");
    expect(result.stderr).toContain("…and 1 more");
    expect(result.stderr).toContain("nth");
    // Failed on the first snapshot — ambiguity doesn't poll until timeout.
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it("nth picks among multiple matches in document order", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          '- main\n  - button "Pay" [ref=e5]\n  - button "Pay" [ref=e9]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce(IN_VIEWPORT_BOX_AND_METRICS[0]!)
      .mockResolvedValueOnce(IN_VIEWPORT_BOX_AND_METRICS[1]!)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "/y", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "/y", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "nth-test" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Pay", nth: 1 },
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
    expect(execaMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "sel-click", "click", "#submit"],
      expect.objectContaining({ reject: false }),
    );
    expect(
      execaMock.mock.calls.filter((call) =>
        (call[1] as string[]).includes("click"),
      ),
    ).toHaveLength(1);
  });
});

describe("select step", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("pre-scrolls selector selects and passes the choice as trailing arg", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "select-sel" });

    const result = await adapter.runStep({
      select: { by: "selector", selector: "#plan", value: "pro" },
    });

    expect(result.ok).toBe(true);
    const evalArgv = execaMock.mock.calls[0]![1] as string[];
    expect(evalArgv[2]).toBe("eval");
    expect(evalArgv[3]).toContain("scrollIntoView");
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      ["--session", "select-sel", "select", "#plan", "pro"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("passes label as the same trailing arg (agent-browser matches value OR label)", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "select-label-arg" });

    const result = await adapter.runStep({
      select: { by: "selector", selector: "#plan", label: "Pro plan" },
    });

    expect(result.ok).toBe(true);
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      ["--session", "select-label-arg", "select", "#plan", "Pro plan"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("selects via snapshot ref for semantic locators, recording the resolved element", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '- main\n  - combobox "Plan" [ref=e2]\n',
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // scrollintoview
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // select
    const adapter = new AgentBrowserAdapter({ session: "select-semantic" });

    const result = await adapter.runStep({
      select: { by: "label", name: "Plan", value: "pro" },
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedElement).toEqual({
      role: "combobox",
      name: "Plan",
      ref: "e2",
    });
    expect(execaMock).toHaveBeenNthCalledWith(
      3,
      "agent-browser",
      ["--session", "select-semantic", "select", "@e2", "pro"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("surfaces agent-browser's option-listing error on a non-matching choice", async () => {
    execaMock.mockImplementation((_bin: string, argv: string[]) => {
      if (argv.includes("select")) {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr:
            '✗ No option matched ["gold"]. Available options: basic ("Basic plan"), pro ("Pro plan")',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const adapter = new AgentBrowserAdapter({ session: "select-miss" });

    const result = await adapter.runStep({
      select: { by: "selector", selector: "#plan", value: "gold" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("No option matched");
    expect(result.stderr).toContain("Available options");
  });
});

describe("selector fill drives date-ish inputs natively", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  /** Every argv is answered by kind: the folded scroll+fill eval gets `report`. */
  function mockFillSequence(report: unknown) {
    execaMock.mockImplementation((_bin: string, argv: string[]) => {
      if (argv.includes("eval")) return evalResult(report);
      return respond();
    });
  }

  it.each([
    ["date", "2026-07-16"],
    ["time", "13:45"],
    ["datetime-local", "2026-07-16T13:45"],
  ])(
    "sets an <input type=%s> value in the scroll eval — no keystroke fill invocation",
    async (type, value) => {
      mockFillSequence({ dateish: true, type, applied: true, value });
      const adapter = new AgentBrowserAdapter({ session: "fill-dateish" });

      const result = await adapter.runStep({
        fill: { by: "selector", selector: "#field", value },
      });

      expect(result.ok).toBe(true);
      // The scroll eval this path already paid handles the whole fill:
      // one invocation, and agent-browser's keystroke `fill` (which reports
      // ✓ Done while a date input's value stays empty) never runs.
      expect(execaMock).toHaveBeenCalledTimes(1);
      const evalArgv = execaMock.mock.calls[0]![1] as string[];
      const script = evalArgv[evalArgv.indexOf("eval") + 1]!;
      expect(script).toContain("scrollIntoView");
      expect(script).toContain(JSON.stringify(value));
      expect(script).toContain("dispatchEvent");
    },
  );

  it("fails loudly when the browser sanitizes an invalid value to empty", async () => {
    mockFillSequence({
      dateish: true,
      type: "date",
      applied: false,
      value: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "fill-date-bad" });

    const result = await adapter.runStep({
      fill: { by: "selector", selector: "#birth-date", value: "2026-7-16" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('rejected value "2026-7-16"');
    expect(result.stderr).toContain("YYYY-MM-DD");
    // Never fall back to the keystroke fill that would silently no-op.
    for (const call of execaMock.mock.calls) {
      expect(call[1] as string[]).not.toContain("fill");
    }
  });

  it("keeps ordinary text inputs on the normal fill invocation (unchanged path)", async () => {
    mockFillSequence({ dateish: false });
    const adapter = new AgentBrowserAdapter({ session: "fill-text" });

    const result = await adapter.runStep({
      fill: { by: "selector", selector: "#name", value: "Ada" },
    });

    expect(result.ok).toBe(true);
    // Same invocation count as before the date-ish probe existed:
    // scroll eval + fill.
    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      ["--session", "fill-text", "fill", "#name", "Ada"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("falls through to fill when the probe is inconclusive (element missing)", async () => {
    mockFillSequence(null);
    const adapter = new AgentBrowserAdapter({ session: "fill-inconclusive" });

    const result = await adapter.runStep({
      fill: { by: "selector", selector: "#gone", value: "x" },
    });

    // The normal fill invocation still runs — agent-browser's own
    // element-not-found error and selector diagnostics are the better signal.
    expect(result.ok).toBe(true);
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "agent-browser",
      ["--session", "fill-inconclusive", "fill", "#gone", "x"],
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
    // Folded scroll+link-kind probe (one eval) + click + failure diagnostics
    // each run once; none is retried as a transient daemon error.
    expect(execaMock).toHaveBeenCalledTimes(3);
    expect(
      execaMock.mock.calls.filter((call) =>
        (call[1] as string[]).includes("click"),
      ),
    ).toHaveLength(1);
  });
});

describe("selector failure diagnostics", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("lists the first three accessible names and omitted count", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // scroll
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "strict mode violation",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            result: {
              count: 70,
              candidates: [
                { tag: "button", role: "button", name: "Save member" },
                { tag: "button", role: "button", name: "Cancel" },
                { tag: "button", role: "button", name: "Delete" },
              ],
            },
          },
        }),
        stderr: "",
      });
    const adapter = new AgentBrowserAdapter({ session: "selector-details" });

    const result = await adapter.runStep({
      hover: { by: "selector", selector: "button" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("selector matched 70 elements");
    expect(result.stderr).toContain('button "Save member"');
    expect(result.stderr).toContain('button "Cancel"');
    expect(result.stderr).toContain('button "Delete"');
    expect(result.stderr).toContain("67 more omitted");
  });
});

describe("screenshot timeout", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("hard-bounds capture at 15s and retains a rendering-surface hint", async () => {
    execaMock.mockResolvedValueOnce({
      timedOut: true,
      exitCode: undefined,
      stdout: "",
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "screenshot-hang" });

    const result = await adapter.screenshot({ path: "/tmp/hung.png" });

    expect(result.ok).toBe(false);
    expect(execaMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "screenshot-hang", "screenshot", "/tmp/hung.png"],
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(result.error).toContain("no rendering surface");
    expect(result.error).toContain("display asleep/headless");
    expect(adapter.isWedged()).toBe(true);
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

  it("gives wait steps the sliced timeout plus a kill grace period", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "wait-deadline" });

    await adapter.runStep({ wait: { text: "Done", timeoutMs: 12_000 } });

    // A passing wait finishes in slice #1 — the sliced --timeout (5000, the
    // WAIT_SLICE_MS floor for a 12000ms budget), not the full spec timeout.
    expect(execaMock).toHaveBeenCalledWith(
      "agent-browser",
      [
        "--session",
        "wait-deadline",
        "wait",
        "--fn",
        expect.stringContaining('includes("done")'),
        "--timeout",
        "5000",
      ],
      expect.objectContaining({ timeout: 10_000 }),
    );
    expect(execaMock).toHaveBeenCalledTimes(1);
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

describe("wait step slicing", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("passes through on the first slice when the budget exceeds one slice", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "wait-first-slice" });

    const result = await adapter.runStep({
      wait: { text: "Ready", timeoutMs: 30_000 },
    });

    expect(result.ok).toBe(true);
    // Happy path costs exactly one invocation, sliced to WAIT_SLICE_MS
    // (5000ms), not the full 30000ms spec budget.
    expect(execaMock).toHaveBeenCalledTimes(1);
    const argv = execaMock.mock.calls[0]![1] as string[];
    expect(argv).toEqual([
      "--session",
      "wait-first-slice",
      "wait",
      "--fn",
      expect.stringContaining('includes("ready")'),
      "--timeout",
      "5000",
    ]);
  });

  it("re-issues a timed-out wait as fresh slices until the budget is spent", async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    execaMock.mockImplementation((_bin: string, argv: string[]) => {
      const sliceMs = Number(argv[argv.indexOf("--timeout") + 1]);
      // Each slice consumes its own wall-clock budget before reporting a
      // (non-killed) agent-browser timeout — the shape a healthy daemon
      // produces when the state predicate never becomes true.
      now += sliceMs;
      return Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "✗ Operation timed out",
      });
    });
    const adapter = new AgentBrowserAdapter({ session: "wait-slice" });

    const result = await adapter.runStep({
      wait: { text: "Ready", timeoutMs: 12_000 },
    });

    expect(result.ok).toBe(false);
    expect(execaMock).toHaveBeenCalledTimes(3);
    const timeouts = execaMock.mock.calls.map((call) => {
      const argv = call[1] as string[];
      return argv[argv.indexOf("--timeout") + 1];
    });
    // 12000ms budget → 5000 + 5000 + 2000 (remainder), never exceeding
    // WAIT_SLICE_MS per slice.
    expect(timeouts).toEqual(["5000", "5000", "2000"]);
    expect(result.stderr).toContain(
      "wait exhausted its 12000ms budget across 3 fresh live-document polls",
    );
    nowSpy.mockRestore();
  });

  it("stops immediately on a non-timeout error instead of retrying", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "no active session",
    });
    const adapter = new AgentBrowserAdapter({ session: "wait-error" });

    const result = await adapter.runStep({
      wait: { text: "Ready", timeoutMs: 12_000 },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("no active session");
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it("stops after a child-kill (wedged daemon) instead of retrying", async () => {
    execaMock.mockResolvedValue({
      timedOut: true,
      exitCode: undefined,
      stdout: "",
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "wait-wedged" });

    const result = await adapter.runStep({
      wait: { text: "Ready", timeoutMs: 12_000 },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("daemon may be unresponsive");
    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(adapter.isWedged()).toBe(true);
  });

  it("never slices a load-state wait", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "wait-load" });

    await adapter.runStep({
      wait: { load: "networkidle", timeoutMs: 12_000 },
    });

    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock).toHaveBeenCalledWith(
      "agent-browser",
      [
        "--session",
        "wait-load",
        "wait",
        "--load",
        "networkidle",
        "--timeout",
        "12000",
      ],
      expect.objectContaining({ timeout: 17_000 }),
    );
  });

  it("keeps a budgetless wait a single invocation", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "wait-nobudget" });

    await adapter.runStep({ wait: { text: "Ready" } });

    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock).toHaveBeenCalledWith(
      "agent-browser",
      [
        "--session",
        "wait-nobudget",
        "wait",
        "--fn",
        expect.stringContaining('includes("ready")'),
      ],
      expect.objectContaining({ timeout: 60_000 }),
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
      stdout: JSON.stringify([
        { success: true },
        { success: true },
        { success: true },
        { success: true },
        { success: true },
      ]),
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
    expect(argv.slice(0, 6)).toEqual([
      "--session",
      "batch-test",
      "batch",
      "--json",
      "--bail",
      "hover #subcontractor-table",
    ]);
    expect(argv).toHaveLength(10);
    expect(argv[6]).toMatch(/^eval -b [A-Za-z0-9+/=]+$/);
    expect(argv[7]).toBe(
      'click ".hover-actions button[aria-label=\\"Upload data\\"]"',
    );
    expect(argv[8]).toBe("wait 100");
    expect(argv[9]).toContain("wait --fn");
    expect(argv[9]).toContain("recoveryAttempted");
    expect(argv[9]).toContain("recoveryAfter");
    expect(argv[9]).toContain("aria === 'mixed'");
    // The verifier re-queries after a framework rerender and uses native click
    // at most once if the original CDP gesture was silently dropped.
    expect(argv[9]).toContain("document.querySelector");
    expect(argv[9]!.match(/\.click\(\)/g)).toHaveLength(1);
    // Two-stage verification: a stage-2 settle window (settleAfter) and a loud
    // double-toggle failure guard against a late authored commit + the
    // recovery click both landing and flipping the control back.
    expect(argv[9]).toContain("settleAfter");
    expect(argv[9]).toContain("double-toggled");
    expect(argv[9]).toContain("throw new Error");
  });

  it("fails loudly when exit-zero batch output omits command results", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([{ success: true }]),
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "batch-short-output" });

    const result = await adapter.runStep({
      batch: [
        { hover: { by: "selector", selector: "#ok" } },
        { click: { by: "selector", selector: "#check" } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "batch returned 1 result(s) for 5 command(s)",
    );
  });

  it("requires every exit-zero batch result to explicitly report success", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([{}, {}, {}, {}, {}]),
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({
      session: "batch-implicit-success",
    });

    const result = await adapter.runStep({
      batch: [
        { hover: { by: "selector", selector: "#ok" } },
        { click: { by: "selector", selector: "#check" } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("batch failed at sub-step #1");
  });

  it("fails the step and names the bailing sub-step", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify([
        { success: true },
        { success: true },
        { success: false, error: "element not found: #missing" },
      ]),
      stderr: "batch stopped at command 3",
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

  it("maps an expanded verification failure back to the authored click", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify([
        { success: true }, // authored hover
        { success: true }, // click state probe
        { success: true }, // authored click
        { success: true }, // 100ms pace
        { success: false, error: "Operation timed out" }, // state verify
      ]),
      stderr: "batch stopped at command 5",
    });
    const adapter = new AgentBrowserAdapter({ session: "batch-verify-fail" });

    const result = await adapter.runStep({
      batch: [
        { hover: { by: "selector", selector: "#ok" } },
        { click: { by: "selector", selector: "#parq-smokes-no" } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("sub-step #2");
    expect(result.stderr).toContain("click #parq-smokes-no");
    expect(result.stderr).toContain("post-click state verification");
  });

  it("surfaces a double-toggle failure thrown by the in-batch verifier", async () => {
    // The in-browser verify expression throws when a recovery click landed a
    // second toggle and flipped the control back; that error must propagate
    // (never be swallowed into a silent pass) with the authored click named.
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify([
        { success: true }, // authored hover
        { success: true }, // click state probe
        { success: true }, // authored click
        { success: true }, // 100ms pace
        {
          success: false,
          error:
            "batch click double-toggled: recovery click landed a second toggle and the control returned to its original state",
        }, // state verify throw
      ]),
      stderr: "batch stopped at command 5",
    });
    const adapter = new AgentBrowserAdapter({ session: "batch-double-toggle" });

    const result = await adapter.runStep({
      batch: [
        { hover: { by: "selector", selector: "#ok" } },
        { click: { by: "selector", selector: "#parq-smokes-no" } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("sub-step #2");
    expect(result.stderr).toContain("post-click state verification");
    expect(result.stderr).toContain("double-toggled");
  });

  it("fails on an embedded batch error even when the process exits zero", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        { success: true },
        { success: true },
        { success: false, error: "click was rejected" },
      ]),
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "batch-embedded-fail" });

    const result = await adapter.runStep({
      batch: [
        { hover: { by: "selector", selector: "#ok" } },
        { click: { by: "selector", selector: "#bad" } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sub-step #2");
    expect(result.stderr).toContain("click was rejected");
  });
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

describe("daemon teardown", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

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

  it("close() escalates to a daemon kill when the graceful close itself fails", async () => {
    const { stateDir, exitSignal } = await pidFixture("graceful-fail");
    // No prior child timeout — sawChildTimeout stays false. The graceful
    // `close` client itself fails (a wedged daemon times it out), so close()
    // must still escalate to killing the daemon rather than orphaning it.
    execaMock.mockResolvedValue({
      timedOut: true,
      exitCode: undefined,
      stdout: "",
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({
      session: "graceful-fail",
      stateDir,
    });

    const closed = await adapter.close();
    expect(closed.ok).toBe(true);
    expect(closed.stdout).toContain("daemon terminated");
    // The graceful `close` was attempted once; escalation kills via process
    // signals (not execa), so exactly one execa call.
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

describe("isWedged signal", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("is false on a fresh adapter and flips to true after a child timeout", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "wedged-signal" });

    expect(adapter.isWedged()).toBe(false);
    await adapter.runStep({ open: "/x" });
    expect(adapter.isWedged()).toBe(false);

    execaMock.mockResolvedValueOnce({
      timedOut: true,
      exitCode: undefined,
      stdout: "",
      stderr: "",
    });
    await adapter.runStep({ wait: { text: "x", timeoutMs: 1_000 } });
    expect(adapter.isWedged()).toBe(true);
  });
});

describe("verify-after-click + post-nav settle", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("skips the default networkidle wait for an ordinary non-navigation button", async () => {
    mockClickSequence({ snapshot: '- main\n  - button "Toggle" [ref=e1]\n' });
    const adapter = new AgentBrowserAdapter({ session: "stable-url" });

    const r = await adapter.runStep({
      click: { by: "role", role: "button", name: "Toggle" },
    });
    expect(r.ok).toBe(true);
    expect(execaMock).toHaveBeenCalledTimes(5);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("networkidle"),
      ),
    ).toBe(false);
  });

  it("fails the click when an explicitly-authored settle times out", async () => {
    mockClickSequence({
      snapshot: '- main\n  - button "ELEGIR PLAN" [ref=e22]\n',
      onSettle: () => ({
        timedOut: true,
        exitCode: undefined,
        stdout: "",
        stderr: "",
      }), // post-click settle times out
    });
    const adapter = new AgentBrowserAdapter({ session: "wedged-click" });

    const r = await adapter.runStep({
      click: { by: "role", role: "button", name: "ELEGIR PLAN" },
      settleMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("post-click settle");
    // sawChildTimeout flipped — close() will now escalate to a daemon kill.
    expect(adapter.isWedged()).toBe(true);
  });

  it("does not run the settle fold when verifyAfterClick is false", async () => {
    mockClickSequence({ snapshot: '- main\n  - button "Cancel" [ref=e1]\n' });
    const adapter = new AgentBrowserAdapter({
      session: "verify-off",
      verifyAfterClick: false,
    });

    await adapter.runStep({
      click: { by: "role", role: "button", name: "Cancel" },
    });
    // No settle, no extra get url.
    expect(execaMock).toHaveBeenCalledTimes(5);
  });

  it("widens the settle wait to postClickSettleMs when configured", async () => {
    mockClickSequence({
      snapshot: '- main\n  - button "INICIAR SESIÓN" [ref=e3]\n',
    });
    const adapter = new AgentBrowserAdapter({
      session: "wide-settle",
      postClickSettleMs: 20_000,
    });

    const r = await adapter.runStep({
      click: { by: "role", role: "button", name: "INICIAR SESIÓN" },
    });
    expect(r.ok).toBe(true);
    const settleCall = execaMock.mock.calls.find((call) =>
      (call[1] as string[]).includes("networkidle"),
    )?.[1] as string[];
    expect(settleCall).toContain("wait");
    expect(settleCall).toContain("--timeout");
    expect(settleCall[settleCall.indexOf("--timeout") + 1]).toBe("20000");
  });

  it("scales a configured settle and extends the networkidle quiet window", async () => {
    mockClickSequence({
      snapshot: '- main\n  - button "Save" [ref=e3]\n',
    });
    const adapter = new AgentBrowserAdapter({
      session: "scaled-settle",
      postClickSettleMs: 5_000,
    });
    adapter.setWaitScale(3);

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Save" },
    });

    expect(result.ok).toBe(true);
    const settleCall = execaMock.mock.calls.find((call) =>
      (call[1] as string[]).includes("networkidle"),
    )?.[1] as string[];
    expect(settleCall[settleCall.indexOf("--timeout") + 1]).toBe("15000");
    const quietCall = execaMock.mock.calls.find((call) =>
      String((call[1] as string[]).join(" ")).includes(
        "performance.getEntriesByType",
      ),
    )?.[1] as string[];
    expect(quietCall).toContain("--fn");
    expect(quietCall.join(" ")).toContain(">= 1500");
  });

  it("prefers the click settleMs override over the adapter config", async () => {
    mockClickSequence({ snapshot: '- main\n  - button "Save" [ref=e3]\n' });
    const adapter = new AgentBrowserAdapter({
      session: "step-settle",
      postClickSettleMs: 20_000,
    });

    await adapter.runStep({
      click: { by: "role", role: "button", name: "Save" },
      settleMs: 1_234,
    });

    const settleCall = execaMock.mock.calls.find((call) =>
      (call[1] as string[]).includes("networkidle"),
    )?.[1] as string[];
    expect(settleCall[settleCall.indexOf("--timeout") + 1]).toBe("1234");
  });

  it("settleMs: 0 skips the networkidle fold AND the link-delivery probe", async () => {
    // A resolved settleMs of 0 is the author declaring they handle post-click
    // waiting; even a role=link click then runs no delivery `wait --fn` probe
    // and no networkidle settle.
    mockClickSequence({ snapshot: '- main\n  - link "Ver agenda" [ref=e3]\n' });
    const adapter = new AgentBrowserAdapter({ session: "zero-settle" });

    const result = await adapter.runStep({
      click: { by: "role", role: "link", name: "Ver agenda" },
      settleMs: 0,
    });

    expect(result.ok).toBe(true);
    // snapshot + scrollintoview + box + metrics + click — no probe, no settle.
    expect(execaMock).toHaveBeenCalledTimes(5);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("--fn"),
      ),
    ).toBe(false);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("networkidle"),
      ),
    ).toBe(false);
  });

  it("retries the adapter's own 'daemon may be unresponsive' timeout message", async () => {
    // Mirrors a production pattern: a click that doesn't land produces
    // a 30s agent-browser --timeout hit, surfacing the adapter's own
    // generated stderr. The fixed regex now matches it for one retry.
    mockClickSequence({
      snapshot: '- main\n  - button "Submit" [ref=e1]\n',
      onSettle: () => ({
        timedOut: true,
        exitCode: undefined,
        stdout: "",
        stderr: "",
      }), // settle times out — invoke retries once on the transient-daemon regex
    });
    const adapter = new AgentBrowserAdapter({ session: "retry-unresponsive" });

    await adapter.runStep({
      click: { by: "role", role: "button", name: "Submit" },
      settleMs: 5_000,
    });
    // 1 snapshot + 1 scrollintoview + 1 get box + 1 metrics + 1 click + 1 settle
    // (the retry short-circuits because sawChildTimeout is now true). The
    // retry guard breaks the backoff loop after one attempt — but with
    // sawChildTimeout set BEFORE the retry the guard's `if (this.sawChildTimeout)
    // break` fires, so we get one settle invocation total here. = 6.
    expect(adapter.isWedged()).toBe(true);
    expect(execaMock).toHaveBeenCalledTimes(6);
  });
});

describe("link click delivery recovery", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("retries a dropped semantic link click once with low-level mouse input", async () => {
    let deliveryChecks = 0;
    execaMock.mockImplementation((_bin: string, argv: string[]) => {
      if (argv.includes("snapshot")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: '- main\n  - link "Ver agenda" [ref=e7]\n',
          stderr: "",
        });
      }
      if (argv.includes("box")) {
        return Promise.resolve(IN_VIEWPORT_BOX_AND_METRICS[0]!);
      }
      if (argv.includes("eval")) {
        const script = argv[argv.indexOf("eval") + 1] ?? "";
        if (script.includes("innerWidth")) {
          return Promise.resolve(IN_VIEWPORT_BOX_AND_METRICS[1]!);
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: {
              result: {
                linkLike: true,
                beforeUrl: "http://app.test/admin",
                beforeTimeOrigin: 123,
              },
            },
          }),
          stderr: "",
        });
      }
      if (argv.includes("--fn")) {
        deliveryChecks += 1;
        return Promise.resolve(
          deliveryChecks === 1
            ? { exitCode: 1, stdout: "", stderr: "Operation timed out" }
            : { exitCode: 0, stdout: "", stderr: "" },
        );
      }
      if (argv.includes("is") && argv.includes("enabled")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ data: { enabled: true } }),
          stderr: "",
        });
      }
      if (argv.includes("batch")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify([
            { success: true },
            { success: true },
            { success: true },
          ]),
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const adapter = new AgentBrowserAdapter({ session: "link-retry-role" });

    const result = await adapter.runStep({
      click: { by: "role", role: "link", name: "Ver agenda" },
    });

    expect(result.ok).toBe(true);
    expect(result.stderr).toContain("one low-level mouse retry");
    expect(deliveryChecks).toBe(2);
    const deliveryWait = execaMock.mock.calls.find((call) =>
      (call[1] as string[]).includes("--fn"),
    );
    expect(JSON.stringify(deliveryWait?.[1])).toContain(
      "performance.timeOrigin !== 123",
    );
    const mouseBatches = execaMock.mock.calls.filter((call) =>
      (call[1] as string[]).includes("batch"),
    );
    expect(mouseBatches).toHaveLength(1);
    const mouseArgv = mouseBatches[0]![1] as string[];
    expect(mouseArgv).toContain("mouse move 140 220");
    expect(mouseArgv).toContain("mouse down left");
    expect(mouseArgv).toContain("mouse up left");
    // Delivery confirmation is the default handoff; a healthy link must not
    // be false-failed by a second, implicit networkidle wait.
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("networkidle"),
      ),
    ).toBe(false);
  });

  it("does not queue a recovery command after the delivery child hard-times out", async () => {
    execaMock.mockImplementation((_bin: string, argv: string[]) => {
      if (argv.includes("snapshot")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: '- main\n  - link "Ver agenda" [ref=e7]\n',
          stderr: "",
        });
      }
      if (argv.includes("box")) {
        return Promise.resolve(IN_VIEWPORT_BOX_AND_METRICS[0]!);
      }
      if (argv.includes("eval")) {
        const script = argv[argv.indexOf("eval") + 1] ?? "";
        if (script.includes("innerWidth")) {
          return Promise.resolve(IN_VIEWPORT_BOX_AND_METRICS[1]!);
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: {
              result: {
                linkLike: true,
                beforeUrl: "http://app.test/admin",
              },
            },
          }),
          stderr: "",
        });
      }
      if (argv.includes("--fn")) {
        return Promise.resolve({
          timedOut: true,
          exitCode: undefined,
          stdout: "",
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const adapter = new AgentBrowserAdapter({ session: "link-hard-timeout" });

    const result = await adapter.runStep({
      click: { by: "role", role: "link", name: "Ver agenda" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("browser backend became unresponsive");
    expect(result.stderr).toContain("low-level retry skipped");
    expect(adapter.isWedged()).toBe(true);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("batch"),
      ),
    ).toBe(false);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("enabled"),
      ),
    ).toBe(false);
  });

  it("does not click after the before-click delivery probe hard-times out", async () => {
    execaMock.mockImplementation((_bin: string, argv: string[]) => {
      if (argv.includes("snapshot")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: '- main\n  - link "Ver agenda" [ref=e7]\n',
          stderr: "",
        });
      }
      if (argv.includes("box")) {
        return Promise.resolve(IN_VIEWPORT_BOX_AND_METRICS[0]!);
      }
      if (argv.includes("eval")) {
        const script = argv[argv.indexOf("eval") + 1] ?? "";
        if (script.includes("innerWidth")) {
          return Promise.resolve(IN_VIEWPORT_BOX_AND_METRICS[1]!);
        }
        if (script.includes("MutationObserver")) {
          return Promise.resolve({
            timedOut: true,
            exitCode: undefined,
            stdout: "",
            stderr: "",
          });
        }
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const adapter = new AgentBrowserAdapter({ session: "link-probe-timeout" });

    const result = await adapter.runStep({
      click: { by: "role", role: "link", name: "Ver agenda" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("timed out after");
    expect(adapter.isWedged()).toBe(true);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("click"),
      ),
    ).toBe(false);
  });

  it("fails a selector anchor loudly when its one retry is also dropped", async () => {
    let deliveryChecks = 0;
    // The folded selector-click probe scrolls, rect-settles, AND classifies
    // in one eval; the low-level retry point is resolved by its own eval.
    mockClickSequence({
      probe: {
        linkLike: true,
        beforeUrl: "http://app.test/guest",
        settle: SETTLED_IN_VIEWPORT,
      },
      retryPoint: { present: true, enabled: true, x: 320, y: 180 },
      onDeliveryWait: () => {
        deliveryChecks += 1;
        return { exitCode: 1, stdout: "", stderr: "Operation timed out" };
      },
    });
    const adapter = new AgentBrowserAdapter({ session: "link-retry-selector" });

    const result = await adapter.runStep({
      click: { by: "selector", selector: "a.continue-as-guest" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("after one low-level mouse retry");
    expect(deliveryChecks).toBe(2);
    expect(
      execaMock.mock.calls.filter((call) =>
        (call[1] as string[]).includes("batch"),
      ),
    ).toHaveLength(1);
    // Delivery failed, so no post-click networkidle settle is attempted.
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("networkidle"),
      ),
    ).toBe(false);
  });

  it("uses delivered same-tab link evidence as the default handoff without networkidle", async () => {
    execaMock.mockImplementation((_bin: string, argv: string[]) => {
      if (argv.includes("snapshot")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: '- main\n  - link "Dashboard" [ref=e4]\n',
          stderr: "",
        });
      }
      if (argv.includes("box")) {
        return Promise.resolve(IN_VIEWPORT_BOX_AND_METRICS[0]!);
      }
      if (argv.includes("eval")) {
        const script = argv[argv.indexOf("eval") + 1] ?? "";
        return Promise.resolve(
          script.includes("innerWidth")
            ? IN_VIEWPORT_BOX_AND_METRICS[1]!
            : {
                exitCode: 0,
                stdout: JSON.stringify({
                  data: {
                    result: {
                      linkLike: true,
                      beforeUrl: "http://app.test/start",
                    },
                  },
                }),
                stderr: "",
              },
        );
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const adapter = new AgentBrowserAdapter({ session: "link-first-try" });

    const result = await adapter.runStep({
      click: { by: "role", role: "link", name: "Dashboard" },
    });

    expect(result.ok).toBe(true);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("batch"),
      ),
    ).toBe(false);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("--fn"),
      ),
    ).toBe(true);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("networkidle"),
      ),
    ).toBe(false);
  });

  it("never applies the low-level retry to ordinary buttons", async () => {
    mockClickSequence({ snapshot: '- main\n  - button "Save" [ref=e1]\n' });
    const adapter = new AgentBrowserAdapter({ session: "button-no-retry" });

    const result = await adapter.runStep({
      click: { by: "role", role: "button", name: "Save" },
    });

    expect(result.ok).toBe(true);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("batch"),
      ),
    ).toBe(false);
  });

  it("clicks a target=_blank link once and passes without the delivery probe", async () => {
    mockClickSequence({
      snapshot: '- main\n  - link "Abrir factura" [ref=e7]\n',
      probe: {
        linkLike: true,
        externalReason: 'target="_blank"',
        beforeUrl: "http://app.test/invoices",
      },
    });
    const adapter = new AgentBrowserAdapter({ session: "external-blank" });

    const result = await adapter.runStep({
      click: { by: "role", role: "link", name: "Abrir factura" },
    });

    expect(result.ok).toBe(true);
    expect(result.stderr).toContain("opens/handles outside this document");
    // Exactly one click; no same-document delivery wait and no physical retry.
    expect(
      execaMock.mock.calls.filter((call) =>
        (call[1] as string[]).includes("click"),
      ),
    ).toHaveLength(1);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("--fn"),
      ),
    ).toBe(false);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("batch"),
      ),
    ).toBe(false);
    // The classification eval really does inspect download/target/scheme.
    const classifyEval = execaMock.mock.calls.find((call) => {
      const a = call[1] as string[];
      return a.includes("eval") && !JSON.stringify(a).includes("innerWidth");
    });
    const classifySrc = JSON.stringify(classifyEval?.[1]);
    expect(classifySrc).toContain("download");
    expect(classifySrc).toContain("_self");
    expect(classifySrc).toContain("externalReason");
  });

  it("clicks a download-attribute selector anchor once with a diagnostic note", async () => {
    // The folded scroll+settle+classify eval reports an external-effect link.
    mockClickSequence({
      probe: {
        linkLike: true,
        externalReason: "a download attribute",
        beforeUrl: "http://app.test/report",
        settle: SETTLED_IN_VIEWPORT,
      },
    });
    const adapter = new AgentBrowserAdapter({ session: "external-download" });

    const result = await adapter.runStep({
      click: { by: "selector", selector: "a[download]" },
    });

    expect(result.ok).toBe(true);
    expect(result.stderr).toContain("a download attribute");
    expect(
      execaMock.mock.calls.filter((call) =>
        (call[1] as string[]).includes("click"),
      ),
    ).toHaveLength(1);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("--fn"),
      ),
    ).toBe(false);
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("batch"),
      ),
    ).toBe(false);
  });
});

describe("selector click rect-settle guard", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("fails a selector click loudly when the target settles off-viewport", async () => {
    // Regression: a `by: selector` click into a transitioning
    // sheet used to skip the ref path's off-viewport guard entirely —
    // agent-browser exits 0 and the step reported ✓ while the app's handler
    // never fired.
    mockClickSequence({
      probe: {
        linkLike: false,
        beforeUrl: "http://app.test/calendar",
        settle: {
          stable: true,
          inViewport: false,
          cx: 1384,
          cy: 400,
          innerWidth: 1280,
          innerHeight: 800,
        },
      },
    });
    const adapter = new AgentBrowserAdapter({ session: "sel-settle-off" });

    const result = await adapter.runStep({
      click: { by: "selector", selector: ".sheet button.save" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("stayed off-viewport after scrollIntoView");
    expect(result.stderr).toContain("(1384, 400)");
    expect(result.stderr).toContain("1280x800");
    expect(result.stderr).toContain("viewport: { width, height }");
    // The click is never dispatched at a coordinate the target has left.
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("click"),
      ),
    ).toBe(false);
  });

  it("fails a selector click when the rect never stops moving (stuck transition)", async () => {
    mockClickSequence({
      probe: {
        linkLike: false,
        beforeUrl: "http://app.test/calendar",
        settle: {
          stable: false,
          inViewport: true,
          cx: 900,
          cy: 400,
          innerWidth: 1280,
          innerHeight: 800,
        },
      },
    });
    const adapter = new AgentBrowserAdapter({ session: "sel-settle-moving" });

    const result = await adapter.runStep({
      click: { by: "selector", selector: ".sheet button.save" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("still moving");
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("click"),
      ),
    ).toBe(false);
  });

  it("passes a stable in-viewport selector click with no extra invocations", async () => {
    mockClickSequence({
      probe: {
        linkLike: false,
        beforeUrl: "http://app.test/form",
        settle: SETTLED_IN_VIEWPORT,
      },
    });
    const adapter = new AgentBrowserAdapter({ session: "sel-settle-ok" });

    const result = await adapter.runStep({
      click: { by: "selector", selector: "#save" },
    });

    expect(result.ok).toBe(true);
    // Folded scroll+settle+classify eval + click = 2 — no default
    // networkidle invocation, and the guard rides the eval already paid for.
    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(
      execaMock.mock.calls.filter((call) =>
        (call[1] as string[]).includes("click"),
      ),
    ).toHaveLength(1);
  });

  it("guards the selector click even when the probe is disabled (settleMs: 0)", async () => {
    mockClickSequence({
      scrollSettle: {
        stable: true,
        inViewport: false,
        cx: 640,
        cy: 1100,
        innerWidth: 1280,
        innerHeight: 800,
      },
    });
    const adapter = new AgentBrowserAdapter({ session: "sel-settle-noprobe" });

    const result = await adapter.runStep({
      click: { by: "selector", selector: "#footer-cta" },
      settleMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("stayed off-viewport after scrollIntoView");
    expect(
      execaMock.mock.calls.some((call) =>
        (call[1] as string[]).includes("click"),
      ),
    ).toBe(false);
  });

  it("never blocks the click on an inconclusive settle report", async () => {
    // Parity with detectOffViewportAfterScroll: a report the eval couldn't
    // produce (old page, agent-browser hiccup) must not fail the step.
    mockClickSequence({
      probe: { linkLike: false, beforeUrl: "http://app.test/form" },
    });
    const adapter = new AgentBrowserAdapter({ session: "sel-settle-unknown" });

    const result = await adapter.runStep({
      click: { by: "selector", selector: "#save" },
    });

    expect(result.ok).toBe(true);
    expect(
      execaMock.mock.calls.filter((call) =>
        (call[1] as string[]).includes("click"),
      ),
    ).toHaveLength(1);
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

  it("domcontentloaded waits via a readyState --fn predicate (not --load)", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "open-dcl" });

    const result = await adapter.runStep({
      open: { path: "/admin", waitUntil: "domcontentloaded" },
    });

    expect(result.ok).toBe(true);
    const waitArgv = (execaMock.mock.calls[1]![1] as string[]).slice(2);
    expect(waitArgv).toEqual([
      "wait",
      "--fn",
      "document.readyState !== 'loading'",
    ]);
  });

  it("load waits via a complete-state --fn predicate", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "open-load" });

    await adapter.runStep({
      open: { path: "/admin", waitUntil: "load", timeoutMs: 5000 },
    });

    const waitArgv = (execaMock.mock.calls[1]![1] as string[]).slice(2);
    expect(waitArgv).toEqual([
      "wait",
      "--fn",
      "document.readyState === 'complete'",
      "--timeout",
      "5000",
    ]);
  });

  it("networkidle timeout is treated as success (a quiet page never re-fires idle)", async () => {
    execaMock
      // navigate succeeds
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      // the networkidle wait times out — the shape agent-browser emits on a
      // page that was already idle (idle never re-fires after navigate).
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "✗ Operation timed out",
      });
    const adapter = new AgentBrowserAdapter({ session: "open-idle-to" });

    const result = await adapter.runStep({
      open: { path: "/admin", waitUntil: "networkidle", timeoutMs: 2000 },
    });

    expect(result.ok).toBe(true);
    expect(result.stderr).toBe("");
  });

  it("networkidle non-timeout error still propagates", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "navigation failed: net::ERR_CONNECTION_REFUSED",
      });
    const adapter = new AgentBrowserAdapter({ session: "open-idle-err" });

    const result = await adapter.runStep({
      open: { path: "/admin", waitUntil: "networkidle" },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("ERR_CONNECTION_REFUSED");
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

describe("getText reads every match, not just the first", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("reads all matches so an absence assertion can't miss text in match #2", async () => {
    // `get text` returns only the first match, so a region matching two nodes
    // let notText report "confirmed absent" for text sitting in the second.
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify("A\nB"),
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "multimatch" });

    await expect(adapter.getText(".t")).resolves.toBe("A\nB");
    const argv = execaMock.mock.calls[0]?.[1] as string[];
    expect(argv).toContain("eval");
    expect(argv.join(" ")).toContain("querySelectorAll");
  });

  it("maps the 'page' sentinel onto body", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify("hello"),
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "multimatch" });

    await adapter.getText("page");
    const argv = execaMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(argv?.join(" ")).toContain('"body"');
  });

  it("keeps the direct read for a @ref, which resolves one element and is not a CSS selector", async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "just me", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "multimatch" });

    await expect(adapter.getText("@e7")).resolves.toBe("just me");
    expect(execaMock.mock.calls[0]?.[1] as string[]).toEqual(
      expect.arrayContaining(["get", "text", "@e7"]),
    );
  });

  it("throws rather than returning '' when the eval result is unreadable", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "not json at all",
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "multimatch" });

    await expect(adapter.getText(".t")).rejects.toThrow(
      /unreadable `eval` result/,
    );
  });

  it("builds JS that joins every match the way Playwright's allInnerTexts does", () => {
    const js = allMatchesTextJs(".t");
    expect(js).toContain('querySelectorAll(".t")');
    expect(js).toContain("join('\\n')");
  });
});

describe("read failures fail loudly instead of reporting a green verdict", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("getText throws instead of degrading to '' — an empty haystack reads as 'confirmed absent'", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "✗ Element not found.",
    });
    const adapter = new AgentBrowserAdapter({ session: "read-fail" });

    await expect(adapter.getText("#toast")).rejects.toThrow(
      /could not read text from "#toast".*Element not found/s,
    );
  });

  it("getCount throws on a failed invocation instead of degrading to 0", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "✗ Invalid selector.",
    });
    const adapter = new AgentBrowserAdapter({ session: "read-fail" });

    await expect(adapter.getCount("::bogus")).rejects.toThrow(
      /could not count elements matching "::bogus".*Invalid selector/s,
    );
  });

  it("getCount still returns 0 for a selector that legitimately matches nothing", async () => {
    // `get count` exits 0 with "0" — the notText region guard depends on this
    // staying a value rather than becoming a throw.
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "0\n", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "read-fail" });

    await expect(adapter.getCount("#absent")).resolves.toBe(0);
  });

  it("reads the live value of a selector input", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "Ada",
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "read-value" });

    await expect(
      adapter.getValue({ by: "selector", selector: "#name" }),
    ).resolves.toBe("Ada");
    expect(execaMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["get", "value", "#name"]),
    );
  });

  it("getCount throws when stdout is not a number rather than silently reporting 0", async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "not-a-number",
      stderr: "",
    });
    const adapter = new AgentBrowserAdapter({ session: "read-fail" });

    await expect(adapter.getCount("#weird")).rejects.toThrow(
      /expected a number from `get count`, got "not-a-number"/,
    );
  });

  it("getErrors throws when the page-errors probe fails — [] would report 'no errors' for an unread page", async () => {
    // `errors` fails, `console` succeeds: the old code returned the console
    // half and silently dropped the page-error half, so console.errorsMax:0
    // passed over errors nobody observed.
    execaMock.mockImplementation((_bin: string, argv: string[]) =>
      Promise.resolve(
        argv.includes("errors")
          ? { exitCode: 1, stdout: "", stderr: "daemon unreachable" }
          : {
              exitCode: 0,
              stdout: JSON.stringify({ messages: [] }),
              stderr: "",
            },
      ),
    );
    const adapter = new AgentBrowserAdapter({ session: "read-fail" });

    await expect(adapter.getErrors()).rejects.toThrow(
      /could not read page errors.*daemon unreachable/s,
    );
  });

  it("getErrors throws when the console probe fails", async () => {
    execaMock.mockImplementation((_bin: string, argv: string[]) =>
      Promise.resolve(
        argv.includes("console")
          ? { exitCode: 1, stdout: "", stderr: "daemon unreachable" }
          : { exitCode: 0, stdout: JSON.stringify({ errors: [] }), stderr: "" },
      ),
    );
    const adapter = new AgentBrowserAdapter({ session: "read-fail" });

    await expect(adapter.getErrors()).rejects.toThrow(
      /could not read the console log.*daemon unreachable/s,
    );
  });

  it("getConsole throws rather than reporting an empty console it never read", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "daemon unreachable",
    });
    const adapter = new AgentBrowserAdapter({ session: "read-fail" });

    await expect(adapter.getConsole()).rejects.toThrow(
      /could not read the console log.*daemon unreachable/s,
    );
  });

  it("getCount throws on exit-0-with-blank-stdout instead of reporting a clean 0", async () => {
    // Number("") is 0 and Number.isFinite(0) is true, so a silent invocation
    // would otherwise satisfy `count: {equals: 0}` without counting anything.
    execaMock.mockResolvedValue({ exitCode: 0, stdout: "  \n", stderr: "" });
    const adapter = new AgentBrowserAdapter({ session: "read-fail" });

    await expect(adapter.getCount("#quiet")).rejects.toThrow(
      /expected a number from `get count`, got ""/,
    );
  });

  it("getNetworkRequests throws instead of degrading to [] — noFailedRequests reads an empty set as a PASS", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "daemon unreachable",
    });
    const adapter = new AgentBrowserAdapter({ session: "read-fail" });

    await expect(adapter.getNetworkRequests()).rejects.toThrow(
      /could not read network requests.*daemon unreachable/s,
    );
  });
});
