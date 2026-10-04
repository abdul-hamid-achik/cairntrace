import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RunEventSchema, type RunEvent } from "../../core/schema/events.v1";
import {
  MetricsDocumentSchema,
  type MetricsDocument,
} from "../../core/schema/metrics.v1";
import {
  harvestReportMetric,
  readReportMetrics,
} from "../../core/stats/runStats";
import {
  executeRunInvocation,
  type RunInvocationResult,
} from "./executeRunInvocation";

/**
 * Config `metrics:` probes in the run engine: spec and invocation scope,
 * command and HTTP sources, deltas into diagnostics/metrics.json and
 * diagnostics/report.json (what `cairn stats --metric <name>.delta` reads),
 * non-fatal failures, `every:` sampling that stops with the run, secrets
 * kept out of every artifact — mock backend, stub commands, a local HTTP
 * server, temp dirs.
 */

let dir: string;
let runsRoot: string;
let server: Server;
let base: string;
let seen: Array<{ authorization?: string }>;
let counter = 0;

const spec = (name: string, extra = ""): string => `version: 1
name: ${name}
intent: A mock run that passes.
coldStart: guest
${extra}steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-metrics-eng-"));
  runsRoot = await mkdtemp(join(tmpdir(), "cairn-metrics-eng-runs-"));
  await writeFile(join(dir, "fast.yml"), spec("fast"));
  await writeFile(join(dir, "fast2.yml"), spec("fast2"));
  await writeFile(
    join(dir, "slow.yml"),
    spec(
      "slow",
      `preconditions:
  commands:
    - name: take_a_moment
      run: sleep 1.4
`,
    ),
  );
  seen = [];
  server = createServer((req, res) => {
    seen.push(
      req.headers.authorization
        ? { authorization: req.headers.authorization }
        : {},
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ indices: [{ n: 4 }, { n: 6 }] }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
  await rm(runsRoot, { recursive: true, force: true });
});

beforeEach(() => {
  counter += 1;
  seen.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function config(body: string): Promise<string> {
  const path = join(dir, `cfg-${counter}.config.yml`);
  await writeFile(
    path,
    `version: 1
project: metrics-demo
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
    vars:
      probeUrl: ${base}
${body}`,
  );
  return path;
}

function run(
  configPath: string,
  specs: string[],
  options: Record<string, unknown> = {},
): Promise<RunInvocationResult> {
  return executeRunInvocation(
    {
      specs: specs.map((s) => join(dir, s)),
      options: {
        mock: true,
        config: configPath,
        artifactRoot: join(runsRoot, `runs-${counter}`),
        noWebServer: true,
        noServices: true,
        ...options,
      },
      cwd: dir,
    },
    { origin: "cli" },
  );
}

async function events(result: RunInvocationResult): Promise<RunEvent[]> {
  const text = await readFile(
    join(result.journalDir!, "events.ndjson"),
    "utf8",
  );
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
}

async function metricsOf(dirPath: string): Promise<MetricsDocument> {
  return MetricsDocumentSchema.parse(
    JSON.parse(await readFile(join(dirPath, "metrics.json"), "utf8")),
  );
}

/** A counter file: every sample reads its value and adds `step` to it. */
async function counterProbe(
  name: string,
  start: number,
  step: number,
): Promise<string> {
  const file = join(dir, `${name}-${counter}.count`);
  await writeFile(file, `${start}\n`);
  return `n=$(cat "${file}"); echo $((n + ${step})) > "${file}"; echo $n`;
}

describe("spec-scope metrics", () => {
  it("samples around each spec into diagnostics/metrics.json and report.json", async () => {
    const command = await counterProbe("queue", 10, 7);
    const cfg = await config(`metrics:
  - name: queue_depth
    command: '${command}'
    parse: { regex: "^(\\\\d+)$" }
    unit: msgs
`);
    const result = await run(cfg, ["fast.yml"]);
    expect(result.exitCode).toBe(0);
    const [runDir] = result.runDirs;
    const doc = await metricsOf(join(runDir!, "diagnostics"));
    expect(doc).toMatchObject({
      runId: expect.any(String),
      environment: "local",
    });
    expect(doc.metrics).toHaveLength(1);
    expect(doc.metrics[0]).toMatchObject({
      name: "queue_depth",
      scope: "spec",
      source: "command",
      mode: "sample",
      unit: "msgs",
      before: { value: 10 },
      after: { value: 17 },
      delta: 7,
      failures: 0,
    });
    // What `cairn stats --metric queue_depth.delta` reads.
    expect(await readReportMetrics(runDir!)).toMatchObject({
      "queue_depth.before": 10,
      "queue_depth.after": 17,
      "queue_depth.delta": 7,
    });
    expect(await harvestReportMetric(runDir!, ["queue_depth.delta"])).toBe(7);
    const all = await events(result);
    for (const event of all) {
      expect(RunEventSchema.safeParse(event).success).toBe(true);
    }
    const sampled = all.filter((e) => e.type === "metric.sampled");
    expect(sampled).toHaveLength(2);
    expect(sampled.map((e) => (e as { phase: string }).phase)).toEqual([
      "before",
      "after",
    ]);
    expect(sampled[1]).toMatchObject({ value: 17, scope: "spec" });
    expect((sampled[1] as { runId?: string }).runId).toBe(doc.runId);
  });

  it("gives each spec of a batch its own before/after", async () => {
    const command = await counterProbe("batch", 0, 3);
    const cfg = await config(`metrics:
  - { name: depth, command: '${command}', parse: { regex: "^(\\\\d+)$" } }
