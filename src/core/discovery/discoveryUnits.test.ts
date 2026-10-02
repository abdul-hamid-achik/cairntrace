import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneRuns } from "../artifacts/retention";
import { discoveryConfigOf } from "../schema/discovery.v1";
import { SessionEventSchema } from "../schema/events.v1";
import {
  mutationsOf,
  queryNetwork,
  toDiscoveryEntry,
  urlPath,
} from "./networkLog";
import {
  journalSteps,
  listSessions,
  pruneSessions,
  readSessionJournal,
  resolveSessionDir,
  SESSIONS_DIR,
  SessionJournal,
} from "./sessionJournal";
import {
  rebaseImport,
  resolveActionFiles,
  resolveSetup,
  SetupResolutionError,
} from "./setup";
import {
  keyElements,
  parseSnapshotWithFlags,
  snapshotView,
} from "./snapshotView";
import { buildSpecYaml } from "./specExporter";
import {
  recordInteraction,
  secretPlaceholders,
  stepSchemaIssues,
  withPortableFilePaths,
  withSecretPlaceholders,
} from "./stepRecorder";
import { memoizeSecrets } from "./stepRunner";

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("snapshotView", () => {
  const before = parseSnapshotWithFlags(`- main
  - button "Open" [ref=e1]
  - button "Open" [ref=e2]
  - checkbox "Notify" [ref=e3]`);

  it("keys survive ref renumbering and tell identical siblings apart", () => {
    const after = parseSnapshotWithFlags(`- main
  - button "Open" [ref=e7]
  - button "Open" [ref=e8]
  - checkbox "Notify" [ref=e9]`);
    const a = keyElements(before).map((e) => e.key);
    const b = keyElements(after).map((e) => e.key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(4);
  });

  it("flags are attributes, so a state change is a diff", () => {
    const after = parseSnapshotWithFlags(`- main
  - button "Open" [ref=e1]
  - button "Open" [ref=e2]
  - checkbox "Notify" [checked, ref=e3]
  - dialog "Saved" [ref=e4]`);
    expect(after[3]!.attrs).toEqual({ checked: "true", ref: "e3" });
    const { snapshot, info } = snapshotView({
      current: after,
      previous: before,
      bytes: 10,
    });
    expect(snapshot.map((e) => [e.role, e.change])).toEqual([
      ["checkbox", "changed"],
      ["dialog", "added"],
    ]);
    expect(info).toMatchObject({
      mode: "diff",
      unchanged: 3,
      removed: [],
      elements: 5,
      returned: 2,
    });
    const gone = snapshotView({
      current: before.slice(0, 2),
      previous: before,
      bytes: 1,
    });
    expect(gone.info.removed?.map((e) => e.role)).toEqual([
      "button",
      "checkbox",
    ]);
  });

  it("compact, none, full and maxBytes", () => {
    const page = parseSnapshotWithFlags(`- main
  - generic
  - heading "Title" [level=1]
  - button "Go" [ref=e1]`);
    expect(
      snapshotView({ current: page, mode: "compact", bytes: 1 }).snapshot.map(
        (e) => e.role,
      ),
    ).toEqual(["heading", "button"]);
    expect(
      snapshotView({ current: page, mode: "none", bytes: 1 }).snapshot,
    ).toEqual([]);
    expect(
      snapshotView({ current: page, mode: "full", bytes: 1 }).snapshot,
    ).toHaveLength(4);
    const many = parseSnapshotWithFlags(
      Array.from(
        { length: 200 },
        (_, i) => `- button "Button number ${i}" [ref=e${i}]`,
      ).join("\n"),
    );
    const cut = snapshotView({
      current: many,
      mode: "full",
      maxBytes: 1024,
      bytes: 1,
    });
    expect(cut.info.truncated).toBe(true);
    expect(cut.info.returned).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(cut.snapshot))).toBeLessThanOrEqual(
      1024,
    );
  });

  it("never returns a secret, even in a removed element or an attribute", () => {
    const secret = ["sk", "live", "q1W2e3R4t5".repeat(2).slice(0, 14)].join(
      "_",
    );
    const redact = (text: string) => text.split(secret).join("[redacted]");
    const earlier = parseSnapshotWithFlags(
      `- main\n  - button "Copy ${secret}" [ref=e1]\n  - link "Reset" [ref=e2, url=https://x.test/r?k=${secret}]`,
    );
    const first = snapshotView({
      current: earlier,
      mode: "full",
      bytes: 1,
      redact,
    });
    const after = snapshotView({
      current: parseSnapshotWithFlags(`- main\n  - button "Done" [ref=e1]`),
      previous: earlier,
      mode: "diff",
      bytes: 1,
      redact,
    });
    const shown = JSON.stringify([first, after]);
    expect(shown).not.toContain(secret);
    expect(after.info.removed?.map((el) => el.name)).toContain(
      "Copy [redacted]",
    );
  });

  it("keeps the returned elements and the removed list within maxBytes together", () => {
    const view = snapshotView({
      current: buttonPage("B"),
      previous: buttonPage("A"),
      mode: "diff",
      maxBytes: 2000,
      bytes: 1,
    });
    const total =
      Buffer.byteLength(JSON.stringify(view.snapshot)) +
      Buffer.byteLength(JSON.stringify(view.info.removed));
    expect(view.info.truncated).toBe(true);
    expect(total).toBeLessThanOrEqual(2000);
  });
});

