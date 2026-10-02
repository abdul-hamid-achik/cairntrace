import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { runSpec } from "../runner/Runner";
import {
  chooseAccompany,
  closeAccompany,
  listAccompany,
  locatorFromSnapshotRef,
  openAccompany,
  resetAccompanyRegistryForTests,
  statusAccompany,
  sweepExpiredAccompany,
} from "./AccompanySession";

let artifactRoot: string;

beforeEach(async () => {
  resetAccompanyRegistryForTests();
  artifactRoot = await mkdtemp(join(tmpdir(), "cairn-accompany-"));
});

afterEach(async () => {
  resetAccompanyRegistryForTests();
});

async function writeClickSpec(name: string, extraSteps = ""): Promise<string> {
  const path = join(artifactRoot, `${name}.yml`);
  await writeFile(
    path,
    `version: 1
name: ${name}
intent: click a button
coldStart: guest
outcomes:
  - id: clean
    description: mock console stays clean
    verify: { console: { errorsMax: 0 } }
steps:
  - id: go
    click:
      by: role
      role: button
      name: Go
${extraSteps}
`,
  );
  return path;
}

describe("onLocatorMiss hook", () => {
  it("retries with the chosen locator and passes", async () => {
    const specPath = await writeClickSpec("hook_retry");
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 matches");
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
      onLocatorMiss: async () => ({
        action: "retry",
        locator: { by: "role", role: "button", name: "OK" },
      }),
    });
    expect(result.status).toBe("passed");
    expect(backend.stepLog.length).toBeGreaterThanOrEqual(2);
    const lastClick = backend.stepLog.toReversed().find((s) => "click" in s);
    expect(lastClick && "click" in lastClick && lastClick.click).toMatchObject({
      name: "OK",
    });
  });

  it("does not park a delivered click.until failure", async () => {
    const specPath = await writeClickSpec("until_fail");
    const backend = new MockBrowserBackend();
    backend.failNextStep(
      'click.until text="Done" was not satisfied after 4 click attempts within 30000ms',
    );
    const hook = vi.fn();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
      onLocatorMiss: hook,
    });
    expect(result.status).toBe("failed");
    expect(hook).not.toHaveBeenCalled();
  });

  it("fails as today when no hook is installed", async () => {
    const specPath = await writeClickSpec("hook_absent");
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 matches");
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.status).toBe("failed");
    expect(result.failure?.step).toBe("go");
  });
});

