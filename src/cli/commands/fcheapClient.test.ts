import { beforeEach, describe, expect, it, vi } from "vitest";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));

import { runFcheap } from "./fcheapClient";

describe("file.cheap child environment", () => {
  beforeEach(() => {
    execaMock.mockReset();
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    });
  });

  it("does not expose the ingest token to non-publish commands by default", async () => {
    const previous = process.env.FILECHEAP_INGEST_TOKEN;
    process.env.FILECHEAP_INGEST_TOKEN = "publisher-only";
    try {
      await runFcheap(["list"], { json: true });
    } finally {
      if (previous === undefined) delete process.env.FILECHEAP_INGEST_TOKEN;
      else process.env.FILECHEAP_INGEST_TOKEN = previous;
    }

    expect(execaMock).toHaveBeenCalledWith(
      "fcheap",
      ["list", "--json"],
      expect.objectContaining({
        // execa merges process.env back in unless extendEnv is false.
        extendEnv: false,
        env: expect.not.objectContaining({
          FILECHEAP_INGEST_TOKEN: expect.anything(),
        }),
      }),
    );
  });

  it("uses an explicitly scoped publisher environment verbatim", async () => {
    await runFcheap(["publish", "/tmp/archive.tar.gz"], {
      env: {
        PATH: "/usr/bin",
        FILECHEAP_INGEST_TOKEN: "publisher-only",
      },
    });

    expect(execaMock).toHaveBeenCalledWith(
      "fcheap",
      ["publish", "/tmp/archive.tar.gz"],
      expect.objectContaining({
        env: {
          PATH: "/usr/bin",
          FILECHEAP_INGEST_TOKEN: "publisher-only",
        },
      }),
    );
  });
});

describe("file.cheap failure classification and capability probes", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("maps failures to path-free reason codes", async () => {
    const { classifyFcheapFailure } = await import("./fcheapClient");
    expect(classifyFcheapFailure({ missing: true, stderr: "" })).toBe(
      "fcheap-missing",
    );
    expect(classifyFcheapFailure({ timedOut: true, stderr: "" })).toBe(
      "timeout",
    );
    expect(classifyFcheapFailure({ stderr: "HTTP 401 Unauthorized" })).toBe(
      "auth",
    );
    expect(classifyFcheapFailure({ stderr: "413: artifact too large" })).toBe(
      "too-large",
    );
    expect(classifyFcheapFailure({ stderr: "disk full" })).toBe("save-failed");
    expect(classifyFcheapFailure({ stderr: "error: auth expired" })).toBe(
      "auth",
    );
    // A path or word that merely contains "auth" is not an auth failure.
    expect(
      classifyFcheapFailure({
        stderr:
          "save failed: write /tmp/x/2026-10-02T10-00-00-000Z_oauth_login_abc123/run.json: no space left on device",
      }),
    ).toBe("save-failed");
    expect(
      classifyFcheapFailure({ stderr: "error: author field missing" }),
    ).toBe("save-failed");
  });

  it("keeps messages path-free even when a path has spaces", async () => {
    const { pathFreeMessage } = await import("../../core/artifacts/retention");
    expect(
      pathFreeMessage("open /Users/Jane Doe/projects/app/runs/x: denied"),
    ).toBe("open <path>: denied");
    expect(pathFreeMessage("copy /a/b to /c/d failed\nsecond line")).toBe(
      "copy <path> to <path> failed",
    );
  });

  it("reports a spawn ENOENT as a missing binary", async () => {
    execaMock.mockResolvedValue({
      exitCode: undefined,
      code: "ENOENT",
      stdout: "",
      stderr: "",
    });
    const result = await runFcheap(["save", "/tmp/x"], { json: true });
    expect(result).toMatchObject({ ok: false, missing: true });
  });

  it("detects save --meta and publish --run-index once per binary", async () => {
    const {
      fcheapSupportsPublishRunIndex,
      fcheapSupportsSaveMeta,
      resetFcheapCapabilityCache,
    } = await import("./fcheapClient");
    resetFcheapCapabilityCache();
    execaMock.mockImplementation(async (_bin: string, args: string[]) => ({
      exitCode: 0,
      stdout:
        args[0] === "save"
          ? "      --meta stringArray   Metadata key=value"
          : "      --entrypoint string",
      stderr: "",
    }));
    const env = { FCHEAP_BIN: "/opt/fcheap-probe-test" };
    expect(await fcheapSupportsSaveMeta(env)).toBe(true);
    expect(await fcheapSupportsSaveMeta(env)).toBe(true);
    expect(await fcheapSupportsPublishRunIndex(env)).toBe(false);
    expect(
      execaMock.mock.calls.filter(
        (call) => (call[1] as string[])[0] === "save",
      ),
    ).toHaveLength(1);
    resetFcheapCapabilityCache();
  });
});