function buttonPage(prefix: string) {
  return parseSnapshotWithFlags(
    Array.from(
      { length: 300 },
      (_, i) => `- button "${prefix} button number ${i}" [ref=e${i}]`,
    ).join("\n"),
  );
}

describe("networkLog", () => {
  it("projects entries without query strings, headers or bodies", () => {
    const entry = toDiscoveryEntry(
      {
        method: "post",
        url: "https://app.test/api/items?token=s3cret#x",
        status: 201,
        headers: { authorization: "Bearer x" },
        postData: '{"password":"hunter2"}',
      },
      3,
      (text) => text,
    );
    expect(entry).toEqual({
      action: 3,
      method: "POST",
      url: "https://app.test/api/items",
      path: "/api/items",
      status: 201,
      postDataBytes: 22,
    });
    expect(JSON.stringify(entry)).not.toMatch(/hunter2|Bearer|s3cret/);
  });

  it("mutations are the non-GET requests; queries filter and cap", () => {
    const entries = [
      toDiscoveryEntry({ method: "GET", url: "/a", status: 200 }, 1, (t) => t),
      toDiscoveryEntry(
        { method: "PATCH", url: "/b?x=1", status: 204 },
        1,
        (t) => t,
      ),
      toDiscoveryEntry({ method: "DELETE", url: "https://h/c" }, 2, (t) => t),
    ];
    expect(mutationsOf(entries)).toEqual([
      { method: "PATCH", path: "/b", status: 204 },
      { method: "DELETE", path: "/c" },
    ]);
    expect(queryNetwork(entries, { sinceAction: 2 }).entries).toHaveLength(1);
    expect(queryNetwork(entries, { method: "patch" }).entries[0]!.path).toBe(
      "/b",
    );
    expect(queryNetwork(entries, { limit: 1 })).toMatchObject({
      total: 3,
      truncated: true,
    });
    expect(urlPath("https://h/x/y?z")).toBe("/x/y");
  });
});

