import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { Step } from "../schema/spec.v1";
import {
  closeSession,
  DiscoverySetupError,
  interact,
  openSession,
  resumeSession,
  type DiscoverySessionOptions,
} from "./DiscoverySession";
import { exportJournalSession, exportLiveSession } from "./exportSession";
import { readSessionJournal } from "./sessionJournal";

/**
 * A discovery session must survive its own lifecycle: what it records
 * exports and resumes, the journal keeps placeholders, live actions see
 * what one run would see, and one journal never has two writers.
 */

const PAGE = `- main
  - heading "Sign in" [level=1, ref=e1]
  - textbox "Email" [ref=e2]
  - textbox "Greeting" [ref=e3]
  - button "Sign In" [ref=e4]
  - button "Go" [ref=e5]`;

const OUTCOMES = [
  { id: "done", description: "done", verify: { url: { matches: ".*" } } },
];

interface Project {
  dir: string;
  artifactRoot: string;
}

async function project(): Promise<Project> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-discovery-continuity-"));
  await mkdir(join(dir, "actions"), { recursive: true });
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(
    join(dir, "actions", "login_as_admin.yml"),
    `version: 1
name: login_as_admin
steps:
  - open: /login
  - fill: { by: label, name: Email, value: admin@example.test }
  - click: { by: role, role: button, name: Sign In }
`,
  );
  await writeFile(
    join(dir, "actions", "press_go.yml"),
    `version: 1
name: press_go
steps:
  - click: { by: role, role: button, name: Go }
`,
  );
  return { dir, artifactRoot: join(dir, "runs") };
}

function backend(): MockBrowserBackend {
  const b = new MockBrowserBackend();
  b.setSnapshot(PAGE);
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

/** A secrets provider holding CB_TOKEN (a provider key) and API_TOKEN. */
async function secrets() {
  return {
    env: {
      ...process.env,
      CB_TOKEN: "cb-secret-value-123",
      API_TOKEN: "api-secret-value-456",
    } as Record<string, string | undefined>,
    secretValues: ["cb-secret-value-123", "api-secret-value-456"],
    secretNames: ["CB_TOKEN"],
  };
}

function kind(step: Step): string {
  return Object.keys(step).find((key) => key !== "id") ?? "";
}

async function journalText(dir: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (!entry.name.endsWith(".png")) {
        parts.push(await readFile(path, "utf8"));
      }
    }
  };
  await walk(dir);
  return parts.join("\n");
}

describe("use: steps recorded through interact", () => {
  it("export (live, conventions, journal) carries their imports", async () => {
    const p = await project();
    const handle = await openSession(backend(), "/login", opts(p));
    const used = await interact(handle, { step: { use: "press_go" } });
    expect(used.ok, used.error).toBe(true);

    for (const conventions of [false, true]) {
      const out = join(p.dir, "flows", `live_${conventions}.yml`);
      const result = await exportLiveSession(handle, {
        path: out,
        conventions,
        intent: "Press go",
        outcomes: OUTCOMES,
        cwd: p.dir,
        overwrite: true,
      });
      expect(result.verifyOk, result.verifyErrors?.join("; ")).toBe(true);
      expect(parseYaml(await readFile(out, "utf8")).imports).toEqual([
        "../actions/press_go.yml",
      ]);
    }
    const dir = handle.journal!.dir;
    await closeSession(handle);
    const fromJournal = await exportJournalSession(dir, {
      path: join(p.dir, "flows", "journal.yml"),
      intent: "Press go",
      outcomes: OUTCOMES,
      cwd: p.dir,
      configDir: p.dir,
    });
    expect(fromJournal.verifyOk, fromJournal.verifyErrors?.join("; ")).toBe(
      true,
    );
    const draft = parseYaml(
      await readFile(join(dir, "draft.spec.yml"), "utf8"),
    );
    expect(draft.imports).toEqual(["../actions/press_go.yml"]);
  });

  it("resume replays them, with and without a setup", async () => {
    for (const setup of [undefined, [{ use: "login_as_admin" }]] as const) {
      const p = await project();
      const handle = await openSession(
        backend(),
        setup ? undefined : "/login",
        opts(p, setup ? { setup: [...setup] } : {}),
      );
      expect((await interact(handle, { step: { use: "press_go" } })).ok).toBe(
        true,
      );
      const dir = handle.journal!.dir;
      await closeSession(handle);
      const fresh = backend();
      const resumed = await resumeSession(
        fresh,
        (await readSessionJournal(dir))!,
        opts(p),
      );
      expect(resumed.imports.map((file) => file.split("/").pop())).toEqual(
        setup ? ["login_as_admin.yml", "press_go.yml"] : ["press_go.yml"],
      );
      expect(fresh.stepLog.map(kind).at(-1)).toBe("click");
      await closeSession(resumed);
    }
  });
});

