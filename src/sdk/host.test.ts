import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { EnvironmentDatasourceSet } from "../core/datasources";
import { createSdkDatasourceHost, startVerifierChannel } from "./host";

function set(datasources: Record<string, unknown>): EnvironmentDatasourceSet {
  return {
    datasources: datasources as EnvironmentDatasourceSet["datasources"],
    disabled: ["legacy"],
    errors: { broken: "database: Required" },
  };
}

const fakeDriver = () => {
  class MongoClient {
    async connect() {}
    db() {
      return {
        command: async () => ({ ok: 1 }),
        collection: () => ({
          find: () => ({ toArray: async () => [{ n: 1 }, { n: 2 }] }),
          countDocuments: async () => 2,
          insertOne: async () => ({ acknowledged: true }),
        }),
      };
    }
    async close() {}
  }
  return async () => ({ MongoClient }) as never;
};

describe("createSdkDatasourceHost", () => {
  const host = createSdkDatasourceHost(
    set({
      db: {
        kind: "mongo",
        uri: "mongodb://127.0.0.1:27017/app",
        database: "app",
        transport: "driver",
        mode: "read-only",
      },
    }),
    { loadMongoDriver: fakeDriver() },
  );

  it("lists names and kinds only", () => {
    expect(host.list()).toEqual([
      { name: "db", kind: "mongo" },
      { name: "broken" },
      { name: "legacy" },
    ]);
    expect(JSON.stringify(host.list())).not.toContain("mongodb://");
  });

  it("maps the mongo surface and keeps read-only and unknown names fatal", async () => {
    expect(await host.call("db", "find", ["orders", {}], {})).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
    expect(await host.call("db", "findOne", ["orders"], {})).toEqual({ n: 1 });
    expect(await host.call("db", "count", ["orders", {}], {})).toBe(2);
    await expect(
      host.call(
        "db",
        "write",
        [{ op: "insertOne", collection: "orders", document: { n: 3 } }],
        {},
      ),
    ).rejects.toThrow(/read-only/);
    await expect(host.call("db", "close", [], {})).rejects.toThrow(
      /no method "close"/,
    );
    await expect(host.call("nope", "find", ["x"], {})).rejects.toThrow(
      /unknown datasource "nope"/,
    );
    await expect(host.call("broken", "find", ["x"], {})).rejects.toThrow(
      /broken is invalid/,
    );
    await expect(host.call("legacy", "find", ["x"], {})).rejects.toThrow(
      /legacy is disabled/,
    );
    await host.close();
  });
});

async function recordingServer(): Promise<{
  url: string;
  seen: Array<{ url?: string; headers: IncomingHttpHeaders }>;
  close(): Promise<void>;
}> {
  const seen: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("createSdkDatasourceHost: http credentials stay on baseUrl's origin", () => {
  it("refuses an absolute path to another host and keeps relative paths on baseUrl", async () => {
    const api = await recordingServer();
    const sink = await recordingServer();
    const host = createSdkDatasourceHost(
      set({
        api: { kind: "http", baseUrl: api.url, auth: { bearer: "TOPSECRET" } },
      }),
    );
    try {
      // A link the app handed back (`${requests.x.body.links.self}`).
      for (const call of [
        host.call("api", "get", [`${sink.url}/collect`], {}),
        host.call("api", "post", [`${sink.url}/collect`, { a: 1 }], {}),
        host.call("api", "request", [{ path: `${sink.url}/collect` }], {}),
      ]) {
        await expect(call).rejects.toThrow(
          /refused a call to http:\/\/127\.0\.0\.1:\d+ — an absolute URL must stay on baseUrl's origin/,
        );
      }
      // Protocol-relative and same-origin absolute paths stay on baseUrl.
      await host.call("api", "get", [`//127.0.0.1:1/collect`], {});
      await host.call("api", "get", [`${api.url}/ok`], {});
      expect(sink.seen).toEqual([]);
      expect(api.seen.map((r) => r.url)).toEqual([
        "/127.0.0.1:1/collect",
        "/ok",
      ]);
      expect(api.seen[0]!.headers.authorization).toBe("Bearer TOPSECRET");
    } finally {
      await host.close();
      await api.close();
      await sink.close();
    }
  });
});

describe("startVerifierChannel", () => {
  it("serves loopback calls with the bearer token only", async () => {
    const calls: string[] = [];
    const channel = await startVerifierChannel(
      {
        list: () => [{ name: "api", kind: "http" }],
        call: async (name, method, args) => {
          if (method === "boom") throw new Error("upstream said no");
          return { name, method, args };
        },
      },
      { onCall: (c) => calls.push(`${c.name}.${c.method}:${c.ok}`) },
    );
    try {
      expect(channel.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/rpc$/);
      const post = (body: unknown, token = channel.token) =>
        fetch(channel.url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      const ok = await post({
        op: "datasource",
        name: "api",
        method: "get",
        args: ["/x"],
      });
      expect(await ok.json()).toEqual({
        ok: true,
        value: { name: "api", method: "get", args: ["/x"] },
      });
      const failed = await post({
        op: "datasource",
        name: "api",
        method: "boom",
        args: [],
      });
      expect(await failed.json()).toEqual({
        ok: false,
        error: { message: "upstream said no" },
      });
      const forbidden = await post(
        { op: "datasource", name: "api", method: "get" },
        "wrong",
      );
      expect(forbidden.status).toBe(403);
      expect(calls).toEqual(["api.get:true", "api.boom:false"]);
    } finally {
      await channel.close();
    }
  });
});