`);
    const result = await run(cfg, ["fast.yml", "fast2.yml"]);
    expect(result.exitCode).toBe(0);
    const deltas = await Promise.all(
      result.runDirs.map(
        async (runDir) =>
          (await metricsOf(join(runDir, "diagnostics"))).metrics[0]!.delta,
      ),
    );
    // One spec at a time: each sees its own two samples (+3 between them).
    expect(deltas).toEqual([3, 3]);
  });

  it("merges into a report.json an --after collector wrote", async () => {
    const command = await counterProbe("merge", 1, 1);
    const cfg = await config(`metrics:
  - { name: m, command: '${command}', parse: { regex: "^(\\\\d+)$" } }
`);
    const result = await run(cfg, ["fast.yml"], {
      after: [
        'mkdir -p "$CAIRN_RUN_DIR/diagnostics" && echo \'{"rootMs": 120}\' > "$CAIRN_RUN_DIR/diagnostics/report.json"',
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(await readReportMetrics(result.runDirs[0]!)).toEqual({
      rootMs: 120,
      "m.before": 1,
      "m.after": 2,
      "m.delta": 1,
    });
  });

  it("records a failing probe and never fails the run", async () => {
    const notes: string[] = [];
    const cfg = await config(`metrics:
  - { name: broken, command: "echo oops >&2; exit 9", parse: { json: "$.x" } }
  - { name: fine, command: "echo 4", parse: { regex: "(\\\\d)" } }
`);
    const result = await executeRunInvocation(
      {
        specs: [join(dir, "fast.yml")],
        options: {
          mock: true,
          config: cfg,
          artifactRoot: join(runsRoot, `runs-${counter}`),
          noWebServer: true,
          noServices: true,
        },
        cwd: dir,
      },
      {
        origin: "cli",
        narration: { note: (_kind, message) => void notes.push(message) },
      },
    );
    expect(result.exitCode).toBe(0);
    const doc = await metricsOf(join(result.runDirs[0]!, "diagnostics"));
    const broken = doc.metrics.find((m) => m.name === "broken")!;
    expect(broken).toMatchObject({ failures: 2 });
    expect(broken.error).toContain("command exited 9: oops");
    expect(broken.delta).toBeUndefined();
    expect(doc.metrics.find((m) => m.name === "fine")).toMatchObject({
      delta: 0,
      failures: 0,
    });
    const report = await readReportMetrics(result.runDirs[0]!);
    expect(Object.keys(report).filter((k) => k.startsWith("broken"))).toEqual(
      [],
    );
    // Warned once, not per sample.
    expect(
      notes.filter((m) => m.startsWith("metric broken (spec) sample failed")),
    ).toHaveLength(1);
    const sampled = (await events(result)).filter(
      (e) =>
        e.type === "metric.sampled" &&
        (e as { name: string }).name === "broken",
    );
    expect(sampled).toHaveLength(2);
    expect(sampled[0]).toMatchObject({
      error: expect.stringContaining("exited 9"),
    });
  });

  it("an environment's metrics override the top-level probe of the same name", async () => {
    const cfg = await config(`metrics:
  - { name: m, command: "echo 1", parse: { regex: "(\\\\d)" } }
  - { name: only_top, command: "echo 2", parse: { regex: "(\\\\d)" } }
`);
    const text = (await readFile(cfg, "utf8")).replace(
      "    vars:",
      `    metrics:
      - { name: m, command: "echo 5", parse: { regex: "(\\\\d)" } }
    vars:`,
    );
    await writeFile(cfg, text);
    const result = await run(cfg, ["fast.yml"]);
    const doc = await metricsOf(join(result.runDirs[0]!, "diagnostics"));
    const byName = Object.fromEntries(
      doc.metrics.map((m) => [m.name, m.before?.value]),
    );
    expect(byName).toEqual({ m: 5, only_top: 2 });
  });

  it("samples every: while the spec runs and stops with it", async () => {
    const log = join(dir, `ticks-${counter}.log`);
    const cfg = await config(`metrics:
  - name: ticking
    every: 250ms
    command: 'echo t >> "${log}"; wc -l < "${log}"'
    parse: { regex: "(\\\\d+)" }