describe("placeholders in the journal", () => {
  it("keeps ?token=${secrets.X} and Bearer ${env.X}; the draft parses; resume resolves them", async () => {
    const p = await project();
    const b = backend();
    const handle = await openSession(
      b,
      "https://app.example.test/cb?token=cb-secret-value-123",
      opts(p, {
        recordUrl: "https://app.example.test/cb?token=${secrets.CB_TOKEN}",
        resolveSecrets: secrets,
      }),
    );
    const request = await interact(handle, {
      action: "request",
      request: {
        method: "GET",
        url: "https://app.example.test/api/me",
        headers: { Authorization: "Bearer ${env.API_TOKEN}" },
      },
    });
    expect(request.ok, request.error).toBe(true);
    expect(b.lastRequest?.headers?.["Authorization"]).toBe(
      "Bearer api-secret-value-456",
    );
    const dir = handle.journal!.dir;
    await closeSession(handle);

    const read = (await readSessionJournal(dir))!;
    const recorded = read.events.flatMap((e) =>
      e.type === "step.recorded" ? [e.step] : [],
    );
    expect(recorded).toEqual([
      { open: "https://app.example.test/cb?token=${secrets.CB_TOKEN}" },
      {
        request: {
          method: "GET",
          url: "https://app.example.test/api/me",
          headers: { Authorization: "Bearer ${env.API_TOKEN}" },
        },
      },
    ]);
    const draft = parseYaml(
      await readFile(join(dir, "draft.spec.yml"), "utf8"),
    );
    expect(draft.steps).toEqual(recorded);
    const text = await journalText(dir);
    expect(text).not.toContain("cb-secret-value-123");
    expect(text).not.toContain("api-secret-value-456");

    const fresh = backend();
    const resumed = await resumeSession(
      fresh,
      read,
      opts(p, { resolveSecrets: secrets }),
    );
    expect(fresh.stepLog[0]).toEqual({
      open: "https://app.example.test/cb?token=cb-secret-value-123",
    });
    await closeSession(resumed);
  });

  it("refuses to resume a step the journal holds as [redacted]; a journal export warns", async () => {
    const p = await project();
    const handle = await openSession(
      backend(),
      "https://app.example.test/cb?token=literal-not-a-placeholder",
      opts(p),
    );
    const dir = handle.journal!.dir;
    await closeSession(handle);
    const read = (await readSessionJournal(dir))!;
    await expect(resumeSession(backend(), read, opts(p))).rejects.toThrow(
      /hold \[redacted\]/,
    );
    const result = await exportJournalSession(dir, {
      path: join(p.dir, "flows", "x.yml"),
      intent: "x",
      outcomes: OUTCOMES,
      cwd: p.dir,
      configDir: p.dir,
    });
    expect(result.warnings?.join("\n")).toMatch(/\[redacted\]/);
  });
});

describe("one run context across actions", () => {
  it("splices an earlier capture into a later action; refuses an uncaptured one", async () => {
    const p = await project();
    const b = backend();
    const handle = await openSession(b, "/login", opts(p));
    b.enqueueEvalResult("csrf-abc");
    const evaluated = await interact(handle, {
      action: "eval",
      eval: { js: "return 1", assign: "csrf" },
    });
    expect(evaluated.ok, evaluated.error).toBe(true);
    const sent = await interact(handle, {
      action: "request",
      request: {
        method: "POST",
        url: "https://app.example.test/api/x",
        headers: { "X-CSRF": "${evals.csrf.value}" },
      },
    });
    expect(sent.ok, sent.error).toBe(true);
    expect(b.lastRequest?.headers?.["X-CSRF"]).toBe("csrf-abc");
    expect(sent.recordedStep).toMatchObject({
      request: { headers: { "X-CSRF": "${evals.csrf.value}" } },
    });

    const typed = await interact(handle, {
      action: "fill",
      target: { by: "label", name: "Greeting" },
      value: "${requests.never.body.id}",
    });
    expect(typed.ok).toBe(false);
    expect(typed.error).toMatch(/requests\.never.*no earlier action/);
    expect(b.stepLog.some((s) => JSON.stringify(s).includes("${"))).toBe(false);
    await closeSession(handle);
  });

  it("a fromSpec setup's vars and redaction reach every later action", async () => {
    const p = await project();
    await writeFile(
      join(p.dir, "flows", "source.yml"),
      `version: 1
name: source_flow
intent: x
vars:
  greeting: hello-from-source
redaction:
  values: ["Jane Q Customer"]
outcomes:
  - id: o
    description: d
    verify: { url: { matches: ".*" } }
steps:
  - id: go
    open: /profile
`,
    );
    const b = backend();
    b.setSnapshot(`${PAGE}\n  - heading "Jane Q Customer" [level=2, ref=e6]`);
    const handle = await openSession(
      b,
      undefined,
      opts(p, {
        cwd: join(p.dir, "flows"),
        setup: { fromSpec: "source.yml", untilStep: "go" },
        snapshotMode: "full",
      }),
    );
    expect(JSON.stringify(handle.opened!.snapshot)).not.toContain("Jane Q");
    const filled = await interact(handle, {
      action: "fill",
      target: { by: "label", name: "Greeting" },
      value: "${vars.greeting}",
    });
    expect(filled.ok, filled.error).toBe(true);
    expect(await b.getValue({ by: "label", name: "Greeting" })).toBe(
      "hello-from-source",
    );
    const dir = handle.journal!.dir;
    expect(await journalText(dir)).not.toContain("Jane Q Customer");
    await closeSession(handle);

    // The journal keeps the source absolute: export from another directory.
    const read = (await readSessionJournal(dir))!;
    expect(read.session.setup).toEqual({
      fromSpec: join(p.dir, "flows", "source.yml"),
      untilStep: "go",
    });
    const result = await exportJournalSession(dir, {
      path: join(p.dir, "out.yml"),
      intent: "x",
      outcomes: OUTCOMES,
      cwd: p.dir,
      configDir: p.dir,
    });
    expect(result.verifyOk, result.verifyErrors?.join("; ")).toBe(true);
  });
});

