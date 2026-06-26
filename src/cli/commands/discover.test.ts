import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverToMarkdown,
  resolveDiscoverUrl,
  type DiscoverReport,
} from "./discover";

describe("resolveDiscoverUrl", () => {
  it("passes absolute URLs through", async () => {
    await expect(resolveDiscoverUrl("https://example.com/x")).resolves.toBe(
      "https://example.com/x",
    );
  });

  it("resolves relative URLs against config baseUrl", async () => {
    const configPath = await writeTestConfig();
    await expect(
      resolveDiscoverUrl("/dashboard", { config: configPath }),
    ).resolves.toBe("http://localhost:8787/dashboard");
  });

  it("resolves relative URLs with a different env", async () => {
    const configPath = await writeTestConfig();
    await expect(
      resolveDiscoverUrl("settings", { config: configPath, env: "preview" }),
    ).resolves.toBe("https://preview.example.com/app/settings");
  });

  it("fails clearly when a relative URL has no config baseUrl", async () => {
    await expect(resolveDiscoverUrl("/settings")).rejects.toThrow(
      /requires environments\.local\.baseUrl/,
    );
  });
});

describe("discoverToMarkdown", () => {
  it("renders a report with snapshot, roles, and testids", () => {
    const report: DiscoverReport = {
      status: "ok",
      requestedUrl: "/login",
      url: "http://localhost:3000/login",
      backend: "mock",
      snapshot: [
        { role: "heading", name: "Welcome", level: 1, ref: "e1" },
        { role: "button", name: "Sign In", level: 2, ref: "e2" },
      ],
      inventory: {
        roles: [
          {
            role: "button",
            name: "Sign In",
            count: 1,
            refs: ["e2"],
            locator: { by: "role", role: "button", name: "Sign In" },
          },
        ],
        testids: [
          {
            testId: "submit-btn",
            count: 1,
            selector: '[data-testid="submit-btn"]',
            tagNames: ["button"],
            textSamples: ["Sign In"],
          },
        ],
      },
    };

    const md = discoverToMarkdown(report);
    expect(md).toContain("# Discover: http://localhost:3000/login");
    expect(md).toContain("## Accessibility Snapshot");
    expect(md).toContain('heading "Welcome" [ref=e1]');
    expect(md).toContain('button "Sign In" [ref=e2]');
    expect(md).toContain("## Roles");
    expect(md).toContain('button "Sign In"');
    expect(md).toContain("## Test IDs");
    expect(md).toContain("submit-btn");
    expect(md).toContain('[data-testid="submit-btn"]');
  });

  it("renders an empty snapshot gracefully", () => {
    const report: DiscoverReport = {
      status: "ok",
      requestedUrl: "/empty",
      url: "http://localhost:3000/empty",
      backend: "mock",
      snapshot: [],
    };

    const md = discoverToMarkdown(report);
    expect(md).toContain("(empty snapshot)");
  });
});

async function writeTestConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-discover-test-"));
  const configPath = join(dir, "cairntrace.config.yml");
  await writeFile(
    configPath,
    `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8787
  preview:
    baseUrl: https://preview.example.com/app
`,
  );
  return configPath;
}
