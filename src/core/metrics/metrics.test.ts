import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MetricResultSchema } from "../schema/metrics.v1";
import {
  mergeReportMetrics,
  reportKeysOf,
  writeMetricsFile,
} from "./artifacts";
import {
  readJsonNumber,
  readRegexNumber,
  resolveProbeText,
  runProbe,
  type ProbeEnvironment,
} from "./probes";
import { MetricsScope } from "./sampler";
import {
  MetricProbeSchema,
  MetricsListSchema,
  mergeMetrics,
  normalizeProbe,
  type MetricProbe,
} from "./schema";

let dir: string;
let server: Server;
let base: string;
let requests: Array<{ url: string; authorization?: string; header?: string }>;
let slow = false;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-metrics-"));
  requests = [];
  server = createServer((req, res) => {
    requests.push({
      url: req.url ?? "",
      ...(req.headers.authorization
        ? { authorization: req.headers.authorization }
        : {}),
      ...(typeof req.headers["x-probe"] === "string"
        ? { header: req.headers["x-probe"] }
        : {}),
    });
    const send = (status: number, body: string, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (slow) return void setTimeout(() => send(200, "{}"), 5_000).unref();
    if (req.url?.startsWith("/stats")) {
      return send(
        200,
        JSON.stringify({
          depth: 7,
          indices: [{ docs: { count: 10 } }, { docs: { count: 32 } }],
          text: "nope",
        }),
      );
    }
    if (req.url?.startsWith("/down")) return send(503, "{}");
    if (req.url?.startsWith("/plain")) return send(200, "ok", "text/plain");
    send(404, "{}");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const probe = (extra: Partial<MetricProbe> & { name: string }): MetricProbe =>
  MetricProbeSchema.parse(extra);

function env(over: Partial<ProbeEnvironment> = {}): ProbeEnvironment {
  return {
    placeholderEnv: {},
    vars: {},
    childEnv: { PATH: process.env.PATH },
    cwd: dir,
    redact: (text) => text,
    ...over,
  };
}

describe("metrics schema", () => {
  it("accepts the documented shapes and defaults sample to both ends", () => {
    const ok = probe({
      name: "queue_depth",
      command: "echo 1",
      parse: { json: "$.depth" },
    });
    expect(normalizeProbe(ok)).toMatchObject({
      scope: "spec",
      phases: ["before", "after"],
      everyMs: undefined,
      timeoutMs: 10_000,
    });
    const every = probe({
      name: "rss",
      every: "500ms",
      scope: "invocation",
      command: "echo 5",
      parse: { regex: "(\\d+)", unit: "MB" },
      timeout: "2s",
    });
    expect(normalizeProbe(every)).toMatchObject({
      scope: "invocation",
      everyMs: 500,
      timeoutMs: 2000,
      unit: "MB",
    });
  });

  it.each([
    [{ name: "a.b", command: "x", parse: { json: "$.a" } }, "no dots"],
    [
      {
        name: "a",
        sample: ["before"],
        every: "1s",
        command: "x",
        parse: { json: "a" },
      },
      "not both",
    ],
    [{ name: "a" }, "exactly one source"],
    [{ name: "a", command: "x" }, "needs `parse"],
    [
      {
        name: "a",
        command: "x",
        parse: { json: "a" },
        http: { url: "u", json: { path: "a" } },
      },
      "exactly one source",
    ],
    [{ name: "a", command: "x", parse: { regex: "(" } }, "invalid regex"],
    [{ name: "a", command: "x", parse: { json: "a[?(" } }, "invalid json path"],
    [
      { name: "a", every: "100ms", command: "x", parse: { json: "a" } },
      "at least 250ms",
    ],
    [
      { name: "a", timeout: "10m", command: "x", parse: { json: "a" } },
      "timeout must be between",
    ],
    [
      {
        name: "a",
        http: {
          url: "u",
          auth: { bearer: "a", basic: "b" },
          json: { path: "a" },
        },
      },
      "exactly one of bearer or basic",
    ],
    [
      {
        name: "a",
        sample: ["before", "before"],
        command: "x",
        parse: { json: "a" },
      },
      "each phase once",
    ],
  ])("refuses %j", (input, message) => {
    const parsed = MetricProbeSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify((parsed as { error: unknown }).error)).toContain(
      message,
    );
  });

  it("refuses duplicate names and merges an environment list by name", () => {
    const a = probe({ name: "a", command: "x", parse: { json: "a" } });
    const b = probe({ name: "b", command: "x", parse: { json: "b" } });
    expect(MetricsListSchema.safeParse([a, a]).success).toBe(false);
    const a2 = probe({ name: "a", command: "y", parse: { json: "a" } });
    const merged = mergeMetrics([a, b], [a2]);
    expect(merged?.map((p) => `${p.name}:${p.command}`)).toEqual([
      "a:y",
      "b:x",
    ]);
    expect(mergeMetrics(undefined, [a])).toEqual([a]);
    expect(mergeMetrics([a], undefined)).toEqual([a]);
  });
});

describe("reading a number", () => {
  const doc = {
    depth: 7,
    text: "x",
    list: [{ n: 1 }, { n: 4 }, { n: 10 }],
    tasks: [
      { title: "a", n: 2 },
      { title: "b", n: 5 },
    ],
  };

  it("takes one value, or combines several with reduce", () => {
    expect(readJsonNumber(doc, "$.depth", undefined)).toBe(7);
    expect(readJsonNumber(doc, "list[*].n", "sum")).toBe(15);
    expect(readJsonNumber(doc, "list[*].n", "max")).toBe(10);
    expect(readJsonNumber(doc, "list[*].n", "min")).toBe(1);
    expect(readJsonNumber(doc, "list[*].n", "count")).toBe(3);
    expect(readJsonNumber(doc, '$.tasks[?(@.title == "b")].n', "sum")).toBe(5);
    expect(readJsonNumber({ n: "42" }, "n", undefined)).toBe(42);
  });

  it("explains a path that cannot give a number, without echoing values", () => {
    expect(() => readJsonNumber(doc, "$.nope", undefined)).toThrow(
      "matched nothing",
    );
    expect(() => readJsonNumber(doc, "list[*].n", undefined)).toThrow(
      "set reduce",
    );
    expect(() => readJsonNumber(doc, "text", undefined)).toThrow(
      "not a number (got string)",
    );
    expect(() => readJsonNumber(doc, "list[*]", "sum")).toThrow("non-number");
    expect(() => readJsonNumber({ l: [] }, "l[*]", "max")).toThrow(
      "no values to reduce",
    );
    expect(readJsonNumber({ l: [] }, "l[*]", "sum")).toBe(0);
  });

  it("reads a regex capture", () => {
    expect(
      readRegexNumber("total=12 ms\nother=3", "total=(\\d+)", undefined),
    ).toBe(12);
    expect(readRegexNumber("v 3.5", "\\d+\\.\\d+", undefined)).toBe(3.5);
    expect(readRegexNumber("a=1 b=2", "a=(\\d) b=(\\d)", 2)).toBe(2);
    expect(() => readRegexNumber("none", "x=(\\d)", undefined)).toThrow(
      "did not match",
    );
    expect(() => readRegexNumber("x=abc", "x=(\\w+)", undefined)).toThrow(
      "not a number",
    );
  });
});

describe("placeholders", () => {
  const scope = {
    placeholderEnv: { TOK: "abcd1234", HOST: "h" },
    vars: { url: "http://x", nested: { port: 80 } },
  };
  it("resolves secrets, env and vars and collects secret values", () => {
    const secrets: string[] = [];
    expect(
      resolveProbeText(
        "${vars.url}:${vars.nested.port}/${secrets.TOK}/${env.HOST}/${env.NOPE:-dflt}",
        scope,
        secrets,
      ),
    ).toBe("http://x:80/abcd1234/h/dflt");
    expect(secrets).toEqual(["abcd1234"]);
  });

  it("collects env values long enough to scrub", () => {
    const secrets: string[] = [];
    resolveProbeText(
      "/${env.TENANT}/${env.HOST}",
      { placeholderEnv: { TENANT: "tenant-7781", HOST: "h" }, vars: {} },
      secrets,
    );
    expect(secrets).toEqual(["tenant-7781"]);
  });

  it("the config keeps ${env.X} of a metrics http block as a placeholder until the sample", async () => {
    const tenant = ["ten", "ant", String(process.pid)].join("-");
    const configPath = join(dir, "metrics-env.config.yml");
    await writeFile(
      configPath,
      `version: 1
project: metrics-env
defaultEnvironment: local
environments:
  local:
    baseUrl: http://${"${env.METRIC_HOST}"}
    metrics:
      - name: per_env
        http:
          url: "${base}/down/${"${env.METRIC_TENANT}"}?k=1"
          json: { path: "$.x" }
metrics:
  - name: queue
    http:
      url: "${base}/down/${"${env.METRIC_TENANT}"}"
      headers: { X-Tenant: "${"${env.METRIC_TENANT}"}" }
      json: { path: "$.x" }
`,
    );
    const { loadConfig } = await import("../config/loader");
    const loaded = await loadConfig(configPath, configPath, {
      env: { METRIC_TENANT: tenant, METRIC_HOST: "app.example.test" },
    });
    // Outside a metrics http block, ${env.X} still resolves at load.
    expect(loaded!.config.environments.local!.baseUrl).toBe(
      "http://app.example.test",
    );
    const top = loaded!.config.metrics![0]!;
    expect(top.http!.url).toBe(`${base}/down/\${env.METRIC_TENANT}`);
    expect(top.http!.headers).toEqual({ "X-Tenant": "${env.METRIC_TENANT}" });
    expect(loaded!.config.environments.local!.metrics![0]!.http!.url).toBe(
      `${base}/down/\${env.METRIC_TENANT}?k=1`,
    );
    expect(JSON.stringify(loaded!.config)).not.toContain(tenant);
    // The sample resolves it; the failure names the template, not the value.
    const status = await runProbe(
      normalizeProbe(top),
      env({ placeholderEnv: { METRIC_TENANT: tenant } }),
    );
    expect(status.error).toBe(
      `${base}/down/\${env.METRIC_TENANT} answered HTTP 503`,
    );
    expect(requests.at(-1)?.url).toBe(`/down/${tenant}`);
  });

  it("refuses an unset reference instead of probing the wrong place", () => {
    expect(() => resolveProbeText("${secrets.MISSING}", scope, [])).toThrow(
      "${secrets.MISSING} is not set",
    );
    expect(() => resolveProbeText("${vars.zzz}", scope, [])).toThrow(
      "${vars.zzz} is not defined",
    );
  });
});

describe("runProbe", () => {
  it("samples a command (json and regex) and fails softly", async () => {
    const json = await runProbe(
      normalizeProbe(
        probe({
          name: "j",
          command: `echo '{"depth": 9}'`,
          parse: { json: "$.depth" },
        }),
      ),
      env(),
    );
    expect(json).toMatchObject({ value: 9 });
    const regex = await runProbe(
      normalizeProbe(
        probe({
          name: "r",
          command: "echo took 31ms",
          parse: { regex: "took (\\d+)" },
        }),
      ),
      env(),
    );
    expect(regex.value).toBe(31);
    const failing = await runProbe(
      normalizeProbe(
        probe({
          name: "f",
          command: "echo boom >&2; exit 3",
          parse: { json: "$.x" },
        }),
      ),
      env(),
    );
    expect(failing.value).toBeUndefined();
    expect(failing.error).toContain("command exited 3: boom");
    const notJson = await runProbe(
      normalizeProbe(
        probe({ name: "n", command: "echo hello", parse: { json: "$.x" } }),
      ),
      env(),
    );
    expect(notJson.error).toBe("the command output is not JSON");
  });

  it("kills a command at its timeout, process group included", async () => {
    const pidFile = join(dir, "timeout.pid");
    const started = Date.now();
    const outcome = await runProbe(
      normalizeProbe(
        probe({
          name: "slow",
          command: `echo $$ > "${pidFile}"; sleep 30`,
          parse: { json: "$.x" },
          timeout: "300ms",
        }),
      ),
      env(),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome.error).toContain("timed out after 300ms");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("stops at once when aborted", async () => {
    const controller = new AbortController();
    const running = runProbe(
      normalizeProbe(
        probe({ name: "a", command: "sleep 30", parse: { json: "$.x" } }),
      ),
      env(),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 150);
    const outcome = await running;
    expect(outcome.error).toBe("cancelled");
  });

  it("gets JSON over HTTP with a bearer token and a header, reducing a wildcard", async () => {
    // Built at runtime: no secret-shaped literal in the source.
    const probeToken = ["probe", "value", "0123456789"].join("-");
    requests.length = 0;
    const outcome = await runProbe(
      normalizeProbe(
        probe({
          name: "docs",
          http: {
            url: "${vars.base}/stats?token=${secrets.TOK}",
            headers: { "x-probe": "${vars.tag}" },
            auth: { bearer: "${secrets.TOK}" },
            json: { path: "$.indices[*].docs.count", reduce: "sum" },
          },
        }),
      ),
      env({
        placeholderEnv: { TOK: probeToken },
        vars: { base, tag: "t1" },
      }),
    );
    expect(outcome).toMatchObject({ value: 42 });
    expect(requests[0]).toMatchObject({
      authorization: `Bearer ${probeToken}`,
      header: "t1",
    });
  });

  it("reports HTTP failures without the URL's query or any secret", async () => {
    const secret = ["tok", "9f8e7d6c5b"].join("-");
    const status = await runProbe(
      normalizeProbe(
        probe({
          name: "down",
          http: {
            url: `${base}/down?token=\${secrets.TOK}`,
            json: { path: "$.x" },
          },
        }),
      ),
      env({ placeholderEnv: { TOK: secret } }),
    );
    expect(status.error).toBe(`${base}/down answered HTTP 503`);
    const plain = await runProbe(
      normalizeProbe(
        probe({
          name: "p",
          http: { url: `${base}/plain`, json: { path: "$.x" } },
        }),
      ),
      env(),
    );
    expect(plain.error).toBe("the response is not JSON");
    // A dead port: the transport error names the host, never the secret.
    const dead = await runProbe(
      normalizeProbe(
        probe({
          name: "dead",
          http: {
            url: `http://127.0.0.1:9/x/\${secrets.TOK}`,
            auth: { bearer: "${secrets.TOK}" },
            json: { path: "$.x" },
          },
        }),
      ),
      env({ placeholderEnv: { TOK: secret } }),
    );
    expect(dead.error).toBeDefined();
    expect(dead.error).not.toContain(secret);
    const unset = await runProbe(
      normalizeProbe(
        probe({
          name: "unset",
          http: { url: "${secrets.NOT_THERE}", json: { path: "$.x" } },
        }),
      ),
      env(),
    );
    expect(unset.error).toBe("${secrets.NOT_THERE} is not set");
  });

  it("times an HTTP request out", async () => {
    slow = true;
    try {
      const started = Date.now();
      const outcome = await runProbe(
        normalizeProbe(
          probe({
            name: "t",
            http: { url: `${base}/stats`, json: { path: "$.x" } },
            timeout: "300ms",
          }),
        ),
        env(),
      );
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(outcome.error).toContain("timed out");
    } finally {
      slow = false;
    }
  });

  it("redacts what the caller's redactor knows", async () => {
    const outcome = await runProbe(
      normalizeProbe(
        probe({
          name: "r",
          command: "echo shh-value >&2; exit 1",
          parse: { json: "$.x" },
        }),
      ),
      env({ redact: (text) => text.replaceAll("shh-value", "[redacted]") }),
    );
    expect(outcome.error).toContain("[redacted]");
    expect(outcome.error).not.toContain("shh-value");
  });
});

describe("MetricsScope", () => {
  it("samples before and after and computes the delta", async () => {
    const counter = join(dir, "counter.txt");
    await writeFile(counter, "10\n");
    // Each sample reads the number and then adds 5 to it.
    const command = `n=$(cat "${counter}"); echo $((n + 5)) > "${counter}"; echo $n`;
    const notices: string[] = [];
    const scope = new MetricsScope({
      probes: [
        normalizeProbe(
          probe({ name: "grow", command, parse: { regex: "^(\\d+)$" } }),
        ),
        normalizeProbe(
          probe({
            name: "after_only",
            sample: ["after"],
            command: "echo 3",
            parse: { regex: "(\\d+)" },
          }),
        ),
      ],
      scope: "spec",
      env: env(),
      onSample: (n) => void notices.push(`${n.name}:${n.phase}`),
    });
    await scope.start();
    const rows = await scope.stop();
    expect(rows.map((r) => MetricResultSchema.safeParse(r).success)).toEqual([
      true,
      true,
    ]);
    expect(rows[0]).toMatchObject({
      name: "grow",
      mode: "sample",
      before: { value: 10 },
      after: { value: 15 },
      delta: 5,
      failures: 0,
    });
    expect(rows[1]).toMatchObject({ after: { value: 3 } });
    expect(rows[1]!.before).toBeUndefined();
    expect(rows[1]!.delta).toBeUndefined();
    expect(notices.toSorted()).toEqual([
      "after_only:after",
      "grow:after",
      "grow:before",
    ]);
    // A second stop returns the same rows and takes no new sample.
    expect(await scope.stop()).toEqual(rows);
    expect(await readFile(counter, "utf8")).toBe("20\n");
  });

  it("records a failing probe and keeps going", async () => {
    const scope = new MetricsScope({
      probes: [
        normalizeProbe(
          probe({ name: "bad", command: "exit 4", parse: { json: "$.x" } }),
        ),
        normalizeProbe(
          probe({ name: "good", command: "echo 2", parse: { regex: "(\\d)" } }),
        ),
      ],
      scope: "invocation",
      iteration: 2,
      env: env(),
    });
    await scope.start();
    const rows = await scope.stop();
    expect(rows[0]).toMatchObject({
      name: "bad",
      failures: 2,
      error: expect.stringContaining("exited 4"),
      iteration: 2,
    });
    expect(rows[0]!.delta).toBeUndefined();
    expect(rows[1]).toMatchObject({ delta: 0, failures: 0 });
  });

  it("ticks every: and leaves no timer or process behind after stop()", async () => {
    const log = join(dir, "ticks.txt");
    const pidFile = join(dir, "tick.pid");
    const scope = new MetricsScope({
      probes: [
        normalizeProbe(
          probe({
            name: "series",
            every: "250ms",
            command: `echo x >> "${log}"; wc -l < "${log}"`,
            parse: { regex: "(\\d+)" },
          }),
        ),
      ],
      scope: "spec",
      env: env(),
    });
    await scope.start();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const rows = await scope.stop();
    const series = rows[0]!.series!;
    expect(series.count).toBeGreaterThanOrEqual(3);
    expect(series.min).toBe(1);
    expect(series.max).toBe(series.count);
    expect(rows[0]!.delta).toBe(series.count - 1);
    const linesAtStop = (await readFile(log, "utf8")).split("\n").length;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await readFile(log, "utf8")).split("\n").length).toBe(linesAtStop);
    // An in-flight sample is killed when the invocation is cancelled.
    // The start sample would hang for 20s: abort it with the cancel signal.
    const cancel = new AbortController();
    const cancellable = new MetricsScope({
      probes: [
        normalizeProbe(
          probe({
            name: "hang2",
            every: "250ms",
            command: `echo $$ > "${pidFile}"; sleep 30`,
            parse: { regex: "(\\d+)" },
            timeout: "20s",
          }),
        ),
      ],
      scope: "spec",
      env: env(),
      signal: cancel.signal,
    });
    const starting = cancellable.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(() => process.kill(pid, 0)).not.toThrow();
    cancel.abort();
    await starting;
    await cancellable.dispose();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("dispose() aborts a before sample in flight and waits for it", async () => {
    const pidFile = join(dir, "before-pid.txt");
    const scope = new MetricsScope({
      probes: [
        normalizeProbe(
          probe({
            name: "slow_before",
            command: `echo $$ > "${pidFile}"; exec sleep 20`,
            parse: { regex: "(\\d)" },
            timeout: "30s",
          }),
        ),
      ],
      scope: "spec",
      env: env(),
    });
    const starting = scope.start();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const text = await readFile(pidFile, "utf8").catch(() => "");
      if (text.trim()) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    const disposedAt = Date.now();
    await scope.dispose();
    await starting;
    expect(Date.now() - disposedAt).toBeLessThan(5_000);
    expect(() => process.kill(pid, 0)).toThrow();
    const rows = scope.results();
    expect(rows[0]!.before).toBeUndefined();
    expect(rows[0]!.failures).toBe(0);
  });

  it("dispose() stops without an after sample", async () => {
    const counter = join(dir, "dispose.txt");
    await writeFile(counter, "");
    const scope = new MetricsScope({
      probes: [
        normalizeProbe(
          probe({
            name: "d",
            command: `echo s >> "${counter}"; echo 1`,
            parse: { regex: "(\\d)" },
          }),
        ),
      ],
      scope: "spec",
      env: env(),
    });
    await scope.start();
    await scope.dispose();
    const rows = await scope.stop();
    expect(rows[0]!.after).toBeUndefined();
    expect(
      (await readFile(counter, "utf8")).split("\n").filter(Boolean),
    ).toHaveLength(1);
  });
});

const row = (over: Record<string, unknown> = {}) =>
  MetricResultSchema.parse({
    name: "q",
    scope: "spec",
    source: "command",
    mode: "sample",
    before: { at: "2026-01-01T00:00:00.000Z", value: 3, durationMs: 1 },
    after: { at: "2026-01-01T00:00:01.000Z", value: 8, durationMs: 1 },
    delta: 5,
    failures: 0,
    ...over,
  });

describe("metrics artifacts", () => {
  it("flattens a row into <name>.before|after|delta and the every: stats", () => {
    expect(reportKeysOf(row())).toEqual({
      "q.before": 3,
      "q.after": 8,
      "q.delta": 5,
    });
    expect(
      reportKeysOf(
        row({
          mode: "every",
          series: { count: 3, samples: [], min: 1, max: 9, mean: 4 },
        }),
      ),
    ).toMatchObject({ "q.min": 1, "q.max": 9, "q.mean": 4 });
    expect(
      reportKeysOf(
        row({ before: undefined, after: undefined, delta: undefined }),
      ),
    ).toEqual({});
  });

  it("merges rows into metrics.json by scope, name and iteration", async () => {
    const out = join(dir, "doc");
    await writeMetricsFile(out, [row()], { runId: "r1" });
    const merged = await writeMetricsFile(
      out,
      [
        row({ delta: 6 }),
        row({ name: "other", scope: "invocation", iteration: 2 }),
      ],
      { runId: "r1" },
    );
    expect(merged.map((r) => `${r.scope}/${r.name}/${r.delta ?? "-"}`)).toEqual(
      ["spec/q/6", "invocation/other/5"],
    );
    const file = JSON.parse(await readFile(join(out, "metrics.json"), "utf8"));
    expect(file).toMatchObject({
      $schema: "urn:cairntrace.dev:metrics:v1",
      version: "1",
      runId: "r1",
    });
  });

  it("merges report numerics without losing a collector's fields", async () => {
    const run = join(dir, "run-report");
    await writeMetricsFile(join(run, "diagnostics"), [row()], {});
    await writeFile(
      join(run, "diagnostics", "report.json"),
      JSON.stringify({ rootMs: 120, note: "kept" }),
    );
    expect(await mergeReportMetrics(run, [row()])).toBe(true);
    expect(
      JSON.parse(
        await readFile(join(run, "diagnostics", "report.json"), "utf8"),
      ),
    ).toEqual({
      rootMs: 120,
      note: "kept",
      "q.before": 3,
      "q.after": 8,
      "q.delta": 5,
    });
    // Not an object: left alone.
    const odd = join(dir, "run-odd");
    await writeMetricsFile(join(odd, "diagnostics"), [row()], {});
    await writeFile(join(odd, "diagnostics", "report.json"), "[1,2]");
    expect(await mergeReportMetrics(odd, [row()])).toBe(false);
    expect(
      await readFile(join(odd, "diagnostics", "report.json"), "utf8"),
    ).toBe("[1,2]");
  });
});
