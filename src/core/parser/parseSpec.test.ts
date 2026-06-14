import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ContractHashMismatchError,
  MissingTemplateVariableError,
  parseSpec,
  UnresolvedActionError,
} from "./parseSpec";
import { computeContractHash } from "../contractHash";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-test-"));
});

afterAll(async () => {
  // best-effort; tmp is fine to leak in tests
});

describe("parseSpec", () => {
  it("loads, validates, and resolves ${env.X} substitution", async () => {
    const path = join(dir, "env.yml");
    await writeFile(
      path,
      `version: 1
name: env_demo
intent: ${"smoke env substitution"}
outcomes:
  - id: shows_email
    description: shows the substituted email
    verify:
      text: { contains: "\${env.ADMIN_EMAIL}" }
`,
    );
    const r = await parseSpec(path, {
      env: { ADMIN_EMAIL: "abdul@example.com" },
    });
    expect(r.spec.name).toBe("env_demo");
    const v = r.spec.outcomes[0]!.verify as { text: { contains: string } };
    expect(v.text.contains).toBe("abdul@example.com");
  });

  it("rejects specs missing required fields", async () => {
    const path = join(dir, "missing.yml");
    await writeFile(path, `version: 1\nname: only_name\n`);
    await expect(parseSpec(path)).rejects.toThrow();
  });

  it("accepts a selector-only batch step", async () => {
    const path = join(dir, "batch_ok.yml");
    await writeFile(
      path,
      `version: 1
name: batch_ok
intent: composite batch step
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - batch:
      - hover: { by: selector, selector: "#row" }
      - click: { by: selector, selector: ".actions button" }
`,
    );
    const r = await parseSpec(path);
    const step = r.spec.steps![0]!;
    expect("batch" in step && step.batch).toHaveLength(2);
  });

  it("rejects semantic locators inside a batch step", async () => {
    const path = join(dir, "batch_semantic.yml");
    await writeFile(
      path,
      `version: 1
name: batch_semantic
intent: semantic locators are not allowed in batch
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - batch:
      - hover: { by: selector, selector: "#row" }
      - click: { by: role, role: button, name: Upload }
`,
    );
    await expect(parseSpec(path)).rejects.toThrow();
  });

  it("rejects a batch step with fewer than 2 sub-steps", async () => {
    const path = join(dir, "batch_single.yml");
    await writeFile(
      path,
      `version: 1
name: batch_single
intent: a one-item batch should be a normal step
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - batch:
      - click: { by: selector, selector: "#go" }
`,
    );
    await expect(parseSpec(path)).rejects.toThrow();
  });

  it("inlines `use:` steps from imported actions", async () => {
    const actionPath = join(dir, "login.yml");
    await writeFile(
      actionPath,
      `version: 1
name: login_admin
steps:
  - open: /login
  - id: submit
    click:
      by: role
      role: button
      name: Sign in
`,
    );
    const specPath = join(dir, "uses_action.yml");
    await writeFile(
      specPath,
      `version: 1
name: uses_action
intent: demo action inlining
imports:
  - ./login.yml
outcomes:
  - id: on_dashboard
    description: lands on dashboard
    verify:
      url: { endsWith: "/dashboard" }
steps:
  - use: login_admin
  - open: /dashboard
`,
    );
    const r = await parseSpec(specPath);
    expect(r.resolved.steps?.length).toBe(3);
    expect((r.resolved.steps![0] as { open: string }).open).toBe("/login");
    expect((r.resolved.steps![2] as { open: string }).open).toBe("/dashboard");
  });

  it("allows fill.value inside imported reusable actions", async () => {
    const actionPath = join(dir, "login_with_fill.yml");
    await writeFile(
      actionPath,
      `version: 1
name: login_admin
steps:
  - open: /login
  - fill:
      by: label
      name: Email
      value: admin@example.com
  - fill:
      by: label
      name: Password
      value: secret
`,
    );
    const specPath = join(dir, "uses_action_fill.yml");
    await writeFile(
      specPath,
      `version: 1
name: uses_action_fill
intent: imported action fill steps are valid
imports:
  - ./login_with_fill.yml
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - use: login_admin
`,
    );
    const r = await parseSpec(specPath);
    expect(r.resolved.steps).toHaveLength(3);
    expect(r.resolved.steps![1]).toMatchObject({
      fill: { by: "label", name: "Email", value: "admin@example.com" },
    });
  });

  it("tracks origins back to imported action files", async () => {
    const actionPath = join(dir, "open_dashboard_action.yml");
    await writeFile(
      actionPath,
      `version: 1
name: open_dashboard
steps:
  - id: nav
    open: /
  - id: click_into
    click:
      by: role
      role: link
      name: Open dashboard
`,
    );
    const specPath = join(dir, "uses_action_with_origins.yml");
    await writeFile(
      specPath,
      `version: 1
name: uses_action_origins
intent: confirm origins map back to the action file
imports:
  - ./open_dashboard_action.yml
outcomes:
  - id: ok
    description: ok
    verify:
      url: { endsWith: "/dashboard" }
steps:
  - use: open_dashboard
  - open: /dashboard
`,
    );
    const r = await parseSpec(specPath);
    // 2 from action (nav, click_into) + 1 inline (open /dashboard) = 3 origins
    expect(r.origins).toHaveLength(3);
    expect(r.origins[0]).toMatchObject({
      filePath: actionPath,
      fileStepIdx: 0,
    });
    expect(r.origins[1]).toMatchObject({
      filePath: actionPath,
      fileStepIdx: 1,
    });
    expect(r.origins[2]).toMatchObject({
      filePath: specPath,
      fileStepIdx: 1, // step 0 in spec is `use:`, step 1 is the inline open
    });
  });

  it("throws on unresolved `use:` references", async () => {
    const path = join(dir, "missing_action.yml");
    await writeFile(
      path,
      `version: 1
name: missing_action
intent: refers to action not in imports
outcomes:
  - id: never_runs
    description: doesn't matter
    verify:
      text: { contains: "x" }
steps:
  - use: not_imported
`,
    );
    await expect(parseSpec(path)).rejects.toBeInstanceOf(UnresolvedActionError);
  });

  it("verifies a valid contractHash", async () => {
    const path = join(dir, "hashed.yml");
    const intent = "verify the hash is valid";
    const outcomes = [
      {
        id: "ok",
        description: "ok",
        verify: { text: { contains: "ok" }, region: "page" },
      },
    ];
    const hash = computeContractHash({ intent, outcomes });
    await writeFile(
      path,
      `version: 1
name: hashed
intent: ${intent}
outcomes:
  - id: ok
    description: ok
    verify:
      text: { contains: ok }
      region: page
contractHash: ${hash}
`,
    );
    const r = await parseSpec(path);
    expect(r.contractHashValid).toBe(true);
  });

  it("prepends baseUrl to open: steps with relative paths", async () => {
    const path = join(dir, "with_base.yml");
    await writeFile(
      path,
      `version: 1
name: with_base
intent: relative open paths use the env baseUrl
outcomes:
  - id: ok
    description: ok
    verify:
      text: { contains: ok }
steps:
  - id: home
    open: /home
  - id: external
    open: https://example.com/external
`,
    );
    const r = await parseSpec(path, { baseUrl: "http://localhost:9999" });
    const steps = r.resolved.steps!;
    expect((steps[0] as { open: string }).open).toBe(
      "http://localhost:9999/home",
    );
    // Absolute URLs should pass through untouched.
    expect((steps[1] as { open: string }).open).toBe(
      "https://example.com/external",
    );
  });

  it("prepends baseUrl to object-form open: steps and keeps waitUntil", async () => {
    const path = join(dir, "with_base_obj.yml");
    await writeFile(
      path,
      `version: 1
name: with_base_obj
intent: object-form open joins baseUrl and keeps waitUntil
outcomes:
  - id: ok
    description: ok
    verify:
      text: { contains: ok }
steps:
  - id: home
    open: { path: /admin, waitUntil: networkidle, timeoutMs: 45000 }
`,
    );
    const r = await parseSpec(path, { baseUrl: "http://localhost:9999" });
    const step = r.resolved.steps![0] as {
      open: { path: string; waitUntil: string; timeoutMs: number };
    };
    expect(step.open).toEqual({
      path: "http://localhost:9999/admin",
      waitUntil: "networkidle",
      timeoutMs: 45000,
    });
  });

  it("leaves runtime-placeholder open paths unjoined until runner execution", async () => {
    const path = join(dir, "with_runtime_open.yml");
    await writeFile(
      path,
      `version: 1
name: with_runtime_open
intent: runtime open placeholders are joined after substitution
outcomes:
  - id: ok
    description: ok
    verify:
      text: { contains: ok }
steps:
  - id: from_request
    open: "\${requests.game.body.url}"
  - id: from_artifact
    open: { path: "\${artifacts.page.relativePath}", waitUntil: networkidle }
`,
    );
    const r = await parseSpec(path, { baseUrl: "http://localhost:9999" });
    const steps = r.resolved.steps!;
    expect((steps[0] as { open: string }).open).toBe(
      "${requests.game.body.url}",
    );
    expect((steps[1] as { open: { path: string } }).open.path).toBe(
      "${artifacts.page.relativePath}",
    );
  });

  it("substitutes ${baseUrl} inside string fields", async () => {
    const path = join(dir, "baseurl_var.yml");
    await writeFile(
      path,
      `version: 1
name: baseurl_var
intent: baseUrl substitution works in arbitrary strings
outcomes:
  - id: url_matches
    description: url is the baseUrl + path
    verify:
      url: { equals: "\${baseUrl}/x" }
steps: []
`,
    );
    const r = await parseSpec(path, { baseUrl: "http://localhost:9999" });
    const verify = r.spec.outcomes[0]!.verify as { url: { equals: string } };
    expect(verify.url.equals).toBe("http://localhost:9999/x");
  });

  it("throws a clear error when a ${vars.X} placeholder is missing", async () => {
    const path = join(dir, "missing_var.yml");
    await writeFile(
      path,
      `version: 1
name: missing_var
intent: missing var should not become an empty string
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "\${vars.connectionPath}"
`,
    );
    await expect(parseSpec(path)).rejects.toThrow(
      `missing vars.connectionPath while parsing ${path}`,
    );
    await expect(parseSpec(path)).rejects.toBeInstanceOf(
      MissingTemplateVariableError,
    );
  });

  it("uses spec-level vars for substitution and lets parser opts override them", async () => {
    const path = join(dir, "spec_vars.yml");
    await writeFile(
      path,
      `version: 1
name: spec_vars
intent: spec vars can supply required fields
vars:
  connectionPath: /from-spec
  expectedLabel: From spec
outcomes:
  - id: label_visible
    description: label is visible
    verify:
      text: { contains: "\${vars.expectedLabel}" }
steps:
  - open: "\${vars.connectionPath}"
`,
    );

    const fromSpec = await parseSpec(path);
    expect((fromSpec.spec.steps![0] as { open: string }).open).toBe(
      "/from-spec",
    );
    const specVerify = fromSpec.spec.outcomes[0]!.verify as {
      text: { contains: string };
    };
    expect(specVerify.text.contains).toBe("From spec");

    const overridden = await parseSpec(path, {
      vars: {
        connectionPath: "/from-cli",
        expectedLabel: "From CLI",
      },
    });
    expect((overridden.spec.steps![0] as { open: string }).open).toBe(
      "/from-cli",
    );
    const overriddenVerify = overridden.spec.outcomes[0]!.verify as {
      text: { contains: string };
    };
    expect(overriddenVerify.text.contains).toBe("From CLI");
  });

  it("supports nested text regions and built-in runtime placeholders", async () => {
    const path = join(dir, "runtime_placeholders.yml");
    await writeFile(
      path,
      `version: 1
name: runtime_placeholders
intent: built-in runtime placeholders resolve
vars:
  userId: "user-\${worker.index}-\${run.token}"
outcomes:
  - id: ticker
    description: ticker contains objective state
    verify:
      text:
        contains: "\${vars.userId}"
        region: '[data-testid="objective-ticker"]'
steps:
  - open: "/users/\${vars.userId}"
`,
    );

    const r = await parseSpec(path, {
      runtime: { workerIndex: 7, runToken: "abc123" },
    });

    expect(r.spec.outcomes[0]!.verify).toEqual({
      text: {
        contains: "user-7-abc123",
        region: '[data-testid="objective-ticker"]',
      },
    });
    expect(r.spec.steps?.[0]).toEqual({ open: "/users/user-7-abc123" });
  });

  it("validates contractHash against the raw unresolved contract", async () => {
    const path = join(dir, "hash_with_var.yml");
    const rawSpec = {
      version: 1 as const,
      name: "hash_with_var",
      intent: "contract hash keeps placeholders raw",
      outcomes: [
        {
          id: "path_visible",
          description: "path is visible",
          verify: {
            text: { contains: "${vars.expectedPath}" },
          },
        },
      ],
    };
    const hash = computeContractHash(rawSpec);
    await writeFile(
      path,
      `version: 1
name: hash_with_var
intent: contract hash keeps placeholders raw
outcomes:
  - id: path_visible
    description: path is visible
    verify:
      text: { contains: "\${vars.expectedPath}" }
contractHash: ${hash}
`,
    );
    const r = await parseSpec(path, {
      vars: { expectedPath: "/connection/abc" },
    });
    expect(r.contractHashValid).toBe(true);
    const verify = r.spec.outcomes[0]!.verify as { text: { contains: string } };
    expect(verify.text.contains).toBe("/connection/abc");
  });

  it("rejects a tampered contractHash", async () => {
    const path = join(dir, "tampered.yml");
    await writeFile(
      path,
      `version: 1
name: tampered
intent: something
outcomes:
  - id: ok
    description: ok
    verify:
      text: { contains: ok }
contractHash: sha256:${"0".repeat(64)}
`,
    );
    await expect(parseSpec(path)).rejects.toBeInstanceOf(
      ContractHashMismatchError,
    );
  });
});
