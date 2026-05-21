import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ContractHashMismatchError,
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
