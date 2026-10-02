import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnknownEnvironmentError } from "../config/runtimeContext";
import { MissingTemplateVariableError } from "../parser/parseSpec";
import {
  redactBrowseUrl,
  resolveBrowseTarget,
  UnresolvedRelativeUrlError,
} from "./browseTarget";

let root: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairntrace-browse-target-"));
  await mkdir(join(root, "nested"), { recursive: true });
  configPath = join(root, "cairntrace.config.yml");
  await writeFile(
    configPath,
    `version: 1
environments:
  local:
    baseUrl: http://localhost:8787
    vars: { projectId: p-1 }
  preview:
    baseUrl: https://preview.example.test/app
browser:
  testIdAttribute: data-qa
  provider: ios
`,
  );
});

describe("resolveBrowseTarget", () => {
  it("discovers the config from cwd and carries browser settings", async () => {
    const target = await resolveBrowseTarget({
      url: "/projects/${vars.projectId}",
      cwd: join(root, "nested"),
    });
    expect(target.url).toBe("http://localhost:8787/projects/p-1");
    expect(target.requestedUrl).toBe("/projects/${vars.projectId}");
    expect(target.envName).toBe("local");
    expect(target.configPath).toBe(configPath);
    expect(target.testIdAttribute).toBe("data-qa");
    expect(target.browser?.provider).toBe("ios");
  });

  it("applies env and var overrides", async () => {
    const target = await resolveBrowseTarget({
      url: "settings/${vars.section}",
      config: configPath,
      env: "preview",
      vars: { section: "billing" },
    });
    expect(target.url).toBe(
      "https://preview.example.test/app/settings/billing",
    );
  });

  it("passes absolute URLs through but still reads the browser block", async () => {
    const target = await resolveBrowseTarget({
      url: "https://elsewhere.example.test/x",
      config: configPath,
    });
    expect(target.url).toBe("https://elsewhere.example.test/x");
    expect(target.testIdAttribute).toBe("data-qa");
  });

  it("fails loudly for an unknown explicit environment", async () => {
    await expect(
      resolveBrowseTarget({ url: "/x", config: configPath, env: "prod" }),
    ).rejects.toBeInstanceOf(UnknownEnvironmentError);
  });

  it("fails loudly for a missing ${vars.X}", async () => {
    await expect(
      resolveBrowseTarget({ url: "/x/${vars.nope}", config: configPath }),
    ).rejects.toBeInstanceOf(MissingTemplateVariableError);
  });

  it("refuses a relative URL without a baseUrl instead of navigating to a bare path", async () => {
    const bare = await mkdtemp(join(tmpdir(), "cairntrace-browse-bare-"));
    const err = await resolveBrowseTarget({
      url: "/settings",
      cwd: bare,
      label: "discover",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnresolvedRelativeUrlError);
    expect((err as Error).message).toMatch(
      /relative discover URL "\/settings" requires environments\.local\.baseUrl/,
    );
    // Mock exploration may keep the bare path.
    const mock = await resolveBrowseTarget({
      url: "/settings",
      cwd: bare,
      allowUnresolvedRelative: true,
    });
    expect(mock.url).toBe("/settings");
  });
});

describe("resolveBrowseTarget secrets", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of [
      "CAIRN_TEST_CB_TOKEN",
      "CAIRN_TEST_API_TOKEN",
      "CAIRN_TEST_APP_PORT",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("navigates with resolved secrets but keeps the requested template", async () => {
    process.env["CAIRN_TEST_CB_TOKEN"] = "s3cr3t-value";
    const requested =
      "https://example.test/cb?t=${secrets.CAIRN_TEST_CB_TOKEN}";
    const target = await resolveBrowseTarget({
      url: requested,
      config: configPath,
    });
    expect(target.url).toBe("https://example.test/cb?t=s3cr3t-value");
    expect(target.requestedUrl).toBe(requested);
    expect(target.sensitiveValues).toEqual(["s3cr3t-value"]);
    expect(redactBrowseUrl(target, target.url)).toBe(
      "https://example.test/cb?t=[redacted]",
    );
  });

  it("treats secret-named env refs as sensitive, ordinary ones not", async () => {
    process.env["CAIRN_TEST_API_TOKEN"] = "tok-123";
    process.env["CAIRN_TEST_APP_PORT"] = "4173";
    const target = await resolveBrowseTarget({
      url: "http://localhost:${env.CAIRN_TEST_APP_PORT}/x?k=${env.CAIRN_TEST_API_TOKEN}",
      config: configPath,
    });
    expect(target.url).toBe("http://localhost:4173/x?k=tok-123");
    expect(target.sensitiveValues).toEqual(["tok-123"]);
    expect(redactBrowseUrl(target, target.url)).toBe(
      "http://localhost:4173/x?k=[redacted]",
    );
  });

  it("redacts credential-like query params and userinfo even without placeholders", () => {
    expect(
      redactBrowseUrl(
        { sensitiveValues: [] },
        "https://user:pw@example.test/a?token=abc&page=2",
      ),
    ).toBe("https://[redacted]@example.test/a?token=[redacted]&page=2");
  });
});

describe("resolveBrowseTarget with a broken auto-discovered config", () => {
  let broken: string;
  beforeEach(async () => {
    broken = await mkdtemp(join(tmpdir(), "cairntrace-browse-broken-"));
    await writeFile(
      join(broken, "cairntrace.config.yml"),
      "version: 1\nenvironments:\n  local:\n    baseUrl: 42\nbogus: true\n",
    );
  });

  it("still opens an absolute URL, with a warning", async () => {
    const target = await resolveBrowseTarget({
      url: "https://example.test/",
      cwd: broken,
    });
    expect(target.url).toBe("https://example.test/");
    expect(target.configPath).toBeUndefined();
    expect(target.testIdAttribute).toBeUndefined();
    expect(target.warnings).toHaveLength(1);
    expect(target.warnings[0]).toContain(
      "ignoring the auto-discovered cairntrace.config.yml",
    );
  });

  it("fails when the config was asked for or the URL needs it", async () => {
    const explicit = join(broken, "cairntrace.config.yml");
    await expect(
      resolveBrowseTarget({ url: "https://example.test/", config: explicit }),
    ).rejects.toThrow();
    await expect(
      resolveBrowseTarget({
        url: "https://example.test/",
        cwd: broken,
        env: "local",
      }),
    ).rejects.toThrow();
    await expect(
      resolveBrowseTarget({ url: "/relative", cwd: broken }),
    ).rejects.toThrow();
    await expect(
      resolveBrowseTarget({
        url: "https://example.test/${vars.x}",
        cwd: broken,
      }),
    ).rejects.toThrow();
  });
});