describe("stepRecorder (new actions)", () => {
  it("builds valid spec steps for focus, press+target, eval, wait, assert, request", () => {
    const steps = [
      recordInteraction({ action: "focus", target: "#q" }),
      recordInteraction({
        action: "press",
        value: "Enter",
        target: { by: "label", name: "Search" },
      }),
      recordInteraction({
        action: "eval",
        eval: { js: "return 1", assign: "one" },
      }),
      recordInteraction({
        action: "wait",
        wait: { selector: ".row", state: "visible" },
      }),
      recordInteraction({ action: "assert", assert: { text: "Saved" } }),
      recordInteraction({
        action: "request",
        request: { method: "GET", url: "/api/me" },
      }),
      recordInteraction({ action: "click", target: "#x", id: "save" }),
    ];
    for (const step of steps) expect(stepSchemaIssues(step)).toBeUndefined();
    expect(steps[4]).toEqual({ wait: { text: "Saved" } });
    expect(steps[6]).toEqual({
      id: "save",
      click: { by: "selector", selector: "#x" },
    });
    expect(
      recordInteraction({ action: "assert", assert: { ms: 5 } }),
    ).toBeUndefined();
    expect(recordInteraction({ action: "focus" })).toBeUndefined();
    expect(stepSchemaIssues({ eval: { js: "a", file: "b" } })).toContain(
      "exactly one of js | file",
    );
  });

  it("maps secret literals to placeholders (provider names win over env)", () => {
    const secrets = secretPlaceholders(
      {
        ADMIN_PASSWORD: "hunter2-long",
        API_TOKEN: "tok-123456",
        SHORT_TOKEN: "abc",
        PLAIN: "public-value",
      },
      {
        secretNames: ["ADMIN_PASSWORD"],
        isSensitiveKey: (k) => /TOKEN|PASSWORD/.test(k),
      },
    );
    expect(secrets.map((s) => s.placeholder).toSorted()).toEqual([
      "${env.API_TOKEN}",
      "${secrets.ADMIN_PASSWORD}",
    ]);
    expect(
      withSecretPlaceholders(
        {
          fill: { by: "label", name: "Password", value: "hunter2-long" },
          request: { url: "/x?t=tok-123456" },
        },
        secrets,
      ),
    ).toEqual({
      fill: {
        by: "label",
        name: "Password",
        value: "${secrets.ADMIN_PASSWORD}",
      },
      request: { url: "/x?t=${env.API_TOKEN}" },
    });
  });

  it("records relative upload/eval files under ${config.dir}", () => {
    const opts = { cwd: "/repo/flows", configDir: "/repo" };
    expect(
      withPortableFilePaths(
        { upload: { by: "selector", selector: "#f", path: "fx/a.csv" } },
        opts,
      ),
    ).toEqual({
      upload: {
        by: "selector",
        selector: "#f",
        path: "${config.dir}/flows/fx/a.csv",
      },
    });
    expect(withPortableFilePaths({ eval: { file: "probe.js" } }, opts)).toEqual(
      {
        eval: { file: "${config.dir}/flows/probe.js" },
      },
    );
    const kept = {
      upload: { by: "selector", selector: "#f", path: "${config.dir}/x" },
    };
    expect(withPortableFilePaths(kept, opts)).toEqual(kept);
  });
});