describe("AccompanySession", () => {
  it("completes when every locator hits", async () => {
    const specPath = await writeClickSpec("all_hit");
    const { open } = await openAccompany({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot,
    });
    expect(open.status).toBe("completed");
    expect(open.parked).toBeUndefined();
    expect(open.result?.status).toBe("passed");
    await closeAccompany(open.sessionId);
  });

  it("parks on the first miss", async () => {
    const specPath = await writeClickSpec("park");
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 visible matches");
    const { open } = await openAccompany({ specPath, backend, artifactRoot });
    expect(open.status).toBe("needs_choice");
    expect(open.parked?.step.id).toBe("go");
    expect(open.parked?.error).toContain("0 visible matches");
    await closeAccompany(open.sessionId);
  });

  it("binds lastSnapshot to the parked packet snapshot", async () => {
    const specPath = await writeClickSpec("park_snap");
    const backend = new MockBrowserBackend();
    const snap = `- button "Go" [ref=e9]`;
    backend.setSnapshot(snap);
    backend.failNextStep("0 visible matches");
    const { open } = await openAccompany({ specPath, backend, artifactRoot });
    expect(open.parked?.snapshot).toBe(snap);
    const handle = statusAccompany(open.sessionId);
    expect(
      handle?.lastSnapshot?.map((e) => ({
        role: e.role,
        name: e.name,
        ref: e.ref,
      })),
    ).toEqual([{ role: "button", name: "Go", ref: "e9" }]);
    await closeAccompany(open.sessionId);
  });

  it("resumes and completes after a good choose", async () => {
    const specPath = await writeClickSpec("choose_ok");
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 visible matches");
    const { open } = await openAccompany({ specPath, backend, artifactRoot });
    expect(open.status).toBe("needs_choice");
    const next = await chooseAccompany(open.sessionId, {
      by: "role",
      role: "button",
      name: "OK",
    });
    expect(next.status).toBe("completed");
    expect(next.result?.status).toBe("passed");
    await closeAccompany(open.sessionId);
  });

  it("stays parked when choose still misses", async () => {
    const specPath = await writeClickSpec("choose_miss");
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 visible matches");
    const { open } = await openAccompany({ specPath, backend, artifactRoot });
    backend.failNextStep("0 visible matches");
    const next = await chooseAccompany(open.sessionId, {
      by: "role",
      role: "button",
      name: "Nope",
    });
    expect(next.status).toBe("needs_choice");
    expect(next.parked?.error).toContain("0 visible matches");
    await closeAccompany(open.sessionId);
  });

  it("aborts a parked session on close", async () => {
    const specPath = await writeClickSpec("close_parked");
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 matches");
    const { open } = await openAccompany({ specPath, backend, artifactRoot });
    expect(open.status).toBe("needs_choice");
    await closeAccompany(open.sessionId);
    await expect(
      chooseAccompany(open.sessionId, {
        by: "role",
        role: "button",
        name: "Go",
      }),
    ).rejects.toThrow(/not found/);
  });

  it("never inlines a secret fill value in the parked brief", async () => {
    const specPath = join(artifactRoot, "secret_fill.yml");
    await writeFile(
      specPath,
      `version: 1
name: secret_fill
intent: fill a password
coldStart: guest
outcomes:
  - id: clean
    description: mock console stays clean
    verify: { console: { errorsMax: 0 } }
steps:
  - id: fill_password
    fill:
      by: label
      name: Password
      value: "__CAIRN_SECRET_REF__PASSWORD__"
`,
    );
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 matches");
    const { open } = await openAccompany({ specPath, backend, artifactRoot });
    expect(open.status).toBe("needs_choice");
    expect(open.parked?.step.value).toEqual({
      kind: "secret",
      name: "PASSWORD",
    });
    expect(JSON.stringify(open.parked)).not.toContain("__CAIRN_SECRET_REF__");
    await closeAccompany(open.sessionId);
  });

  it("redacts ${env.PASSWORD} in the parked brief", async () => {
    const specPath = join(artifactRoot, "env_secret.yml");
    await writeFile(
      specPath,
      `version: 1
name: env_secret
intent: fill a password
coldStart: guest
outcomes:
  - id: clean
    description: mock console stays clean
    verify: { console: { errorsMax: 0 } }
steps:
  - id: fill_password
    fill:
      by: label
      name: Password
      value: "\${env.PASSWORD}"
`,
    );
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 matches");
    const { open } = await openAccompany({
      specPath,
      backend,
      artifactRoot,
      env: { ...process.env, PASSWORD: "hunter2" },
    });
    expect(open.status).toBe("needs_choice");
    expect(open.parked?.step.value).toEqual({
      kind: "secret",
      name: "PASSWORD",
    });
    expect(JSON.stringify(open.parked)).not.toContain("hunter2");
    await closeAccompany(open.sessionId);
  });

  it("does not expire a running session", async () => {
    const specPath = await writeClickSpec("still_running");
    class SlowBackend extends MockBrowserBackend {
      release!: () => void;
      gate = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      override async runStep(
        step: Parameters<MockBrowserBackend["runStep"]>[0],
      ) {
        if ("click" in step) await this.gate;
        return super.runStep(step);
      }
    }
    const backend = new SlowBackend();
    const opened = openAccompany({ specPath, backend, artifactRoot });
    await new Promise((r) => setTimeout(r, 20));
    const expired = await sweepExpiredAccompany(Date.now() + 10 * 60 * 1000);
    expect(expired).toEqual([]);
    backend.release();
    const { open } = await opened;
    expect(open.status).toBe("completed");
    await closeAccompany(open.sessionId);
  });
});

describe("openAccompany failures", () => {
  it("does not leak a registry slot when runSpec throws", async () => {
    await expect(
      openAccompany({
        specPath: join(artifactRoot, "missing.yml"),
        backend: new MockBrowserBackend(),
        artifactRoot,
      }),
    ).rejects.toThrow();
    expect(listAccompany()).toEqual([]);
  });
});

describe("locatorFromSnapshotRef", () => {
  const snapshot = [
    { role: "button", name: "Open", level: 1, ref: "e1" },
    { role: "button", name: "Open", level: 1, ref: "e2" },
  ];

  it("keeps the snapshot @ref on agent-browser", () => {
    expect(locatorFromSnapshotRef(snapshot, "@e2", "agent-browser")).toEqual({
      by: "selector",
      selector: "@e2",
    });
  });

  it("uses nth for same-name peers on Playwright", () => {
    expect(locatorFromSnapshotRef(snapshot, "e2", "playwright")).toEqual({
      by: "role",
      role: "button",
      name: "Open",
      nth: 1,
    });
  });

  it("sets nth: 0 for the first of several Playwright peers", () => {
    expect(locatorFromSnapshotRef(snapshot, "e1", "playwright")).toEqual({
      by: "role",
      role: "button",
      name: "Open",
      nth: 0,
    });
  });
});

