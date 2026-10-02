import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunEventSchema, type GateEvent } from "../schema/events.v1";
import {
  checkServicesLive,
  ServicesCancelledError,
  ServicesError,
  startServices,
  type ServicesEvent,
} from "./services";

/**
 * F2 gates in the services lifecycle, unmocked: `docker.ready` waits real
 * HTTP/TCP listeners after the start command (a non-Compose command, so no
 * docker is needed), reports gate.* plus services.docker.readiness-check,
 * and the reuse liveness check looks at the same gates once.
 */

let dir: string;
const servers: Array<Server | ReturnType<typeof createNetServer>> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-services-gates-"));
});

afterEach(async () => {
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

async function sequenceServer(statuses: number[]): Promise<string> {
  let hits = 0;
  const server = createServer((_req, res) => {
    res.statusCode = statuses[Math.min(hits, statuses.length - 1)]!;
    hits += 1;
    res.end("x");
  });
  servers.push(server);
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("services docker.ready gates", () => {
  it("waits named and inline gates after the start command", async () => {
    const url = await sequenceServer([503, 503, 200]);
    const tcpPort = await freePort();
    setTimeout(() => {
      const tcp = createNetServer((socket) => socket.end());
      servers.push(tcp);
      tcp.listen(tcpPort, "127.0.0.1");
    }, 200);
    const gateEvents: GateEvent[] = [];
    const servicesEvents: ServicesEvent[] = [];
    const handle = await startServices(
      {
        docker: {
          command: "true",
          readyTimeoutMs: 10_000,
          ready: [
            "api",
            { tcp: `127.0.0.1:${tcpPort}`, name: "broker", every: 50 },
          ],
        },
      },
      {
        configDir: dir,
        project: "gates-test",
        gates: { api: { http: `${url}/ready`, every: "50ms", stable: 1 } },
        onGateEvent: (event) => gateEvents.push(event),
        onEvent: (event) => servicesEvents.push(event),
      },
    );
    try {
      expect(
        gateEvents.filter((e) => e.type === "gate.passed").map((e) => e.name),
      ).toEqual(["api", "broker"]);
      expect(gateEvents.every((e) => e.scope === "services.docker")).toBe(true);
      for (const event of gateEvents) RunEventSchema.parse(event);
      expect(
        servicesEvents
          .filter((e) => e.event === "readiness-check")
          .map((e) => e.data?.gate),
      ).toEqual(["api", "broker"]);
      expect(servicesEvents.at(-1)).toMatchObject({ event: "ready" });
    } finally {
      await handle.stop();
    }
  }, 20_000);

  it("fails the boot with the gate's last detail", async () => {
    const closed = await freePort();
    const failure = await startServices(
      {
        docker: {
          command: "true",
          ready: {
            tcp: `127.0.0.1:${closed}`,
            timeout: "300ms",
            every: "50ms",
          },
        },
      },
      { configDir: dir, project: "gates-test" },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServicesError);
    expect((failure as Error).message).toMatch(
      /^docker: gate "tcp 127\.0\.0\.1:\d+" not ready within 300ms after \d+ attempt\(s\): .*ECONNREFUSED/,
    );
  }, 20_000);

  it("names an unknown gate and stops on cancel", async () => {
    await expect(
      startServices(
        { docker: { command: "true", ready: ["nope"] } },
        { configDir: dir, project: "gates-test", gates: {} },
      ),
    ).rejects.toThrow(/docker: unknown gate "nope"/);
    const closed = await freePort();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await expect(
      startServices(
        {
          docker: {
            command: "true",
            ready: { tcp: `127.0.0.1:${closed}`, timeout: "30s" },
          },
        },
        { configDir: dir, project: "gates-test", signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(ServicesCancelledError);
  }, 20_000);

  it("resolves names from the config in configDir when the caller passes no registry", async () => {
    const url = await sequenceServer([503, 200]);
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
environments:
  local: {}
gates:
  api:
    http: "${url}/ready"
    every: 20ms
`,
    );
    const gateEvents: GateEvent[] = [];
    const handle = await startServices(
      { docker: { command: "true", ready: "api" } },
      {
        configDir: dir,
        project: "gates-test",
        onGateEvent: (event) => gateEvents.push(event),
      },
    );
    await handle.stop();
    expect(gateEvents.at(-1)).toMatchObject({
      type: "gate.passed",
      name: "api",
      attempts: 2,
    });
  });

  it("checkServicesLive looks at the docker gates once", async () => {
    const url = await sequenceServer([200]);
    const closed = await freePort();
    const live = await checkServicesLive(
      {
        docker: {
          command: "true",
          readinessCheck: "true",
          ready: ["api", { tcp: `127.0.0.1:${closed}`, name: "db" }],
        },
      },
      { configDir: dir, gates: { api: { http: `${url}/` } } },
    );
    expect(live.live).toBe(false);
    expect(live.problems).toEqual([
      expect.stringMatching(
        /^docker gate db is not ready \(tcp 127\.0\.0\.1:\d+: ECONNREFUSED\)$/,
      ),
    ]);
  });
});
