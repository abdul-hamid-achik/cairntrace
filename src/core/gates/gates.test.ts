import { createServer, type Server } from "node:http";
import {
  createServer as createTcpServer,
  type Server as TcpServer,
} from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunEventSchema, type GateEvent } from "../schema/events.v1";
import { ConfigSchema } from "../schema/config.v1";
import {
  assertGateRefs,
  checkGateOnce,
  GateReferenceError,
  waitForGate,
  waitForGates,
  type GateContext,
} from "./evaluate";
import {
  jsonMismatch,
  readJsonPath,
  resolveSecretRefs,
  statusMatches,
} from "./probes";
import {
  durationMs,
  gateRegistryProblems,
  GateNodeSchema,
  GatesRegistrySchema,
  type GateNode,
} from "./schema";

/**
 * Typed readiness gates against REAL listeners: local HTTP servers that
 * answer 503 before 200, TCP sockets that open late, sleeping child
 * processes that must be killed at the deadline.
 */

let dir: string;
const servers: Array<Server | TcpServer> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-gates-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }
  await rm(dir, { recursive: true, force: true });
});

interface Answer {
  status: number;
  body?: unknown;
}

/** An HTTP server answering `answers[i]` for the i-th request (last repeats). */
async function sequenceServer(
  answers: Answer[],
  seen: Array<{ authorization?: string }> = [],
): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    seen.push(
      req.headers.authorization
        ? { authorization: req.headers.authorization }
        : {},
    );
    const answer = answers[Math.min(hits, answers.length - 1)]!;
    hits += 1;
    res.statusCode = answer.status;
    if (answer.body !== undefined) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.body));
    } else {
      res.end("ok");
    }
  });
  servers.push(server);
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, hits: () => hits };
}

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolveListen) =>
    probe.listen(0, "127.0.0.1", () => resolveListen()),
  );
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return port;
}

async function listenTcp(port: number): Promise<void> {
  const server = createTcpServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolveListen) =>
    server.listen(port, "127.0.0.1", () => resolveListen()),
  );
}

function collect(): { events: GateEvent[]; ctx: Pick<GateContext, "onEvent"> } {
  const events: GateEvent[] = [];
  return { events, ctx: { onEvent: (event) => events.push(event) } };
}

