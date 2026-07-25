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