describe("setup resolution", () => {
  it("finds actions by name: explicit imports, template imports, actions/ scan", async () => {
    const dir = await tmp("cairn-setup-");
    await mkdir(join(dir, "shared"), { recursive: true });
    await mkdir(join(dir, "flows", "actions"), { recursive: true });
    await writeFile(
      join(dir, "shared", "a.yml"),
      "version: 1\nname: alpha\nsteps:\n  - open: /a\n",
    );
    await writeFile(
      join(dir, "flows", "actions", "b.yml"),
      "version: 1\nname: beta\nsteps:\n  - open: /b\n",
    );
    await writeFile(
      join(dir, "flows", "actions", "not-action.yml"),
      "version: 1\nname: gamma\nintent: x\noutcomes: []\nsteps: []\n",
    );
    expect(
      await resolveActionFiles(["alpha"], {
        configDir: dir,
        imports: ["shared/a.yml"],
        cwd: dir,
      }),
    ).toEqual([join(dir, "shared", "a.yml")]);
    expect(
      await resolveActionFiles(["alpha"], {
        configDir: dir,
        config: { authoring: { template: { imports: ["shared/a.yml"] } } },
      }),
    ).toEqual([join(dir, "shared", "a.yml")]);
    expect(await resolveActionFiles(["beta"], { configDir: dir })).toEqual([
      join(dir, "flows", "actions", "b.yml"),
    ]);
    await expect(
      resolveActionFiles(["gamma"], { configDir: dir }),
    ).rejects.toBeInstanceOf(SetupResolutionError);
    await expect(
      resolveActionFiles(["alpha"], {
        configDir: dir,
        imports: ["flows/actions/not-action.yml"],
        cwd: dir,
      }),
    ).rejects.toThrow(/not a reusable action/);
  });

  it("fromSpec carries vars/requires/resume and warns about preconditions", async () => {
    const dir = await tmp("cairn-fromspec-");
    const spec = join(dir, "s.yml");
    await writeFile(
      spec,
      `version: 1
name: s
intent: x
vars: { who: admin }
requires: { env: [local] }
session: { resume: auth }
preconditions: { commands: [{ run: "true" }] }
outcomes: [{ id: o, description: d, verify: { text: { contains: X } } }]
steps:
  - open: /a
  - open: /b
  - open: /c
`,
    );
    const resolved = await resolveSetup(
      { fromSpec: spec, untilStep: 2 },
      { configDir: dir, cwd: dir },
    );
    expect(resolved.steps).toEqual([{ open: "/a" }, { open: "/b" }]);
    expect(resolved.specDir).toBe(dir);
    expect(resolved.resume).toBe("auth");
    expect(resolved.extra).toEqual({
      vars: { who: "admin" },
      requires: { env: ["local"] },
    });
    expect(resolved.warnings[0]).toContain("preconditions");
    expect(resolved.exported).toMatchObject({
      vars: { who: "admin" },
      resume: "auth",
    });
    const explicit = await resolveSetup(
      { fromSpec: spec, untilStep: "3" },
      { configDir: dir, cwd: dir, resume: "other" },
    );
    expect(explicit.steps).toHaveLength(3);
    expect(explicit.resume).toBe("other");
  });

  it("rebases imports to the written spec", () => {
    expect(rebaseImport("/p/actions/login.yml", "/p/flows/_drafts/x.yml")).toBe(
      "../../actions/login.yml",
    );
  });
});

function state(
  id: string,
  openedAt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    version: 1 as const,
    sessionId: id,
    kind: "discovery" as const,
    pid: 999_999_999,
    origin: "mcp" as const,
    startUrl: "/x",
    backend: "mock",
    headed: false,
    status: "closed" as const,
    openedAt,
    lastActivityAt: openedAt,
    ttlMs: 1000,
    ...extra,
  };
}
describe("session journal files", () => {
  it("journalSteps honours step.removed; events validate against the schema", async () => {
    const root = await tmp("cairn-journal-");
    const journal = SessionJournal.create(
      root,
      state("journal-steps-1", "2026-10-01T00:00:00.000Z"),
    )!;
    const ts = "2026-10-01T00:00:01.000Z";
    journal.append({
      ts,
      type: "step.recorded",
      index: 1,
      step: { open: "/x" },
    });
    journal.append({
      ts,
      type: "step.recorded",
      index: 2,
      step: { click: { by: "selector", selector: "#a" } },
    });
    journal.append({
      ts,
      type: "action.performed",
      index: 3,
      action: "click",
      ok: false,
      urlBefore: "/x",
      urlAfter: "/x",
      durationMs: 1,
    });
    journal.append({ ts, type: "step.removed", index: 2 });
    const read = (await readSessionJournal(journal.dir))!;
    for (const event of read.events)
      expect(SessionEventSchema.safeParse(event).success).toBe(true);
    expect(journalSteps(read.events)).toEqual({
      steps: [{ index: 1, step: { open: "/x" } }],
      failedActions: 1,
    });
    expect(await resolveSessionDir("journal-steps-1", root)).toBe(journal.dir);
    expect(await resolveSessionDir(journal.dir, "/nowhere")).toBe(journal.dir);
    await expect(resolveSessionDir("missing-session", root)).rejects.toThrow(
      /not found/,
    );
  });

  it("prunes old journals but keeps open-alive and draft-referenced ones", async () => {
    const root = await tmp("cairn-prune-sessions-");
    const draft = join(root, "draft.yml");
    for (let i = 0; i < 6; i++) {
      const id = `session-prune-${i}`;
      SessionJournal.create(
        root,
        state(id, `2026-10-0${i + 1}T00:00:00.000Z`, {
          ...(i === 0 ? { status: "open", pid: process.pid } : {}),
          ...(i === 1 ? { exportedTo: [draft] } : {}),
          ...(i === 2 ? { exportedTo: [join(root, "gone.yml")] } : {}),
        }),
      );
    }
    await writeFile(draft, "# Discovery session: session-prune-1\n");
    const removed = await pruneSessions(root, { keep: 2 });
    expect(removed).toEqual(["session-prune-2", "session-prune-3"]);
    expect((await listSessions(root)).map((s) => s.session.sessionId)).toEqual([
      "session-prune-5",
      "session-prune-4",
      "session-prune-1",
      "session-prune-0",
    ]);
    // `cairn clean --all` (keepRuns 0) goes through pruneRuns.
    const result = await pruneRuns(root, { keepRuns: 0 });
    expect(result.removedSessions).toEqual([
      "session-prune-4",
      "session-prune-5",
    ]);
    expect(existsSync(join(root, SESSIONS_DIR, "session-prune-1"))).toBe(true);
  });
});

