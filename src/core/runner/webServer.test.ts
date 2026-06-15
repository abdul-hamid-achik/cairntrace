import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  startWebServer,
  WebServerError,
  type WebServerHandle,
} from "./webServer";

/**
 * These exercise the node-spawn fallback (vitest runs under node, where `Bun`
 * is undefined). The Bun.spawn/Bun.$ paths share all readiness, log-capture,
 * and teardown logic with this one and are covered by the demo-app smoke test
 * that runs the real `bin/cairn` under Bun.
 */

let dir: string;
let fixtureServerPath: string;

const startedHandles: WebServerHandle[] = [];
const openServers: Server[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-webserver-test-"));
  // A tiny HTTP server that binds $PORT and announces readiness on stdout.
  fixtureServerPath = join(dir, "fixture-server.cjs");
  await writeFile(
    fixtureServerPath,
    `const http = require("node:http");
const port = Number(process.env.PORT || 0);
const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
server.listen(port, "127.0.0.1", () => { console.log("FIXTURE_READY on " + port); });
`,
  );
});

afterEach(async () => {
  while (startedHandles.length > 0) {
    const h = startedHandles.pop();
    await h?.stop().catch(() => undefined);
  }
  while (openServers.length > 0) {
    const s = openServers.pop();
    await new Promise<void>((res) => s?.close(() => res()));
  }
});

function track(h: WebServerHandle): WebServerHandle {
  startedHandles.push(h);
  return h;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => res(port));
    });
  });
}

function listenOn(port: number): Promise<Server> {
  return new Promise((res, rej) => {
    const server = createServer((_req, r) => {
      r.writeHead(200);
      r.end("reused");
    });
    server.on("error", rej);
    server.listen(port, "127.0.0.1", () => {
      openServers.push(server);
      res(server);
    });
  });
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    void res.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

describe("startWebServer — cold boot", () => {
  it("boots, becomes ready on the url probe, captures a log, then tears down the tree", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const handle = track(
      await startWebServer(
        {
          command: `node ${fixtureServerPath}`,
          url,
          env: { PORT: String(port) },
          readyTimeoutMs: 10000,
        },
        { configDir: dir, artifactRoot: dir, coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(true);
    expect(await isUp(url)).toBe(true);

    expect(handle.logPath).toBeDefined();
    const log = await readFile(handle.logPath as string, "utf8");
    expect(log).toContain("FIXTURE_READY");

    await handle.stop();
    expect(await isUp(url)).toBe(false);
  }, 20000);

  it("runs setup after ready and teardown on stop, in order", async () => {
    const port = await freePort();
    const marker = join(dir, `lifecycle-${port}.log`);
    const handle = track(
      await startWebServer(
        {
          command: `node ${fixtureServerPath}`,
          url: `http://127.0.0.1:${port}`,
          env: { PORT: String(port) },
          setup: [`printf 'setup\\n' >> ${marker}`],
          teardown: [`printf 'teardown\\n' >> ${marker}`],
          readyTimeoutMs: 10000,
        },
        { configDir: dir, artifactRoot: dir, coldStart: false },
      ),
    );

    expect(await readFile(marker, "utf8")).toBe("setup\n");
    await handle.stop();
    expect(await readFile(marker, "utf8")).toBe("setup\nteardown\n");
  }, 20000);

  it("becomes ready on a waitForText match with no url", async () => {
    const handle = track(
      await startWebServer(
        {
          command: "printf 'TEXT_READY\\n'; sleep 30",
          waitForText: "TEXT_READY",
          readyTimeoutMs: 10000,
        },
        { configDir: dir, artifactRoot: dir, coldStart: false },
      ),
    );
    expect(handle.startedByUs).toBe(true);
    await handle.stop();
  }, 20000);

  it("ignores baseUrl for readiness when waitForText is the configured signal", async () => {
    // A baseUrl is present but nothing listens on it; readiness must succeed on
    // the text match alone, NOT hang waiting to also probe the unreachable url.
    const deadPort = await freePort();
    const handle = track(
      await startWebServer(
        {
          command: "printf 'TEXT_READY\\n'; sleep 30",
          waitForText: "TEXT_READY",
          readyTimeoutMs: 4000,
        },
        {
          configDir: dir,
          artifactRoot: dir,
          coldStart: false,
          baseUrl: `http://127.0.0.1:${deadPort}`,
        },
      ),
    );
    expect(handle.startedByUs).toBe(true);
    await handle.stop();
  }, 20000);

  it("onSpawn hands back a synchronous teardown that kills the tree mid-life", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    let earlyTerminate: (() => void) | undefined;
    const handle = await startWebServer(
      {
        command: `node ${fixtureServerPath}`,
        url,
        env: { PORT: String(port) },
        readyTimeoutMs: 10000,
      },
      {
        configDir: dir,
        artifactRoot: dir,
        coldStart: false,
        onSpawn: (t) => {
          earlyTerminate = t;
        },
      },
    );
    expect(typeof earlyTerminate).toBe("function");
    expect(await isUp(url)).toBe(true);
    // The signal-path teardown (synchronous) must take the server down.
    earlyTerminate?.();
    expect(await isUp(url)).toBe(false);
    await handle.stop();
  }, 20000);
});

describe("startWebServer — reuse", () => {
  it("reuses a server already answering the url (no spawn, stop is a no-op)", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    await listenOn(port);

    const handle = await startWebServer(
      { command: "node /does/not/exist", url, reuseExisting: true },
      { configDir: dir, artifactRoot: dir, coldStart: false },
    );

    expect(handle.startedByUs).toBe(false);
    expect(handle.logPath).toBeUndefined();
    await handle.stop();
    // The pre-existing server cairn didn't start must still be up.
    expect(await isUp(url)).toBe(true);
  }, 20000);

  it("errors when a server is already listening but reuseExisting is false", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    await listenOn(port);

    await expect(
      startWebServer(
        { command: "node /does/not/exist", url, reuseExisting: false },
        { configDir: dir, artifactRoot: dir, coldStart: false },
      ),
    ).rejects.toThrow(/already listening/i);
  }, 20000);
});

