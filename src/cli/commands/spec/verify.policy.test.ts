import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../../core/checkpoint/CheckpointStore";
import { buildCheckpointMeta } from "../../../core/checkpoint/meta";
import { verifySpec } from "./verify";

/**
 * `cairn spec verify` (and MCP cairn_spec_verify): environment eligibility
 * (F1), files referenced by the spec and its actions resolved exactly as at
 * run time (F13), and checkpoint findings (A10).
 */

let dir: string;
let store: CheckpointStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-verify-policy-"));
  store = new CheckpointStore(join(dir, "checkpoints"));
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: https://app.example.test
  dev:
    baseUrl: https://dev.example.test
    policy: { trait: shared, mutations: deny }
  prod:
    baseUrl: https://prod.example.test
    policy: { trait: protected }
`,
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SPEC = (extra: string, steps = "  - open: /home"): string => `version: 1
name: verify_policy
intent: A spec with environment requirements.
coldStart: guest
${extra}
steps:
${steps}
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

describe("verify: environment policy", () => {
  it("fails an explicit --env the policy refuses (env-not-allowed, exit 4)", async () => {
    const specPath = join(dir, "spec.yml");
    await writeFile(
      specPath,
      SPEC("requires: { env: [local], mutates: true }"),
    );
    const { result, exitCode } = await verifySpec(specPath, {
      env: "dev",
      callerEnv: {},
      checkpointStore: store,
    });
    expect(exitCode).toBe(4);
    expect(result.status).toBe("invalid");
    expect(result.environment).toMatchObject({
      name: "dev",
      allowed: false,
      explicit: true,
      code: "env-not-listed",
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        kind: "env-not-allowed",
        severity: "error",
        subject: "dev",
      }),
    );
    expect(result.errors.join("\n")).toContain('environment "dev" refuses');
  });

  it("lists the allowed environments without --env", async () => {
    const specPath = join(dir, "spec.yml");
    await writeFile(
      specPath,
      SPEC("requires: { env: [local, { dev: { optIn: ALLOW_DEV } }, qa] }"),
    );
    const { result, exitCode } = await verifySpec(specPath, {
      callerEnv: {},
      checkpointStore: store,
    });
    expect(exitCode).toBe(0);
    expect(result.environment).toMatchObject({
      name: "local",
      allowed: true,
      explicit: false,
    });
    expect(
      result.environments?.map((e) => [
        e.name,
        e.allowed,
        e.code ?? null,
        e.defined,
      ]),
    ).toEqual([
      ["dev", false, "opt-in-missing", true],
      ["local", true, null, true],
      ["prod", false, "env-not-listed", true],
      // Listed but not defined: the policy allows it, the config cannot run it.
      ["qa", true, null, false],
    ]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ kind: "unknown-env", subject: "qa" }),
    );
    const optedIn = await verifySpec(specPath, {
      env: "dev",
      callerEnv: { ALLOW_DEV: "1" },
      checkpointStore: store,
    });
    expect(optedIn.exitCode).toBe(0);
    expect(optedIn.result.environment?.allowed).toBe(true);
  });

  it("only warns when the default environment refuses the spec", async () => {
    const specPath = join(dir, "spec.yml");
    await writeFile(specPath, SPEC("requires: { env: [prod] }"));
    const { result, exitCode } = await verifySpec(specPath, {
      callerEnv: {},
      checkpointStore: store,
    });
    expect(exitCode).toBe(0);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        kind: "env-not-allowed",
        severity: "warning",
      }),
    );
  });
});