describe("specExporter", () => {
  it("writes setup as imports + use:, then the recorded steps, with the session id", () => {
    const { yaml, stepCount } = buildSpecYaml({
      name: "x",
      intent: "y",
      outcomes: [
        { id: "o", description: "d", verify: { text: { contains: "z" } } },
      ],
      steps: [{ open: "/a" }],
      setupSteps: [{ use: "login" }],
      imports: ["../actions/login.yml"],
      sessionId: "abc-session",
    });
    expect(stepCount).toBe(2);
    expect(yaml).toContain("# Discovery session: abc-session");
    expect(yaml.indexOf("imports:")).toBeLessThan(yaml.indexOf("outcomes:"));
    expect(yaml).toMatch(/steps:\n {2}- use: login\n {2}- open: \/a/);
  });
});

describe("misc", () => {
  it("discoveryConfigOf reads the block leniently", () => {
    expect(
      discoveryConfigOf({
        discovery: { sessionTtlMs: 5000, backend: "playwright" },
      }),
    ).toEqual({
      sessionTtlMs: 5000,
      backend: "playwright",
    });
    expect(discoveryConfigOf({ discovery: { sessionTtlMs: -1 } })).toEqual({});
    expect(discoveryConfigOf(undefined)).toEqual({});
  });

  it("memoizeSecrets resolves once per placeholder set", async () => {
    const dir = await tmp("cairn-memo-");
    let calls = 0;
    const resolve = memoizeSecrets(async () => {
      calls++;
      return { env: {} };
    });
    const a = join(dir, "a.yml");
    const b = join(dir, "b.yml");
    await writeFile(a, "steps:\n  - fill: { value: '${secrets.A}' }\n");
    await writeFile(
      b,
      "steps:\n  - fill: { value: '${secrets.A}' }\n  - click: x\n",
    );
    await resolve(a);
    await resolve(b);
    expect(calls).toBe(1);
    await writeFile(b, "steps:\n  - fill: { value: '${secrets.B}' }\n");
    await resolve(b);
    expect(calls).toBe(2);
  });
});

describe("fromSpec coldStart", () => {
  it("carries a guest source's coldStart into the export", async () => {
    const dir = await tmp("cairn-guest-");
    const spec = join(dir, "g.yml");
    await writeFile(
      spec,
      "version: 1\nname: g\nintent: x\ncoldStart: guest\noutcomes: [{ id: o, description: d, verify: { text: { contains: X } } }]\nsteps:\n  - open: /a\n",
    );
    const resolved = await resolveSetup(
      { fromSpec: spec, untilStep: 1 },
      { configDir: dir, cwd: dir },
    );
    expect(resolved.exported.coldStart).toBe("guest");
    const { yaml } = buildSpecYaml({
      name: "g2",
      intent: "y",
      outcomes: [
        { id: "o", description: "d", verify: { text: { contains: "z" } } },
      ],
      steps: [],
      setupSteps: resolved.exported.steps,
      coldStart: resolved.exported.coldStart,
    });
    expect(yaml).toContain("coldStart: guest");
  });
});
