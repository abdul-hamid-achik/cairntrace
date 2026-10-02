import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { Step } from "../schema/spec.v1";
import {
  closeSession,
  DiscoverySetupError,
  getExportableSteps,
  getNetwork,
  interact,
  navigate,
  openSession,
  removeStep,
  resumeSession,
  sweepSessions,
  type DiscoverySessionOptions,
  type SessionRegistry,
} from "./DiscoverySession";
import {
  exportJournalSession,
  exportLiveSession,
  DiscoveryExportRefusedError,
} from "./exportSession";
import { readSessionJournal, SESSIONS_DIR } from "./sessionJournal";

const LOGIN_SNAPSHOT = `- main
  - heading "Sign in" [level=1, ref=e1]
  - textbox "Email" [ref=e2]
  - textbox "Password" [ref=e3]
  - button "Sign In" [ref=e4]`;

const DASHBOARD_SNAPSHOT = `- main
  - heading "Dashboard" [level=1, ref=e1]
  - button "New Project" [ref=e2]
  - checkbox "Notify" [checked, ref=e3]`;

interface Project {
  dir: string;
  artifactRoot: string;
}

async function project(): Promise<Project> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-discovery-journal-"));
  await mkdir(join(dir, "actions"), { recursive: true });
  await writeFile(
    join(dir, "actions", "login_as_admin.yml"),
    `version: 1
name: login_as_admin
vars:
  user: admin@example.test
steps:
  - open: /login
  - fill: { by: label, name: Email, value: "\${vars.user}" }
  - click: { by: role, role: button, name: Sign In }
`,
  );
  return { dir, artifactRoot: join(dir, "runs") };
}

function backend(snapshot = LOGIN_SNAPSHOT): MockBrowserBackend {
  const b = new MockBrowserBackend();
  b.setSnapshot(snapshot);
  b.setStrictStepValidation();
  return b;
}

function opts(
  p: Project,
  extra: DiscoverySessionOptions = {},
): DiscoverySessionOptions {
  return {
    artifactRoot: p.artifactRoot,
    origin: "mcp",
    configDir: p.dir,
    cwd: p.dir,
    mock: true,
    ...extra,
  };
}

/** The step kind (`open`, `click`, …), ignoring `id`. */
function kind(step: Step): string {
  return Object.keys(step).find((key) => key !== "id") ?? "";
}