describe("verify: referenced files (F13)", () => {
  it("fails when an action's eval/upload file does not exist where the run looks", async () => {
    await mkdir(join(dir, "actions"), { recursive: true });
    await mkdir(join(dir, "flows"), { recursive: true });
    await writeFile(join(dir, "actions", "probe.js"), "return 1;");
    await writeFile(
      join(dir, "actions", "attach.yml"),
      `version: 1
name: attach
steps:
  - eval: { file: probe.js }
  - upload: { by: selector, selector: "#f", path: missing.csv }
  - transform: { file: transform.mjs, input: "\${artifacts.report.path}", saveAs: out.csv }
`,
    );
    const specPath = join(dir, "flows", "spec.yml");
    await writeFile(
      specPath,
      SPEC(
        "imports: [../actions/attach.yml]",
        `  - open: /home
  - use: attach
  - eval: { file: local.js }`,
      ),
    );
    await writeFile(join(dir, "flows", "local.js"), "return 1;");
    const { result, exitCode } = await verifySpec(specPath, {
      callerEnv: {},
      checkpointStore: store,
    });
    expect(exitCode).toBe(4);
    const missing = (result.findings ?? []).filter(
      (f) => f.kind === "missing-file",
    );
    expect(missing.map((f) => [f.field, f.where])).toEqual([
      ["upload.path", "action attach step 2"],
      ["transform.file", "action attach step 3"],
    ]);
    expect(missing[0]?.message).toContain(join(dir, "actions", "missing.csv"));
    expect(missing[0]?.file).toBe(join(dir, "actions", "attach.yml"));
  });

  it("warns on the deprecated spec-relative fallback and on absolute paths outside the project", async () => {
    await mkdir(join(dir, "actions"), { recursive: true });
    await mkdir(join(dir, "flows"), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), "cairn-verify-outside-"));
    try {
      await writeFile(join(outside, "host.csv"), "a\n");
      await writeFile(join(dir, "flows", "legacy.csv"), "a\n");
      await writeFile(
        join(dir, "actions", "attach.yml"),
        `version: 1
name: attach
steps:
  - upload: { by: selector, selector: "#f", path: legacy.csv }
  - upload: { by: selector, selector: "#g", path: ${JSON.stringify(join(outside, "host.csv"))} }
`,
      );
      const specPath = join(dir, "flows", "spec.yml");
      await writeFile(
        specPath,
        SPEC(
          "imports: [../actions/attach.yml]",
          "  - open: /home\n  - use: attach",
        ),
      );
      const { result, exitCode } = await verifySpec(specPath, {
        callerEnv: {},
        checkpointStore: store,
      });
      expect(exitCode).toBe(0);
      const kinds = (result.findings ?? []).map((f) => [f.kind, f.severity]);
      expect(kinds).toContainEqual(["deprecated-path", "warning"]);
      expect(kinds).toContainEqual(["absolute-path", "warning"]);
      expect(result.warnings.join("\n")).toContain('action "attach"');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("verify: checkpoints (A10)", () => {
  it("reports a missing or expired session.resume checkpoint as a warning finding", async () => {
    const specPath = join(dir, "spec.yml");
    await writeFile(
      specPath,
      SPEC("session: { resume: admin }").replace("coldStart: guest\n", ""),
    );
    const missing = await verifySpec(specPath, {
      callerEnv: {},
      checkpointStore: store,
    });
    expect(missing.exitCode).toBe(0);
    expect(missing.result.findings).toContainEqual(
      expect.objectContaining({
        kind: "checkpoint-missing",
        severity: "warning",
        subject: "admin",
      }),
    );

    await store.ensureRoot();
    await writeFile(store.pathFor("admin"), "{}");
    await store.writeMeta(
      store.pathFor("admin"),
      buildCheckpointMeta({
        name: "admin",
        baseUrl: "https://app.example.test",
        ttl: "1h",
        now: new Date("2020-01-01T00:00:00.000Z"),
      }),
    );
    const expired = await verifySpec(specPath, {
      callerEnv: {},
      checkpointStore: store,
    });
    expect(expired.result.findings).toContainEqual(
      expect.objectContaining({ kind: "checkpoint-expired" }),
    );
  });
});

describe("verify: gate and fixture names (F2, F3b)", () => {
  it("fails a preconditions.wait gate or a fixtures name the config does not define", async () => {
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: https://app.example.test
gates:
  api_up: { http: { url: "https://app.example.test/health" } }
fixtures:
  demo_user: { kind: exec, ensure: "echo '{}'" }
`,
    );
    const specPath = join(dir, "spec.yml");
    await writeFile(
      specPath,
      SPEC(
        `preconditions:
  wait: [api_up, { all: [db_up, "tcp://127.0.0.1:1"] }]
fixtures: [demo_user, demo_order.reset]`,
      ),
    );
    const { result, exitCode } = await verifySpec(specPath, {
      callerEnv: {},
      checkpointStore: store,
    });
    expect(exitCode).toBe(4);
    const kinds = (result.findings ?? []).map((f) => [
      f.kind,
      f.subject,
      f.severity,
    ]);
    expect(kinds).toContainEqual(["unknown-gate", "db_up", "error"]);
    expect(kinds).toContainEqual(["unknown-fixture", "demo_order", "error"]);
    // Defined names (and inline tcp:// probes) are not findings.
    expect(kinds.map(([, subject]) => subject)).not.toContain("api_up");
    expect(kinds.map(([, subject]) => subject)).not.toContain("demo_user");
  });
});
