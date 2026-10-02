import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GateEvent } from "../schema/events.v1";
import {
  probeReady,
  startWebServer,
  warnLegacyReadiness,
  WebServerError,
  type WebServerHandle,
} from "./webServer";

/**
 * F2 readiness: `webServer.url` needs a 2xx/3xx answer (a 503 used to count),
 * `anyResponse: true` keeps the old rule, a one-time warning names the change,
 * and `ready` gates run after the url — for spawned and reused servers.
 */

let dir: string;
const handles: WebServerHandle[] = [];
const servers: Server[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-ws-ready-"));
});

afterEach(async () => {
  for (const handle of handles.splice(0))
    await handle.stop().catch(() => undefined);
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }
  await rm(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolvePort(port));
    });
  });
}

/** In-process server answering `statuses[i]` for the i-th request. */
async function sequenceServer(port: number, statuses: number[]): Promise<void> {
  let hits = 0;
  const server = createServer((_req, res) => {
    res.statusCode = statuses[Math.min(hits, statuses.length - 1)]!;
    hits += 1;
    res.end("x");
  });
  servers.push(server);
  await new Promise<void>((resolveListen) =>
    server.listen(port, "127.0.0.1", () => resolveListen()),
  );
}

/** A spawned server that answers 503 for its first `warmup` requests. */
async function warmupServerScript(): Promise<string> {
  const path = join(dir, "warmup.cjs");
  await writeFile(
    path,
    `const http = require("node:http");
let hits = 0;
const warmup = Number(process.env.WARMUP || 0);
http.createServer((req, res) => { hits += 1; res.writeHead(hits <= warmup ? 503 : 200); res.end("x"); })
  .listen(Number(process.env.PORT), "127.0.0.1");
`,
  );
  return path;
}