`);
    const result = await run(cfg, ["slow.yml"]);
    expect(result.exitCode).toBe(0);
    const doc = await metricsOf(join(result.runDirs[0]!, "diagnostics"));
    const row = doc.metrics[0]!;
    expect(row.mode).toBe("every");
    expect(row.series!.count).toBeGreaterThanOrEqual(3);
    expect(row.delta).toBe(row.series!.count - 1);
    expect(await readReportMetrics(result.runDirs[0]!)).toMatchObject({
      "ticking.max": row.series!.max,
      "ticking.delta": row.delta,
    });
    // Nothing keeps sampling once the invocation returned.
    const after = (await readFile(log, "utf8")).split("\n").length;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await readFile(log, "utf8")).split("\n").length).toBe(after);
  });
});

describe("invocation-scope metrics", () => {
  it("brackets the whole iteration once and shares the rows with every run", async () => {
    const command = await counterProbe("inv", 100, 25);
    const cfg = await config(`metrics:
  - name: total_docs
    scope: invocation
    command: '${command}'
    parse: { regex: "^(\\\\d+)$" }
`);
    const result = await run(cfg, ["fast.yml", "fast2.yml"]);
    expect(result.exitCode).toBe(0);
    // Two samples in the whole invocation, not four.
    const journal = await metricsOf(result.journalDir!);
    expect(journal.invocationId).toBe(result.journalDir!.split("/").at(-1));
    expect(journal.metrics).toHaveLength(1);
    expect(journal.metrics[0]).toMatchObject({
      scope: "invocation",
      before: { value: 100 },
      after: { value: 125 },
      delta: 25,
    });
    expect(journal.metrics[0]!.iteration).toBeUndefined();
    for (const runDir of result.runDirs) {
      const doc = await metricsOf(join(runDir, "diagnostics"));
      expect(doc.metrics[0]).toMatchObject({ scope: "invocation", delta: 25 });
      expect(await readReportMetrics(runDir)).toMatchObject({
        "total_docs.delta": 25,
      });
    }
    const sampled = (await events(result)).filter(
      (e) => e.type === "metric.sampled",
    );
    expect(sampled.map((e) => (e as { scope: string }).scope)).toEqual([
      "invocation",
      "invocation",
    ]);
  });

  it("samples once per --repeat iteration, stamped with the iteration", async () => {
    const command = await counterProbe("rep", 0, 10);
    const cfg = await config(`metrics:
  - { name: leg, scope: invocation, command: '${command}', parse: { regex: "^(\\\\d+)$" } }
`);
    const result = await run(cfg, ["fast.yml"], { repeat: 2 });
    expect(result.exitCode).toBe(0);
    const journal = await metricsOf(result.journalDir!);
    expect(
      journal.metrics.map((m) => [
        m.iteration,
        m.before?.value,
        m.after?.value,
      ]),
    ).toEqual([
      [1, 0, 10],
      [2, 20, 30],
    ]);
    // Each run holds its own iteration's rows.
    const perRun = await Promise.all(
      result.runDirs.map(async (runDir) =>
        (await metricsOf(join(runDir, "diagnostics"))).metrics.map(
          (m) => m.iteration,
        ),
      ),
    );
    expect(perRun).toEqual([[1], [2]]);
  });
});

describe("HTTP probes and secrets", () => {
  it("authenticates with a secret, reduces the JSON and keeps the secret out of every artifact", async () => {
    // Built at runtime: no secret-shaped literal in the source.
    const token = ["probe", "token", String(Date.now()), "xyz"].join("-");
    vi.stubEnv("PROBE_TOKEN", token);
    const cfg = await config(`metrics:
  - name: docs
    scope: invocation
    http:
      url: \${vars.probeUrl}/_stats?access=\${secrets.PROBE_TOKEN}
      auth: { bearer: "\${secrets.PROBE_TOKEN}" }
      json: { path: "$.indices[*].n", reduce: sum }
  - name: unset_secret
    scope: invocation
    http:
      url: \${vars.probeUrl}/x
      auth: { bearer: "\${secrets.NOT_SET_ANYWHERE}" }
      json: { path: "$.x" }
`);
    const result = await run(cfg, ["fast.yml"]);
    expect(result.exitCode).toBe(0);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((s) => s.authorization === `Bearer ${token}`)).toBe(true);
    const journal = await metricsOf(result.journalDir!);
    expect(journal.metrics.find((m) => m.name === "docs")).toMatchObject({
      source: "http",
      // The template as written (placeholders, never their values), no query.
      target: "${vars.probeUrl}/_stats",
      before: { value: 10 },
      delta: 0,
    });
    expect(journal.metrics.find((m) => m.name === "unset_secret")!.error).toBe(
      "${secrets.NOT_SET_ANYWHERE} is not set",
    );
    // No artifact of the invocation holds the token.
    const holders: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if ((await readFile(full, "utf8").catch(() => "")).includes(token))
          holders.push(full);
      }
    };
    await walk(join(runsRoot, `runs-${counter}`));
    expect(holders).toEqual([]);
  });
});

describe("without metrics", () => {
  it("writes no metrics file", async () => {
    const cfg = await config("");
    const result = await run(cfg, ["fast.yml"]);
    expect(
      existsSync(join(result.runDirs[0]!, "diagnostics", "metrics.json")),
    ).toBe(false);
    expect(existsSync(join(result.journalDir!, "metrics.json"))).toBe(false);
  });
});