async function events(dir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(dir, "events.ndjson"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A mock that records a mutation when a button is clicked. */
class SavingBackend extends MockBrowserBackend {
  override async runStep(step: Step) {
    const result = await super.runStep(step);
    if ("click" in step) {
      this.pushNetworkEntry({
        method: "PATCH",
        url: "https://app.example.test/api/answers/42?token=abc123",
        status: 204,
        resourceType: "fetch",
      });
      this.pushNetworkEntry({
        method: "GET",
        url: "https://app.example.test/api/answers/42",
        status: 200,
      });
    }
    return result;
  }
}

describe("session journal", () => {
  it("journals the open: session.json, events, screenshot, snapshot, draft", async () => {
    const p = await project();
    const b = backend();
    const handle = await openSession(
      b,
      "/login",
      opts(p, {
        recordUrl: "/login",
        envName: "local",
      }),
    );
    const dir = handle.journal!.dir;
    expect(dir).toBe(join(p.artifactRoot, SESSIONS_DIR, handle.session.id));

    const session = JSON.parse(
      await readFile(join(dir, "session.json"), "utf8"),
    );
    expect(session).toMatchObject({
      version: 1,
      sessionId: handle.session.id,
      kind: "discovery",
      origin: "mcp",
      startUrl: "/login",
      backend: "mock",
      headed: false,
      env: "local",
      status: "open",
      ttlMs: 30 * 60 * 1000,
      stepCount: 1,
      actionCount: 1,
    });

    const types = (await events(dir)).map((e) => e["type"]);
    expect(types).toEqual([
      "session.opened",
      "snapshot.captured",
      "action.performed",
      "step.recorded",
      "draft.updated",
    ]);
    const action = (await events(dir)).find(
      (e) => e["type"] === "action.performed",
    )!;
    expect(action).toMatchObject({
      index: 1,
      action: "open",
      ok: true,
      urlAfter: "/login",
      screenshot: "screenshots/001.png",
      snapshot: "snapshots/001.txt",
    });
    expect(existsSync(join(dir, "screenshots", "001.png"))).toBe(true);
    expect(await readFile(join(dir, "snapshots", "001.txt"), "utf8")).toBe(
      LOGIN_SNAPSHOT,
    );
    const draft = await readFile(join(dir, "draft.spec.yml"), "utf8");
    expect(draft).toContain(`Discovery session: ${handle.session.id}`);
    expect(parseYaml(draft).steps).toEqual([{ open: "/login" }]);
    // The per-action run was removed; the work dir is cleaned on close.
    await closeSession(handle);
    expect(existsSync(join(dir, "work"))).toBe(false);
    const closed = JSON.parse(
      await readFile(join(dir, "session.json"), "utf8"),
    );
    expect(closed.status).toBe("closed");
    expect((await events(dir)).at(-1)).toMatchObject({
      type: "session.closed",
      reason: "close",
    });
  });

  it("records each interaction with its screenshot, snapshot and network", async () => {
    const p = await project();
    const b = new SavingBackend();
    b.setSnapshot(LOGIN_SNAPSHOT);
    const handle = await openSession(
      b,
      "https://app.example.test/form",
      opts(p),
    );
    b.setSnapshot(DASHBOARD_SNAPSHOT);
    const result = await interact(handle, {
      action: "click",
      target: { by: "role", role: "button", name: "Sign In" },
    });
    expect(result.ok).toBe(true);
    expect(result.index).toBe(2);
    expect(result.screenshot).toBe("screenshots/002.png");
    expect(result.network?.mutations).toEqual([
      { method: "PATCH", path: "/api/answers/42", status: 204 },
    ]);
    const dir = handle.journal!.dir;
    const network = JSON.parse(
      await readFile(join(dir, "network", "002.json"), "utf8"),
    );
    expect(network).toHaveLength(2);
    // No query strings (they carry tokens), no headers or bodies.
    expect(JSON.stringify(network)).not.toContain("abc123");
    const performed = (await events(dir)).filter(
      (e) => e["type"] === "action.performed",
    );
    expect(performed[1]).toMatchObject({
      index: 2,
      action: "click",
      locator: { by: "role", role: "button", name: "Sign In" },
      ok: true,
      network: {
        mutations: [{ method: "PATCH", path: "/api/answers/42", status: 204 }],
      },
    });
    await closeSession(handle);
  });

  it("attributes requests that land after an action returned (late entries)", async () => {
    const p = await project();
    const b = new SavingBackend();
    b.setSnapshot(LOGIN_SNAPSHOT);
    const handle = await openSession(
      b,
      "https://app.example.test/form",
      opts(p),
    );
    await interact(handle, { action: "click", target: "#save" });
    // A debounced autosave completes after the click returned.
    b.pushNetworkEntry({
      method: "POST",
      url: "https://app.example.test/api/autosave",
      status: 201,
    });
    const all = await getNetwork(handle);
    expect(
      all.entries.map((e) => [e.action, e.method, e.path, e.late ?? false]),
    ).toEqual([
      [2, "PATCH", "/api/answers/42", false],
      [2, "GET", "/api/answers/42", false],
      [2, "POST", "/api/autosave", true],
    ]);
    // Filters.
    expect((await getNetwork(handle, { method: "post" })).entries).toHaveLength(
      1,
    );
    expect((await getNetwork(handle, { urlContains: "answers" })).total).toBe(
      2,
    );
    expect((await getNetwork(handle, { sinceAction: 3 })).entries).toEqual([]);
    // The next action does not re-attribute them.
    await interact(handle, { action: "press", value: "Escape" });
    const after = await getNetwork(handle, { sinceAction: 3 });
    expect(after.entries).toEqual([]);
    await closeSession(handle);
  });

  it("does not record a failed action as a step (action.performed ok:false)", async () => {
    const p = await project();
    const b = backend();
    const handle = await openSession(b, "/login", opts(p));
    b.failNextStep("0 visible matches");
    const result = await interact(handle, {
      action: "click",
      target: { by: "role", role: "button", name: "Missing" },
    });
    expect(result.ok).toBe(false);
    const evs = await events(handle.journal!.dir);
    expect(evs.filter((e) => e["type"] === "step.recorded")).toHaveLength(1);
    expect(
      evs.filter((e) => e["type"] === "action.performed").at(-1),
    ).toMatchObject({
      ok: false,
      action: "click",
    });
    expect(getExportableSteps(handle)).toEqual({
      steps: [{ open: "/login" }],
      skippedFailed: 1,
    });
    await closeSession(handle);
  });
});

describe("richer interactions", () => {
  it("eval returns its value; the recorded step stays as given", async () => {
    const p = await project();
    const b = backend();
    const handle = await openSession(b, "/login", opts(p));
    b.enqueueEvalResult({ items: 3 });
    const result = await interact(handle, {
      action: "eval",
      eval: { js: "return { items: document.querySelectorAll('li').length }" },
    });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ value: { items: 3 } });
    expect(result.recordedStep).toEqual({
      eval: { js: "return { items: document.querySelectorAll('li').length }" },
    });
    await closeSession(handle);
  });

  it("request returns status and body (browser cookies; recorded as a request step)", async () => {
    const p = await project();
    const b = backend();
    const handle = await openSession(b, "https://app.example.test/", opts(p));
    b.enqueueEvalResult({ status: 201, headers: {}, body: { id: 7 } });
    const result = await interact(handle, {
      action: "request",
      request: {
        method: "POST",
        url: "https://app.example.test/api/items",
        body: { a: 1 },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ status: 201, body: { id: 7 } });
    expect(result.recordedStep).toEqual({
      request: {
        method: "POST",
        url: "https://app.example.test/api/items",
        body: { a: 1 },
      },
    });
    await closeSession(handle);
  });

  it("records wait, assert (as wait), focus and press with a target", async () => {
    const p = await project();
    const b = backend();
    const handle = await openSession(b, "/login", opts(p));
    const wait = await interact(handle, {
      action: "wait",
      wait: { text: "Sign in" },
    });
    expect(wait.recordedStep).toEqual({ wait: { text: "Sign in" } });
    const assert = await interact(handle, {
      action: "assert",
      assert: { url: { includes: "/login" } },
    });
    expect(assert.ok).toBe(true);
    expect(assert.recordedStep).toEqual({
      wait: { url: { includes: "/login" } },
    });
    // Live, an assertion fails fast; the recorded wait keeps the run default.
    const textAssert = await interact(handle, {
      action: "assert",
      assert: { text: "Sign in" },
    });
    expect(textAssert.recordedStep).toEqual({ wait: { text: "Sign in" } });
    expect(b.stepLog.at(-1)).toEqual({
      wait: { text: "Sign in", timeoutMs: 5000 },
    });
    const badAssert = await interact(handle, {
      action: "assert",
      assert: { ms: 100 },
    });
    expect(badAssert.ok).toBe(false);
    expect(badAssert.error).toContain("assert");
    const focus = await interact(handle, {
      action: "focus",
      target: { by: "label", name: "Email" },
      id: "focus_email",
    });
    expect(focus.recordedStep).toEqual({
      id: "focus_email",
      focus: { by: "label", name: "Email" },
    });
    const press = await interact(handle, {
      action: "press",
      value: "Enter",
      target: { by: "label", name: "Password" },
    });
    expect(press.recordedStep).toEqual({
      press: "Enter",
      target: { by: "label", name: "Password" },
    });
    expect(getExportableSteps(handle).steps).toHaveLength(6);
    await closeSession(handle);
  });

  it("validates a raw `step` against the spec schema", async () => {
    const p = await project();
    const handle = await openSession(backend(), "/login", opts(p));
    const bad = await interact(handle, { step: { clack: "#x" } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("not a valid spec step");
    const good = await interact(handle, {
      step: { hover: { by: "role", role: "button", name: "Sign In" } },
    });
    expect(good.ok).toBe(true);
    expect(good.recordedStep).toEqual({
      hover: { by: "role", role: "button", name: "Sign In" },
    });
    await closeSession(handle);
  });

  it("records known secret literals as placeholders, never the value", async () => {
    const p = await project();
    const b = backend();
    const env = { ...process.env, ADMIN_PASSWORD: "SuperSecret-123" };
    const handle = await openSession(
      b,
      "/login",
      opts(p, {
        env,
        resolveSecrets: async () => ({ env, secretNames: ["ADMIN_PASSWORD"] }),
        secretNames: ["ADMIN_PASSWORD"],
      }),
    );
    const result = await interact(handle, {
      action: "fill",
      target: { by: "label", name: "Password" },
      value: "SuperSecret-123",
    });
    expect(result.ok).toBe(true);
    expect(result.recordedStep).toEqual({
      fill: {
        by: "label",
        name: "Password",
        value: "${secrets.ADMIN_PASSWORD}",
      },
    });
    // The page got the real value (the runner resolved the placeholder).
    expect(await b.getValue({ by: "label", name: "Password" })).toBe(
      "SuperSecret-123",
    );
    const dir = handle.journal!.dir;
    await closeSession(handle);
    for (const file of ["events.ndjson", "draft.spec.yml", "session.json"]) {
      expect(await readFile(join(dir, file), "utf8")).not.toContain(
        "SuperSecret-123",
      );
    }
  });

  it("records relative upload paths as ${config.dir}/…", async () => {
    const p = await project();
    const handle = await openSession(backend(), "/login", opts(p));
    const result = await interact(handle, {
      action: "upload",
      target: "#file",
      path: "fixtures/a.csv",
    });
    expect(result.recordedStep).toEqual({
      upload: {
        by: "selector",
        selector: "#file",
        path: "${config.dir}/fixtures/a.csv",
      },
    });
    await closeSession(handle);
  });

  it("removeStep undoes a recorded step (journal + draft)", async () => {
    const p = await project();
    const handle = await openSession(backend(), "/login", opts(p));
    const click = await interact(handle, { action: "click", target: "#a" });
    await interact(handle, { action: "click", target: "#b" });
    expect(removeStep(handle, click.index!)).toEqual({
      removed: true,
      steps: 2,
    });
    expect(removeStep(handle, 99).removed).toBe(false);
    expect(getExportableSteps(handle).steps).toEqual([
      { open: "/login" },
      { click: { by: "selector", selector: "#b" } },
    ]);
    const dir = handle.journal!.dir;
    expect((await events(dir)).some((e) => e["type"] === "step.removed")).toBe(
      true,
    );
    expect(
      parseYaml(await readFile(join(dir, "draft.spec.yml"), "utf8")).steps,
    ).toHaveLength(2);
    await closeSession(handle);
  });
});

describe("snapshot modes", () => {
  it("diff returns only changes with stable keys; compact/none/maxBytes", async () => {
    const p = await project();
    const b = backend(LOGIN_SNAPSHOT);
    const handle = await openSession(b, "/login", opts(p));
    // The first snapshot: everything is new.
    expect(handle.opened?.snapshotInfo).toMatchObject({
      mode: "diff",
      elements: 5,
      returned: 5,
    });
    b.setSnapshot(
      LOGIN_SNAPSHOT.replace(
        'button "Sign In" [ref=e4]',
        'button "Sign In" [disabled, ref=e9]',
      ) + '\n  - alert "Wrong password" [ref=e5]',
    );
    const result = await interact(handle, { action: "click", target: "#x" });
    expect(result.snapshot.map((e) => [e.role, e.name, e.change])).toEqual([
      ["button", "Sign In", "changed"],
      ["alert", "Wrong password", "added"],
    ]);
    expect(result.snapshotInfo).toMatchObject({ unchanged: 4, removed: [] });
    b.setSnapshot(DASHBOARD_SNAPSHOT);
    const compact = await interact(handle, {
      action: "click",
      target: "#y",
      snapshotMode: "compact",
    });
    expect(compact.snapshot.every((e) => e.ref || e.name)).toBe(true);
    const none = await interact(handle, {
      action: "click",
      target: "#z",
      snapshotMode: "none",
    });
    expect(none.snapshot).toEqual([]);
    expect(none.snapshotInfo?.path).toMatch(/^snapshots\/\d{3}\.txt$/);
    const tiny = await interact(handle, {
      action: "click",
      target: "#w",
      snapshotMode: "full",
      maxBytes: 300,
    });
    expect(tiny.snapshotInfo?.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(tiny.snapshot)),
    ).toBeLessThanOrEqual(300);
    await closeSession(handle);
  });
});

describe("setup before exploring", () => {
  it("runs imported actions through the runner and exports imports + use:", async () => {
    const p = await project();
    const b = backend();
    const handle = await openSession(
      b,
      "/dashboard",
      opts(p, {
        setup: [{ use: "login_as_admin", vars: { user: "qa@example.test" } }],
      }),
    );
    // The action's steps ran (expanded by the runner), then the open.
    expect(b.stepLog.slice(0, 4)).toEqual([
      { open: "/login" },
      { fill: { by: "label", name: "Email", value: "qa@example.test" } },
      { click: { by: "role", role: "button", name: "Sign In" } },
      { open: "/dashboard" },
    ]);
    expect(handle.opened?.setup).toMatchObject({ ok: true, steps: 3 });
    const dir = handle.journal!.dir;
    const session = JSON.parse(
      await readFile(join(dir, "session.json"), "utf8"),
    );
    expect(session.setup).toEqual([
      { use: "login_as_admin", vars: { user: "qa@example.test" } },
    ]);
    expect(session.imports).toEqual([
      join(p.dir, "actions", "login_as_admin.yml"),
    ]);
    const setupEvent = (await events(dir)).find(
      (e) => e["type"] === "action.performed" && e["action"] === "setup",
    );
    expect(setupEvent).toMatchObject({
      index: 1,
      ok: true,
      screenshot: "screenshots/001.png",
    });
    // The setup run stays in the journal as evidence.
    expect((await readdir(join(dir, "setup"))).length).toBe(1);

    const specPath = join(p.dir, "flows", "dashboard.yml");
    const exported = await exportLiveSession(handle, {
      path: specPath,
      intent: "An admin reaches the dashboard",
      outcomes: [
        {
          id: "dashboard",
          description: "Dashboard shows",
          verify: { text: { contains: "Dashboard" } },
        },
      ],
    });
    expect(exported.verifyOk).toBe(true);
    expect(exported.warnings?.some((w) => w.includes("cold-start"))).toBe(
      false,
    );
    const spec = parseYaml(await readFile(specPath, "utf8"));
    expect(spec.imports).toEqual(["../actions/login_as_admin.yml"]);
    expect(spec.steps).toEqual([
      { use: { action: "login_as_admin", vars: { user: "qa@example.test" } } },
      { open: "/dashboard" },
    ]);
    await closeSession(handle);
  });

  it("replays a spec through untilStep (spec-relative imports and files)", async () => {
    const p = await project();
    await mkdir(join(p.dir, "flows"), { recursive: true });
    const source = join(p.dir, "flows", "profile.yml");
    await writeFile(
      source,
      `version: 1
name: profile
intent: edit the profile
imports: [../actions/login_as_admin.yml]
outcomes:
  - id: saved
    description: saved
    verify: { text: { contains: Saved } }
steps:
  - id: login
    use: login_as_admin
  - id: open_profile
    open: /profile
  - id: save
    click: { by: role, role: button, name: Save }
`,
    );
    const b = backend();
    const handle = await openSession(
      b,
      undefined,
      opts(p, {
        setup: { fromSpec: source, untilStep: "open_profile" },
      }),
    );
    expect(b.stepLog.map(kind)).toEqual(["open", "fill", "click", "open"]);
    expect(
      b.stepLog.some((s) => "click" in s && JSON.stringify(s).includes("Save")),
    ).toBe(false);
    // The synthetic spec next to the source is gone.
    expect(
      (await readdir(join(p.dir, "flows"))).filter((f) => f.startsWith("_")),
    ).toEqual([]);
    await interact(handle, {
      action: "click",
      target: { by: "role", role: "button", name: "Save" },
    });
    const out = join(p.dir, "flows", "_drafts", "profile_saved.yml");
    await exportLiveSession(handle, {
      path: out,
      intent: "Profile saves",
      outcomes: [
        {
          id: "saved",
          description: "saved",
          verify: { text: { contains: "Saved" } },
        },
      ],
    });
    const spec = parseYaml(await readFile(out, "utf8"));
    expect(spec.imports).toEqual(["../../actions/login_as_admin.yml"]);
    expect(spec.steps).toEqual([
      { id: "login", use: "login_as_admin" },
      { id: "open_profile", open: "/profile" },
      { click: { by: "role", role: "button", name: "Save" } },
    ]);
    await closeSession(handle);
  });

  it("fails the open with the step ids when untilStep is unknown", async () => {
    const p = await project();
    const source = join(p.dir, "s.yml");
    await writeFile(
      source,
      `version: 1
name: s
intent: x
outcomes: [{ id: o, description: d, verify: { text: { contains: X } } }]
steps:
  - { id: a, open: /a }
  - { id: b, open: /b }
`,
    );
    await expect(
      openSession(
        backend(),
        undefined,
        opts(p, { setup: { fromSpec: source, untilStep: "zzz" } }),
      ),
    ).rejects.toThrow(/step ids: a, b/);
  });

  it("closes the journal with the error when the setup fails", async () => {
    const p = await project();
    const b = backend();
    b.failNextStep("0 visible matches");
    const error = await openSession(
      b,
      "/dashboard",
      opts(p, {
        setup: [{ use: "login_as_admin" }],
        sessionId: "setup-fails-1",
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscoverySetupError);
    expect((error as DiscoverySetupError).runDir).toBeTruthy();
    const read = await readSessionJournal(
      join(p.artifactRoot, SESSIONS_DIR, "setup-fails-1"),
    );
    expect(read?.session.status).toBe("closed");
    expect(read?.events.at(-1)).toMatchObject({
      type: "session.closed",
      reason: "close",
    });
    const last = read?.events.at(-1) as { error?: string } | undefined;
    expect(last?.error).toContain("setup failed");
  });

  it("restores a resume checkpoint (scoped run semantics) before setup", async () => {
    const p = await project();
    const missing = await openSession(
      backend(),
      "/x",
      opts(p, { resume: "no-such-checkpoint" }),
    ).catch((e: unknown) => e as Error);
    expect(missing).toBeInstanceOf(DiscoverySetupError);
    expect((missing as Error).message).toMatch(/no-such-checkpoint/);

    const checkpoints = join(process.env.HOME!, ".cairntrace", "checkpoints");
    await mkdir(checkpoints, { recursive: true });
    await writeFile(
      join(checkpoints, "discovery-auth.json"),
      JSON.stringify({ cookies: [], origins: [] }),
    );
    const handle = await openSession(
      backend(),
      "/x",
      opts(p, { resume: "discovery-auth" }),
    );
    expect(handle.opened?.setup?.ok).toBe(true);
    const out = join(p.dir, "resumed.yml");
    await exportLiveSession(handle, {
      path: out,
      intent: "resumed",
      outcomes: [
        { id: "o", description: "d", verify: { text: { contains: "x" } } },
      ],
    });
    expect(parseYaml(await readFile(out, "utf8")).session).toEqual({
      resume: "discovery-auth",
    });
    await closeSession(handle);
  });
});

describe("TTL, export from the journal, resume", () => {
  it("expires the browser but keeps the journal; exports and resumes from it", async () => {
    const p = await project();
    const b = backend();
    const handle = await openSession(
      b,
      "/login",
      opts(p, { ttlMs: 1000, setup: [{ use: "login_as_admin" }] }),
    );
    await interact(handle, {
      action: "click",
      target: { by: "role", role: "button", name: "Sign In" },
    });
    const id = handle.session.id;
    const dir = handle.journal!.dir;
    const registry: SessionRegistry = new Map([[id, handle]]);
    expect(await sweepSessions(registry, Date.now() + 2000)).toEqual([id]);
    expect(b.closeCalls).toBe(1);
    let read = await readSessionJournal(dir);
    expect(read?.session.status).toBe("expired");
    expect(read?.events.at(-1)).toMatchObject({
      type: "session.closed",
      reason: "ttl",
    });

    // Export from the journal alone.
    const out = join(p.dir, "flows", "_drafts", "from_journal.yml");
    const result = await exportJournalSession(dir, {
      path: out,
      intent: "Admin signs in",
      outcomes: [
        {
          id: "signed_in",
          description: "signed in",
          verify: { url: { startsWith: "/" } },
        },
      ],
      configDir: p.dir,
    });
    expect(result).toMatchObject({
      verifyOk: true,
      stepCount: 3,
      sessionId: id,
    });
    const spec = await readFile(out, "utf8");
    expect(spec).toContain(`Discovery session: ${id}`);
    expect(parseYaml(spec).steps).toEqual([
      { use: "login_as_admin" },
      { open: "/login" },
      { click: { by: "role", role: "button", name: "Sign In" } },
    ]);
    read = await readSessionJournal(dir);
    expect(read?.session.status).toBe("exported");
    expect(read?.session.exportedTo).toEqual([out]);
    expect(read?.session.intent).toBe("Admin signs in");
    expect(read?.events.find((e) => e.type === "export.written")).toMatchObject(
      {
        path: out,
        verify: { status: "warnings" },
      },
    );

    // Resume on a fresh backend: setup + recorded steps replay.
    const fresh = backend();
    const resumed = await resumeSession(fresh, read!, opts(p));
    expect(resumed.session.id).toBe(id);
    expect(fresh.stepLog.map(kind)).toEqual([
      "open",
      "fill",
      "click", // setup (login_as_admin)
      "open",
      "click", // the recorded steps
    ]);
    const next = await interact(resumed, { action: "press", value: "Enter" });
    // setup 1, open 2, click 3 — then the resume's setup 4 and replay 5.
    expect(next.index).toBe(6);
    read = await readSessionJournal(dir);
    expect(read?.session.status).toBe("open");
    expect(
      read?.events.filter((e) => e.type === "session.opened"),
    ).toHaveLength(2);
    expect(getExportableSteps(resumed).steps).toHaveLength(3);
    await closeSession(resumed);
  });

  it("refuses a stamped spec without overwrite and an invalid export", async () => {
    const p = await project();
    const handle = await openSession(backend(), "/login", opts(p));
    const stamped = join(p.dir, "stamped.yml");
    await writeFile(stamped, "version: 1\nname: x\ncontractHash: sha256:abc\n");
    await expect(
      exportLiveSession(handle, {
        path: stamped,
        intent: "x",
        outcomes: [
          { id: "o", description: "d", verify: { text: { contains: "x" } } },
        ],
      }),
    ).rejects.toBeInstanceOf(DiscoveryExportRefusedError);
    await closeSession(handle);
  });
});

describe("navigate through the runner", () => {
  it("records relative URLs relative and keeps the journal URL query-free", async () => {
    const p = await project();
    const b = backend();
    const handle = await openSession(
      b,
      "https://app.example.test/a?token=zzz-secret-zzz",
      opts(p, {
        recordUrl: "https://app.example.test/a?token=zzz-secret-zzz",
        baseUrl: "https://app.example.test",
      }),
    );
    const moved = await navigate(handle, "/b");
    expect(moved.recordedStep).toEqual({ open: "/b" });
    const evs = await events(handle.journal!.dir);
    const first = evs.find((e) => e["type"] === "action.performed")!;
    expect(first["urlAfter"]).toBe("https://app.example.test/a");
    await closeSession(handle);
  });
});
