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