describe("setup errors carry their exit code", () => {
  it("7 when the environment policy refuses a fromSpec, 4 for an unknown action", async () => {
    const p = await project();
    const configPath = join(p.dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      `version: 1
defaultEnvironment: local
environments:
  local: { baseUrl: "http://localhost:9" }
  staging: { baseUrl: "http://localhost:9" }
`,
    );
    await writeFile(
      join(p.dir, "flows", "staging_only.yml"),
      `version: 1
name: staging_only
intent: x
requires: { env: [staging] }
outcomes:
  - id: o
    description: d
    verify: { url: { matches: ".*" } }
steps:
  - id: go
    open: /profile
`,
    );
    const refused = await openSession(
      backend(),
      undefined,
      opts(p, {
        configPath,
        runtimeInputs: { env: "local" },
        setup: { fromSpec: "flows/staging_only.yml", untilStep: "go" },
      }),
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DiscoverySetupError);
    expect((refused as DiscoverySetupError).exitCode).toBe(7);

    const missing = await openSession(
      backend(),
      undefined,
      opts(p, { setup: [{ use: "no_such_action" }] }),
    ).catch((e: unknown) => e);
    expect((missing as DiscoverySetupError).exitCode).toBe(4);
  });
});

describe("one writer per journal", () => {
  it("refuses to resume a session open in this process or in another live one", async () => {
    const p = await project();
    const handle = await openSession(backend(), "/login", opts(p));
    const dir = handle.journal!.dir;
    await expect(
      resumeSession(backend(), (await readSessionJournal(dir))!, opts(p)),
    ).rejects.toThrow(/open in this process/);
    await closeSession(handle);

    // session.json as another live process (the parent) leaves it.
    const file = join(dir, "session.json");
    const session = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({
        ...session,
        status: "open",
        pid: process.ppid,
        lastActivityAt: new Date().toISOString(),
      }),
    );
    await expect(
      resumeSession(backend(), (await readSessionJournal(dir))!, opts(p)),
    ).rejects.toThrow(new RegExp(`still open in process ${process.ppid}`));
  });

  it("a journal export survives the live session's next write", async () => {
    const p = await project();
    const handle = await openSession(backend(), "/login", opts(p));
    const dir = handle.journal!.dir;
    const out = join(p.dir, "flows", "x.yml");
    await exportJournalSession(dir, {
      path: out,
      intent: "Exported elsewhere",
      outcomes: OUTCOMES,
      cwd: p.dir,
      configDir: p.dir,
    });
    await interact(handle, {
      action: "click",
      target: { by: "role", role: "button", name: "Go" },
    });
    let session = (await readSessionJournal(dir))!.session;
    expect(session.exportedTo).toEqual([out]);
    expect(session.intent).toBe("Exported elsewhere");
    await closeSession(handle);
    session = (await readSessionJournal(dir))!.session;
    expect(session.status).toBe("exported");
  });
});

describe("reading a journal from a newer cairn", () => {
  it("keeps a step.recorded with an extra field; refuses an unreadable step", async () => {
    const p = await project();
    const handle = await openSession(backend(), "/login", opts(p));
    const dir = handle.journal!.dir;
    await closeSession(handle);
    const events = join(dir, "events.ndjson");
    await appendFile(
      events,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        type: "step.recorded",
        index: 9,
        step: { click: { by: "role", role: "button", name: "Go" } },
        addedLater: { by: "a newer cairn" },
      })}\n`,
    );
    let read = (await readSessionJournal(dir))!;
    expect(read.unreadableSteps).toBeUndefined();
    expect(read.events.filter((e) => e.type === "step.recorded")).toHaveLength(
      2,
    );

    await appendFile(
      events,
      `${JSON.stringify({ ts: "x", type: "step.recorded", index: "ten" })}\n`,
    );
    read = (await readSessionJournal(dir))!;
    expect(read.unreadableSteps).toBe(1);
    await expect(resumeSession(backend(), read, opts(p))).rejects.toThrow(
      /cannot be read/,
    );
    await expect(
      exportJournalSession(dir, {
        path: join(p.dir, "y.yml"),
        intent: "x",
        outcomes: OUTCOMES,
        cwd: p.dir,
        configDir: p.dir,
      }),
    ).rejects.toThrow(/cannot be read/);
    expect(existsSync(join(p.dir, "y.yml"))).toBe(false);
  });
});