describe("startWebServer — failure modes", () => {
  it("aborts before spawning when build exits non-zero", async () => {
    const port = await freePort();
    await expect(
      startWebServer(
        {
          build: "echo building && exit 3",
          command: `node ${fixtureServerPath}`,
          url: `http://127.0.0.1:${port}`,
          env: { PORT: String(port) },
        },
        { configDir: dir, artifactRoot: dir, coldStart: false },
      ),
    ).rejects.toThrow(/build failed \(exit 3\)/i);
  }, 20000);

  it("fails fast when the command crashes on boot", async () => {
    const port = await freePort();
    await expect(
      startWebServer(
        {
          command: "echo crashing; exit 1",
          url: `http://127.0.0.1:${port}`,
          readyTimeoutMs: 10000,
        },
        { configDir: dir, artifactRoot: dir, coldStart: false },
      ),
    ).rejects.toThrow(/exited \(code 1\)/i);
  }, 20000);

  it("times out and surfaces the log tail when readiness never arrives", async () => {
    const port = await freePort();
    let caught: unknown;
    try {
      await startWebServer(
        {
          command: "echo booting; sleep 30",
          url: `http://127.0.0.1:${port}`,
          readyTimeoutMs: 800,
        },
        { configDir: dir, artifactRoot: dir, coldStart: false },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WebServerError);
    expect((caught as Error).message).toMatch(/did not become ready/i);
    expect((caught as Error).message).toContain("booting");
  }, 20000);

  it("aborts but still tears down the server when a setup command fails", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    await expect(
      startWebServer(
        {
          command: `node ${fixtureServerPath}`,
          url,
          env: { PORT: String(port) },
          setup: ["exit 7"],
          readyTimeoutMs: 10000,
        },
        { configDir: dir, artifactRoot: dir, coldStart: false },
      ),
    ).rejects.toThrow(/setup command failed \(exit 7\)/i);
    // The server we started must have been torn down despite the setup failure.
    expect(await isUp(url)).toBe(false);
  }, 20000);
});