describe("gate schema", () => {
  it("accepts every probe kind and rejects zero or several kinds", () => {
    for (const gate of [
      { tcp: "localhost:27017" },
      { tcp: { host: "::1", port: 5432 } },
      { http: "http://localhost:8080/health" },
      {
        http: {
          url: "http://localhost:9200/_cluster/health",
          status: ["2xx", 401],
          json: {
            status: { in: ["yellow", "green"] },
            "nodes.length": { gte: 1 },
          },
          auth: { basic: "${secrets.ES_USER}:${secrets.ES_PASS}" },
        },
        stable: 2,
        every: "500ms",
        timeout: "2m",
      },
      { command: { run: "pg_isready", exitCode: [0, 2] } },
      { all: ["mongo", { tcp: "localhost:5672" }] },
      { any: ["http://localhost:1/", "tcp://localhost:2"] },
    ]) {
      expect(GateNodeSchema.safeParse(gate).success, JSON.stringify(gate)).toBe(
        true,
      );
    }
    expect(GateNodeSchema.safeParse({ stable: 2 }).success).toBe(false);
    expect(
      GateNodeSchema.safeParse({ tcp: "a:1", http: "http://a/" }).success,
    ).toBe(false);
    expect(GateNodeSchema.safeParse({ tcp: "no-port" }).success).toBe(false);
    expect(
      GateNodeSchema.safeParse({ http: { url: "http://a/", status: "2x" } })
        .success,
    ).toBe(false);
  });

  it("reports unknown references and cycles in the registry", () => {
    const registry: Record<string, GateNode> = {
      a: { all: ["b", "http://localhost:1/"] },
      b: { gate: "a" },
      c: { any: ["missing"] },
    };
    const problems = gateRegistryProblems(registry);
    expect(problems).toContain('gate "c" references unknown gate "missing"');
    expect(problems.some((p) => p.startsWith("gate reference cycle:"))).toBe(
      true,
    );
    expect(GatesRegistrySchema.safeParse(registry).success).toBe(false);
    expect(
      GatesRegistrySchema.safeParse({ ok: { tcp: "localhost:1" } }).success,
    ).toBe(true);
  });

  it("parses durations and status matchers", () => {
    expect(durationMs("250ms")).toBe(250);
    expect(durationMs("2s")).toBe(2_000);
    expect(durationMs("1.5m")).toBe(90_000);
    expect(durationMs(0)).toBe(0);
    expect(statusMatches(204)).toBe(true);
    expect(statusMatches(302)).toBe(true);
    expect(statusMatches(503)).toBe(false);
    expect(statusMatches(401, ["2xx", 401])).toBe(true);
    expect(statusMatches(404, "400-403")).toBe(false);
  });

  it("wires gates into the config: registry, docker.ready, readyOn.gate, after, webServer.ready", () => {
    const config = ConfigSchema.parse({
      version: 1,
      environments: { local: {} },
      gates: {
        mongo: { tcp: "localhost:27017", stable: 3 },
        api: { http: { url: "http://localhost:8080/ready", status: "2xx" } },
      },
      webServer: {
        command: "bun run dev",
        url: "http://localhost:3000",
        anyResponse: true,
        ready: ["api"],
      },
      services: {
        docker: { command: "docker compose up -d", ready: ["mongo"] },
        tmux: {
          session: "demo",
          windows: [
            {
              name: "worker",
              command: "bun run worker",
              after: "mongo",
              readyOn: { gate: "api" },
            },
            {
              name: "web",
              command: "bun run web",
              readyOn: { url: "http://localhost:8080", anyResponse: true },
            },
          ],
        },
      },
    });
    expect(config.gates?.mongo?.stable).toBe(3);
    expect(
      ConfigSchema.safeParse({
        version: 1,
        environments: {},
        services: {
          tmux: {
            session: "s",
            windows: [{ name: "w", command: "x", readyOn: {} }],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown gate names in services, webServer and environments", () => {
    const parsed = ConfigSchema.safeParse({
      version: 1,
      gates: { api: { tcp: "127.0.0.1:9" } },
      environments: {
        local: {
          services: { docker: { command: "true", ready: ["api", "apii"] } },
        },
      },
      webServer: {
        command: "true",
        url: "http://localhost:3000",
        ready: { all: ["api", "http://localhost:3000/ok", "nope"] },
      },
      services: {
        tmux: {
          session: "s",
          windows: [
            { name: "w", command: "x", after: "db", readyOn: { gate: "api" } },
          ],
        },
      },
    });
    expect(parsed.success).toBe(false);
    const issues = parsed.error!.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    expect(issues).toEqual([
      'webServer.ready: unknown gate "nope" (defined: api)',
      'services.tmux.windows.0.after: unknown gate "db" (defined: api)',
      'environments.local.services.docker.ready: unknown gate "apii" (defined: api)',
    ]);
  });
});

describe("probe helpers", () => {
  it("reads dotted JSON paths and explains mismatches", () => {
    const body = { status: "red", nodes: [{ id: 1 }], checks: { db: "ok" } };
    expect(readJsonPath(body, "checks.db")).toEqual({
      found: true,
      value: "ok",
    });
    expect(readJsonPath(body, "$.nodes.length")).toEqual({
      found: true,
      value: 1,
    });
    expect(readJsonPath(body, "nodes.0.id").value).toBe(1);
    expect(readJsonPath(body, "nope.x").found).toBe(false);
    expect(
      jsonMismatch({ in: ["yellow", "green"] }, readJsonPath(body, "status")),
    ).toContain('got "red"');
    expect(jsonMismatch(200, { found: true, value: "200" })).toBeUndefined();
    expect(jsonMismatch({ gte: 2 }, readJsonPath(body, "nodes.length"))).toBe(
      "got 1 (want >= 2)",
    );
    expect(jsonMismatch({ exists: false }, { found: false })).toBeUndefined();
    expect(jsonMismatch({ matches: "^o" }, { found: true, value: "ok" })).toBe(
      undefined,
    );
  });

  it("resolves ${env.X} / ${secrets.X} and names what is missing", () => {
    expect(
      resolveSecretRefs("${secrets.U}:${env.P:-dflt}", { U: "user" }),
    ).toEqual({ value: "user:dflt", missing: [] });
    expect(resolveSecretRefs("${secrets.NOPE}", {})).toEqual({
      value: "",
      missing: ["NOPE"],
    });
  });
});

describe("waitForGate", () => {
  it("waits through 503s until a 2xx answer (the readiness default)", async () => {
    const server = await sequenceServer([
      { status: 503 },
      { status: 503 },
      { status: 200 },
    ]);
    const { events, ctx } = collect();
    const result = await waitForGate(`${server.url}/health`, {
      ...ctx,
      scope: "test",
      defaultEveryMs: 20,
    });
    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(result.lastDetail).toContain("→ 200");
    expect(events.map((e) => e.type)).toEqual([
      "gate.started",
      "gate.attempt",
      "gate.attempt",
      "gate.passed",
    ]);
    // Identical consecutive 503 attempts are coalesced.
    expect(events[1]).toMatchObject({ ok: false, attempt: 1 });
    expect((events[1] as { detail: string }).detail).toContain(
      "→ 503 (want 2xx|3xx)",
    );
    for (const event of events) RunEventSchema.parse(event);
  });

  it("needs `stable` consecutive passes and restarts the streak on a failure", async () => {
    const server = await sequenceServer([
      { status: 200 },
      { status: 503 },
      { status: 200 },
      { status: 200 },
      { status: 200 },
    ]);
    const result = await waitForGate(
      { http: `${server.url}/`, stable: 3, every: 10 },
      {},
    );
    expect(result).toMatchObject({ ok: true, attempts: 5 });
    expect(server.hits()).toBe(5);
  });

  it("matches JSON bodies and accepts a custom status set", async () => {
    const server = await sequenceServer([
      { status: 200, body: { status: "red" } },
      { status: 401, body: { status: "yellow" } },
    ]);
    const result = await waitForGate(
      {
        http: {
          url: `${server.url}/_cluster/health`,
          status: ["2xx", 401],
          json: { status: { in: ["yellow", "green"] } },
        },
        every: 10,
      },
      {},
    );
    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  it("sends basic auth from ${secrets.X} and never reports the credentials", async () => {
    const seen: Array<{ authorization?: string }> = [];
    const server = await sequenceServer([{ status: 200 }], seen);
    const result = await waitForGate(
      {
        http: {
          url: `${server.url}/api`,
          auth: { basic: "${secrets.API_USER}:${secrets.API_PASS}" },
        },
      },
      { env: { API_USER: "demo", API_PASS: "s3cr3t-value" } },
    );
    expect(result.ok).toBe(true);
    expect(seen[0]?.authorization).toBe(
      `Basic ${Buffer.from("demo:s3cr3t-value").toString("base64")}`,
    );
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
    const missing = await waitForGate(
      {
        http: {
          url: `${server.url}/api`,
          auth: { bearer: "${secrets.TOKEN}" },
        },
        timeout: 50,
        every: 10,
      },
      { env: {} },
    );
    expect(missing.ok).toBe(false);
    expect(missing.lastDetail).toContain("TOKEN not set");
  });

  it("names an empty credential (an unset ${env.X} at config load) on a 401", async () => {
    // `basic: "ops:${env.UNSET}"` reaches the gate as "ops:"; a bearer
    // `${env.UNSET}` as "". Both parse, and the 401 says why.
    expect(
      GateNodeSchema.safeParse({
        http: { url: "http://127.0.0.1:1/", auth: { bearer: "" } },
      }).success,
    ).toBe(true);
    const server = await sequenceServer([{ status: 401 }]);
    const result = await waitForGate(
      {
        http: { url: `${server.url}/api`, auth: { basic: "ops:" } },
        timeout: 50,
        every: 10,
      },
      { env: {} },
    );
    expect(result.ok).toBe(false);
    expect(result.lastDetail).toContain("→ 401");
    expect(result.lastDetail).toContain("the basic-auth password is empty");
    expect(result.lastDetail).toContain("${secrets.X}");
  });

  it("waits for a TCP port that opens late", async () => {
    const port = await freePort();
    const opening = setTimeout(() => void listenTcp(port), 150);
    const result = await waitForGate(`tcp://127.0.0.1:${port}`, {
      defaultEveryMs: 25,
    });
    clearTimeout(opening);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.lastDetail).toBe(`tcp 127.0.0.1:${port} open`);
  });

  it("times out with the last detail and a timedOut flag", async () => {
    const port = await freePort();
    const { events, ctx } = collect();
    const startedAt = Date.now();
    const result = await waitForGate(
      { tcp: `127.0.0.1:${port}`, timeout: "300ms", every: "50ms" },
      ctx,
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result).toMatchObject({ ok: false, timedOut: true, budgetMs: 300 });
    expect(result.attempts).toBeGreaterThanOrEqual(3);
    expect(result.lastDetail).toContain("ECONNREFUSED");
    expect(events.at(-1)).toMatchObject({
      type: "gate.failed",
      timedOut: true,
    });
  });

  it("composes all/any and reports the failing children", async () => {
    const up = await sequenceServer([{ status: 200 }]);
    const down = await freePort();
    const any = await waitForGate(
      { any: [`tcp://127.0.0.1:${down}`, `${up.url}/`] },
      {},
    );
    expect(any.ok).toBe(true);
    const all = await waitForGate(
      {
        all: [`${up.url}/`, `tcp://127.0.0.1:${down}`],
        timeout: 100,
        every: 20,
      },
      {},
    );
    expect(all.ok).toBe(false);
    expect(all.lastDetail).toMatch(
      /^1\/2 not ready: tcp 127\.0\.0\.1:\d+: ECONNREFUSED/,
    );
  });

  it("resolves registry names, nested references and per-child stability", async () => {
    const server = await sequenceServer([{ status: 200 }]);
    const port = await freePort();
    await listenTcp(port);
    const registry: Record<string, GateNode> = {
      api: { http: `${server.url}/ready`, stable: 2 },
      db: { tcp: `127.0.0.1:${port}` },
      stack: { all: ["api", "db"], every: 10 },
    };
    const result = await waitForGate("stack", { registry });
    // `api` only counts from its second consecutive pass.
    expect(result).toMatchObject({ ok: true, attempts: 2, name: "stack" });
    await expect(
      waitForGates(["stack", "nope"], { registry }),
    ).rejects.toBeInstanceOf(GateReferenceError);
    expect(() => assertGateRefs(["stack"], { registry })).not.toThrow();
    expect(() =>
      assertGateRefs(["loop"], { registry: { loop: { gate: "loop" } } }),
    ).toThrow(/cycle/);
  });

  it("runs command probes with accepted exit codes and kills a hung command's process tree", async () => {
    const ok = await waitForGate(
      { command: { run: "exit 3", exitCode: [0, 3] } },
      {},
    );
    expect(ok.ok).toBe(true);
    const pidFile = join(dir, "sleeper.pid");
    const startedAt = Date.now();
    const hung = await waitForGate(
      {
        command: {
          run: `sleep 30 & echo $! > "${pidFile}"; wait`,
          timeoutMs: 300,
        },
        timeout: 400,
        every: 10,
      },
      { cwd: dir },
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(hung.ok).toBe(false);
    expect(hung.lastDetail).toMatch(/timed out after \d+ms/);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it("stops on cancel and reports cancelled", async () => {
    const port = await freePort();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const startedAt = Date.now();
    const result = await waitForGate(
      { tcp: `127.0.0.1:${port}`, timeout: "30s", every: "5s" },
      { signal: controller.signal },
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result).toMatchObject({ ok: false, cancelled: true });
  });

  it("checkGateOnce takes one look and ignores stability", async () => {
    const server = await sequenceServer([{ status: 200 }]);
    const look = await checkGateOnce({ http: `${server.url}/`, stable: 5 }, {});
    expect(look.ok).toBe(true);
    expect(server.hits()).toBe(1);
  });

  it("checkGateOnce ignores a nested gate's stable too (composed liveness)", async () => {
    const registry: Record<string, GateNode> = {
      api: { command: "exit 0", stable: 3 },
      stack: { all: ["api", { command: "exit 0" }] },
    };
    const look = await checkGateOnce("stack", { registry, cwd: dir });
    expect(look).toMatchObject({ ok: true, name: "stack" });
  });

  it("counts a gate reached twice in one tree once per attempt (diamond)", async () => {
    const server = await sequenceServer([{ status: 200 }]);
    const registry: Record<string, GateNode> = {
      api: { http: `${server.url}/ready`, stable: 4 },
      stack: { all: ["api", { http: `${server.url}/other` }] },
      full: { all: ["stack", "api"], every: 10 },
    };
    const result = await waitForGate("full", { registry });
    expect(result).toMatchObject({ ok: true, attempts: 4 });
  });

  it("settles a command probe on the shell's exit even when a background process holds stdout", async () => {
    const pidFile = join(dir, "bg.pid");
    const startedAt = Date.now();
    const result = await waitForGate(
      {
        command: { run: `sleep 30 & echo $! > "${pidFile}"; exit 1` },
        timeout: 300,
        every: 50,
      },
      { cwd: dir },
    );
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.ok).toBe(false);
    expect(result.lastDetail).toMatch(/exit 1$/);
    // The probe's process group is killed once the shell exits.
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it("accepts any answer for URL refs with anyResponse (legacy readiness)", async () => {
    const server = await sequenceServer([{ status: 503 }]);
    const result = await waitForGate(`${server.url}/`, { anyResponse: true });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
  });
});