async function journalEvents(
  dir: string,
): Promise<Array<Record<string, unknown>>> {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(join(dir, "events.ndjson"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
describe("accompany session journal", () => {
  it("journals decisions and applies accepted ones to a draft copy, never the source", async () => {
    const { readFile } = await import("node:fs/promises");
    const specPath = await writeClickSpec("journal_choose");
    const source = await readFile(specPath, "utf8");
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 visible matches");
    const { open, handle } = await openAccompany({
      specPath,
      backend,
      artifactRoot,
    });
    expect(open.status).toBe("needs_choice");
    const dir = handle.journal!;
    expect(dir).toBe(join(artifactRoot, "_sessions", open.sessionId));
    const session = JSON.parse(
      await readFile(join(dir, "session.json"), "utf8"),
    );
    expect(session).toMatchObject({
      version: 1,
      kind: "accompany",
      status: "open",
      specPath,
      backend: "mock",
    });

    // A miss, then a hit.
    backend.failNextStep("0 visible matches");
    expect(
      (
        await chooseAccompany(open.sessionId, {
          by: "role",
          role: "button",
          name: "Nope",
        })
      ).status,
    ).toBe("needs_choice");
    const next = await chooseAccompany(open.sessionId, {
      by: "role",
      role: "button",
      name: "OK",
    });
    expect(next.status).toBe("completed");
    const status = statusAccompany(open.sessionId)!;
    expect(status.decisions?.map((d) => [d.stepId, d.ok])).toEqual([
      ["go", false],
      ["go", true],
    ]);
    expect(status.draftPath).toBe(join(dir, "draft.spec.yml"));

    const events = await journalEvents(dir);
    const choices = events.filter((e) => e["type"] === "action.performed");
    expect(choices.map((e) => [e["action"], e["ok"], e["stepId"]])).toEqual([
      ["choose", false, "go"],
      ["choose", true, "go"],
    ]);
    expect(events.find((e) => e["type"] === "step.recorded")).toMatchObject({
      index: 2,
      step: { id: "go", click: { by: "role", role: "button", name: "OK" } },
      origin: { file: specPath, stepIndex: 0, stepId: "go" },
    });
    const draft = await readFile(join(dir, "draft.spec.yml"), "utf8");
    expect(draft).toContain("name: OK");
    expect(draft).toContain("intent: click a button");
    expect(await readFile(specPath, "utf8")).toBe(source);

    await closeAccompany(open.sessionId);
    const closed = JSON.parse(
      await readFile(join(dir, "session.json"), "utf8"),
    );
    expect(closed.status).toBe("closed");
    expect(closed.draftPath).toBe("draft.spec.yml");
  });

  it("records a snapshot @ref choice as role + name, and writes draftTo", async () => {
    const { readFile } = await import("node:fs/promises");
    const specPath = await writeClickSpec("journal_ref");
    const backend = new MockBrowserBackend();
    backend.setSnapshot(`- button "Continue" [ref=e9]`);
    backend.failNextStep("0 visible matches");
    const draftTo = join(artifactRoot, "flows", "_drafts", "journal_ref.yml");
    const { open } = await openAccompany({
      specPath,
      backend,
      artifactRoot,
      journal: { draftTo },
    });
    await chooseAccompany(open.sessionId, { by: "selector", selector: "@e9" });
    expect(statusAccompany(open.sessionId)?.decisions?.[0]?.locator).toEqual({
      by: "role",
      role: "button",
      name: "Continue",
    });
    expect(statusAccompany(open.sessionId)?.draftPath).toBe(draftTo);
    const draft = await readFile(draftTo, "utf8");
    expect(draft).toContain("name: Continue");
    expect(draft).not.toContain("@e9");
    await closeAccompany(open.sessionId);
  });

  it("refuses draftTo pointing at the source spec without leaking a slot", async () => {
    const specPath = await writeClickSpec("journal_self");
    await expect(
      openAccompany({
        specPath,
        backend: new MockBrowserBackend(),
        artifactRoot,
        journal: { draftTo: specPath },
      }),
    ).rejects.toThrow(/never written|must not be the source/);
    expect(listAccompany()).toEqual([]);
  });

  it("refuses a draftTo that is the source by another name (link, case)", async () => {
    const { link, symlink } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const specPath = await writeClickSpec("journal_alias");
    const aliases = [
      join(artifactRoot, "hard.yml"),
      join(artifactRoot, "soft.yml"),
    ];
    await link(specPath, aliases[0]!);
    await symlink(specPath, aliases[1]!);
    const upper = join(artifactRoot, "JOURNAL_ALIAS.yml");
    // A case-insensitive volume (the macOS default) sees the source here.
    if (existsSync(upper)) aliases.push(upper);
    for (const draftTo of aliases) {
      await expect(
        openAccompany({
          specPath,
          backend: new MockBrowserBackend(),
          artifactRoot,
          journal: { draftTo },
        }),
      ).rejects.toThrow(/must not be the source/);
    }
    expect(listAccompany()).toEqual([]);
  });

  it("keeps the spec's placeholders in the draft copy (valid YAML)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { parse } = await import("yaml");
    const specPath = await writeClickSpec(
      "journal_placeholders",
      `  - id: api
    request:
      method: GET
      url: "https://app.example.test/api/me?token=\${vars.t}"
      headers:
        Authorization: "Bearer \${env.API_TOKEN}"
`,
    );
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 visible matches");
    const draftTo = join(artifactRoot, "drafts", "journal_placeholders.yml");
    const { open, handle } = await openAccompany({
      specPath,
      backend,
      artifactRoot,
      vars: { t: "abc" },
      env: { ...process.env, API_TOKEN: "api-token-secret-value" },
      journal: { draftTo },
    });
    const done = await chooseAccompany(open.sessionId, {
      by: "role",
      role: "button",
      name: "OK",
    });
    expect(done.status).toBe("completed");
    for (const path of [draftTo, join(handle.journal!, "draft.spec.yml")]) {
      const text = await readFile(path, "utf8");
      const steps = parse(text).steps;
      expect(steps[0].click.name).toBe("OK");
      expect(steps[1].request).toMatchObject({
        url: "https://app.example.test/api/me?token=${vars.t}",
        headers: { Authorization: "Bearer ${env.API_TOKEN}" },
      });
      expect(text).not.toContain("api-token-secret-value");
    }
    await closeAccompany(open.sessionId);
  });

  it("journals a replacement for an imported action step without touching either file", async () => {
    const { mkdir, readFile } = await import("node:fs/promises");
    await mkdir(join(artifactRoot, "actions"), { recursive: true });
    const actionPath = join(artifactRoot, "actions", "press_go.yml");
    await writeFile(
      actionPath,
      `version: 1
name: press_go
steps:
  - click: { by: role, role: button, name: Go }
`,
    );
    const specPath = join(artifactRoot, "uses_action.yml");
    await writeFile(
      specPath,
      `version: 1
name: uses_action
intent: click through an action
coldStart: guest
imports: [actions/press_go.yml]
outcomes:
  - id: clean
    description: mock console stays clean
    verify: { console: { errorsMax: 0 } }
steps:
  - use: press_go
`,
    );
    const actionSource = await readFile(actionPath, "utf8");
    const backend = new MockBrowserBackend();
    backend.failNextStep("0 visible matches");
    const { open, handle } = await openAccompany({
      specPath,
      backend,
      artifactRoot,
    });
    await chooseAccompany(open.sessionId, {
      by: "role",
      role: "button",
      name: "Proceed",
    });
    const recorded = (await journalEvents(handle.journal!)).find(
      (e) => e["type"] === "step.recorded",
    );
    expect(recorded).toMatchObject({
      step: { click: { by: "role", role: "button", name: "Proceed" } },
      origin: { file: actionPath, stepIndex: 0 },
    });
    // Only spec-level steps are patched into the draft copy.
    expect(statusAccompany(open.sessionId)?.draftPath).toBeUndefined();
    expect(await readFile(actionPath, "utf8")).toBe(actionSource);
    await closeAccompany(open.sessionId);
  });

  it("journal: false keeps the session journal-less", async () => {
    const specPath = await writeClickSpec("no_journal");
    const { open, handle } = await openAccompany({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot,
      journal: false,
    });
    expect(open.status).toBe("completed");
    expect(handle.journal).toBeUndefined();
    await closeAccompany(open.sessionId);
  });
});
