import { describe, expect, it } from "vitest";
import {
  ConfigSchema,
  environmentDatasourceProblems,
} from "../schema/config.v1";
import { createDatasourceSession } from "./index";
import { ejsonToPlain } from "./ejson";
import { redactUri, scrubDatasourceText } from "./redact";
import {
  resolveDatasourcePlaceholders,
  resolveEnvironmentDatasources,
} from "./resolve";

const CONFIG = {
  version: 1,
  environments: {
    local: {
      datasources: {
        app: { docker: { service: "mongo" }, transport: "docker" },
      },
    },
    dev: {
      datasources: {
        app: { uri: "${secrets.DEV_MONGO_URI}" },
        temporal: false,
      },
    },
    broken: {
      datasources: { app: { kind: "http" } },
    },
  },
  datasources: {
    app: {
      kind: "mongo",
      uri: "mongodb://127.0.0.1:27017/shop",
      docker: { service: "mongo" },
      database: "shop",
      guard: { databases: ["shop"] },
    },
    temporal: {
      kind: "temporal",
      api: "http://127.0.0.1:8080",
      namespace: "default",
    },
    api: {
      kind: "http",
      baseUrl: "http://127.0.0.1:4000",
      headers: { "x-tenant": "demo" },
      auth: { bearer: "${secrets.API_TOKEN}" },
    },
  },
};

describe("config datasources", () => {
  it("validates the datasources block and per-environment overrides", () => {
    const parsed = ConfigSchema.safeParse(CONFIG);
    expect(parsed.success).toBe(true);
    const bad = ConfigSchema.safeParse({
      version: 1,
      environments: {},
      datasources: {
        app: { kind: "mongo", database: "shop" },
        both: {
          kind: "http",
          baseUrl: "http://x",
          auth: { basic: "a:b", bearer: "t" },
        },
        Upper: { kind: "http", baseUrl: "http://x" },
      },
    });
    expect(bad.success).toBe(false);
    const messages = bad.error!.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        "datasources.app.uri: a mongo datasource needs uri or docker",
        "datasources.both.auth: auth takes one of: basic, bearer",
      ]),
    );
    expect(messages.some((m) => m.startsWith("datasources.Upper"))).toBe(true);
  });

  it("merges environment overrides field by field, disables with false, reports broken merges", () => {
    const config = ConfigSchema.parse(CONFIG);
    const local = resolveEnvironmentDatasources(
      config.datasources,
      config.environments["local"]?.datasources,
    );
    expect(local.datasources["app"]).toMatchObject({
      kind: "mongo",
      transport: "docker",
      docker: { service: "mongo" },
      uri: "mongodb://127.0.0.1:27017/shop",
    });

    const dev = resolveEnvironmentDatasources(
      config.datasources,
      config.environments["dev"]?.datasources,
    );
    // A URI override drops the inherited docker transport.
    expect(dev.datasources["app"]).toEqual({
      kind: "mongo",
      uri: "${secrets.DEV_MONGO_URI}",
      database: "shop",
      guard: { databases: ["shop"] },
    });
    expect(dev.disabled).toEqual(["temporal"]);
    expect(dev.datasources["temporal"]).toBeUndefined();

    const broken = resolveEnvironmentDatasources(
      config.datasources,
      config.environments["broken"]?.datasources,
    );
    expect(broken.errors["app"]).toContain("baseUrl");
  });

  it("lists entries that only break after an environment merge (for config validate)", () => {
    expect(environmentDatasourceProblems(ConfigSchema.parse(CONFIG))).toEqual([
      expect.stringMatching(
        /^environments\.broken\.datasources\.app: .*baseUrl/,
      ),
    ]);
    const config = ConfigSchema.parse({
      version: 1,
      datasources: {
        app: { kind: "mongo", docker: { service: "mongo" }, database: "shop" },
      },
      environments: {
        local: {},
        dev: {
          datasources: {
            app: { transport: "driver" },
            ghost: { database: "x" },
          },
        },
      },
    });
    const problems = environmentDatasourceProblems(config);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^environments\.dev\.datasources\.app: .*transport driver needs uri/,
        ),
        expect.stringMatching(/^environments\.dev\.datasources\.ghost: /),
      ]),
    );
    expect(problems).toHaveLength(2);
  });

  it("resolves secrets/env/vars placeholders and refuses an unset secret", () => {
    const config = ConfigSchema.parse(CONFIG);
    const api = config.datasources!["api"]!;
    expect(
      resolveDatasourcePlaceholders("api", api, {
        env: { API_TOKEN: "tok-123" },
      }),
    ).toMatchObject({ auth: { bearer: "tok-123" } });
    expect(() =>
      resolveDatasourcePlaceholders("api", api, { env: {} }),
    ).toThrow(/datasource api: \$\{secrets\.API_TOKEN\} is not set/);
    expect(
      resolveDatasourcePlaceholders(
        "t",
        {
          kind: "temporal",
          api: "http://${vars.temporalHost}:${env.TEMPORAL_PORT:-8233}",
          namespace: "default",
        },
        { vars: { temporalHost: "127.0.0.1" }, env: {} },
      ).api,
    ).toBe("http://127.0.0.1:8233");
  });

  it("explains unknown, disabled, invalid and wrong-kind sources", async () => {
    const config = ConfigSchema.parse(CONFIG);
    const session = createDatasourceSession(
      resolveEnvironmentDatasources(
        config.datasources,
        config.environments["dev"]?.datasources,
      ),
      { envName: "dev", env: {} },
    );
    expect(() => session.temporal("temporal")).toThrow(
      'datasource temporal is disabled for environment "dev"',
    );
    expect(() => session.http("app")).toThrow(
      "datasource app is kind mongo; this needs kind http",
    );
    expect(() => session.http("nope")).toThrow(
      /unknown datasource "nope" for environment "dev"; config datasources: app, api/,
    );
    await expect(session.mongo("app")).rejects.toMatchObject({
      permanent: true,
    });
    await session.close();
  });
});