describe("webServer readiness (2xx/3xx)", () => {
  it("probeReady needs 2xx/3xx unless anyResponse", async () => {
    const port = await freePort();
    await sequenceServer(port, [503]);
    const url = `http://127.0.0.1:${port}/`;
    expect(await probeReady(url)).toMatchObject({ ready: false, status: 503 });
    expect(await probeReady(url, { anyResponse: true })).toMatchObject({
      ready: true,
      status: 503,
    });
    const closed = await freePort();
    expect(await probeReady(`http://127.0.0.1:${closed}/`)).toMatchObject({
      ready: false,
    });
    expect(
      (await probeReady(`http://127.0.0.1:${closed}/`)).status,
    ).toBeUndefined();
  });

  it("warns once per URL, only when one non-ready status persists", () => {
    const warnings: string[] = [];
    const push = (m: string): void => {
      warnings.push(m);
    };
    const url = `http://127.0.0.1:1/once-${Date.now()}`;
    const t0 = 1_000_000;
    // Warming up: 503 for 4s, then a different status — no warning.
    warnLegacyReadiness(url, 503, push, { now: t0 });
    warnLegacyReadiness(url, 503, push, { now: t0 + 4_000 });
    warnLegacyReadiness(url, 401, push, { now: t0 + 4_500 });
    expect(warnings).toEqual([]);
    // 401 for 10s in a row: one warning, never repeated.
    for (let ms = 5_000; ms <= 15_000; ms += 1_000) {
      warnLegacyReadiness(url, 401, push, { now: t0 + ms });
    }
    warnLegacyReadiness(url, 401, push, { now: t0 + 30_000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/has answered 401 for 1\d+s/);
    expect(warnings[0]).toContain("anyResponse: true");
    expect(warnings[0]).not.toContain("cairntrace 2.");
    // A gap between answers (another wait later) starts a new streak.
    const other = `${url}-gap`;
    warnLegacyReadiness(other, 503, push, { now: t0 });
    warnLegacyReadiness(other, 503, push, { now: t0 + 9_000 });
    warnLegacyReadiness(other, 503, push, { now: t0 + 20_000 });
    expect(warnings).toHaveLength(1);
  });

  it("keeps waiting while a spawned server answers 503, then becomes ready", async () => {
    const port = await freePort();
    const script = await warmupServerScript();
    const warnings: string[] = [];
    const handle = await startWebServer(
      {
        command: `node "${script}"`,
        url: `http://127.0.0.1:${port}/`,
        env: { PORT: String(port), WARMUP: "3" },
        readyTimeoutMs: 15_000,
      },
      {
        configDir: dir,
        artifactRoot: dir,
        coldStart: true,
        warn: (m) => warnings.push(m),
      },
    );
    handles.push(handle);
    expect(handle.startedByUs).toBe(true);
    // A short warm-up is not worth a warning.
    expect(warnings).toEqual([]);
    expect((await probeReady(`http://127.0.0.1:${port}/`)).ready).toBe(true);
  }, 30_000);

  it("times out on a server stuck at 503 and says how to keep the old rule", async () => {
    const port = await freePort();
    const script = await warmupServerScript();
    await expect(
      startWebServer(
        {
          command: `node "${script}"`,
          url: `http://127.0.0.1:${port}/`,
          env: { PORT: String(port), WARMUP: "100000" },
          readyTimeoutMs: 1_500,
        },
        {
          configDir: dir,
          artifactRoot: dir,
          coldStart: true,
          warn: () => undefined,
        },
      ),
    ).rejects.toThrow(
      /→ 503 \(want 2xx\|3xx\).*set anyResponse: true to accept 503/s,
    );
  }, 30_000);

  it("accepts the 503 with anyResponse: true", async () => {
    const port = await freePort();
    const script = await warmupServerScript();
    const handle = await startWebServer(
      {
        command: `node "${script}"`,
        url: `http://127.0.0.1:${port}/`,
        anyResponse: true,
        env: { PORT: String(port), WARMUP: "100000" },
        readyTimeoutMs: 10_000,
      },
      { configDir: dir, artifactRoot: dir, coldStart: true },
    );
    handles.push(handle);
    expect(handle.startedByUs).toBe(true);
  }, 30_000);

  it("waits the ready gates after the url, reporting gate events", async () => {
    const port = await freePort();
    const gatePort = await freePort();
    const script = await warmupServerScript();
    // The dependency the gate waits for opens a little after the server.
    setTimeout(() => void sequenceServer(gatePort, [503, 200]), 300);
    const events: GateEvent[] = [];
    const handle = await startWebServer(
      {
        command: `node "${script}"`,
        url: `http://127.0.0.1:${port}/`,
        env: { PORT: String(port) },
        readyTimeoutMs: 15_000,
        ready: ["api"],
      },
      {
        configDir: dir,
        artifactRoot: dir,
        coldStart: true,
        gates: {
          api: { http: `http://127.0.0.1:${gatePort}/ready`, every: "50ms" },
        },
        onGateEvent: (event) => events.push(event),
      },
    );
    handles.push(handle);
    expect(events[0]).toMatchObject({
      type: "gate.started",
      scope: "webServer",
    });
    expect(events.at(-1)).toMatchObject({ type: "gate.passed", name: "api" });
  }, 30_000);

  it("fails a reused server that is listening but never ready", async () => {
    const port = await freePort();
    await sequenceServer(port, [503]);
    await expect(
      startWebServer(
        {
          command: "true",
          url: `http://127.0.0.1:${port}/`,
          reuseExisting: true,
          readyTimeoutMs: 600,
        },
        { configDir: dir, artifactRoot: dir, warn: () => undefined },
      ),
    ).rejects.toBeInstanceOf(WebServerError);
    const port2 = await freePort();
    await sequenceServer(port2, [503, 200]);
    const reused = await startWebServer(
      {
        command: "true",
        url: `http://127.0.0.1:${port2}/`,
        reuseExisting: true,
        readyTimeoutMs: 5_000,
      },
      { configDir: dir, artifactRoot: dir, warn: () => undefined },
    );
    expect(reused.startedByUs).toBe(false);
  }, 30_000);
});