describe("datasource redaction", () => {
  it("masks credentials and drops the query of connection strings", () => {
    expect(
      redactUri(
        "mongodb://user:p%40ss@h1:27017,h2/db?authSource=admin&password=x",
      ),
    ).toBe("mongodb://***@h1:27017,h2/db");
    expect(redactUri("mongodb+srv://cluster0.example.net/db")).toBe(
      "mongodb+srv://cluster0.example.net/db",
    );
    expect(
      scrubDatasourceText(
        "MongoServerError: bad auth at mongodb://admin:hunter2@db.internal:27017/app?tls=true; token xyz-secret-1",
        ["xyz-secret-1"],
      ),
    ).toBe(
      "MongoServerError: bad auth at mongodb://***@db.internal:27017/app; token [redacted]",
    );
    expect(scrubDatasourceText('{"Authorization": "Basic b3BzOnBhNTU="}')).toBe(
      '{"Authorization": "Basic [redacted]"}',
    );
  });
});

describe("ejsonToPlain", () => {
  it("turns relaxed/canonical EJSON wrappers into plain values", () => {
    expect(
      ejsonToPlain({
        _id: { $oid: "65f0c0ffee" },
        at: { $date: "2026-01-01T00:00:00Z" },
        legacyAt: { $date: { $numberLong: "0" } },
        n: { $numberLong: "42" },
        big: { $numberLong: "9007199254740993" },
        price: { $numberDecimal: "9.99" },
        re: { $regularExpression: { pattern: "^a", options: "i" } },
        nested: [{ id: { $oid: "abc" } }],
        plain: { a: 1, b: { c: true } },
      }),
    ).toEqual({
      _id: "65f0c0ffee",
      at: "2026-01-01T00:00:00Z",
      legacyAt: "1970-01-01T00:00:00.000Z",
      n: 42,
      big: "9007199254740993",
      price: "9.99",
      re: "/^a/i",
      nested: [{ id: "abc" }],
      plain: { a: 1, b: { c: true } },
    });
  });
});
