import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { collectSpecRedaction, runHookCommands } from "./run";

/**
 * Secrets must not reach the live logs and journal surfaces through the
 * child environment, multi-line values, early (pre-run) hooks, concurrent
 * after hooks, or the JSON narration of hook commands. End to end through
 * the real CLI with the mock backend.
 */
const CAIRN = join(process.cwd(), "bin", "cairn");
/** Each test spawns bin/cairn; vitest's 5s default is too tight under load. */
const E2E_TIMEOUT_MS = 40_000;

const INGEST_CANARY = "canary-ingest-1234";
const TVAULT_CANARY = "canary-tvault-5678";
const PEM_LINES = [
  "-----BEGIN DEMO KEY-----",
  "MIIEdemoSECRETbodyLINE1",
  "MIIEdemoSECRETbodyLINE2",
  "-----END DEMO KEY-----",
];
const PEM = PEM_LINES.join("\n");
const BEARER = "sk-live-demo123";

const PRECONDITION_SPEC = `version: 1
name: demo_redaction_pre
intent: Setup output never persists withheld credentials or multi-line secrets.
coldStart: guest
preconditions:
  commands:
    - name: show_env
      run: 'echo "ingest=$FILECHEAP_INGEST_TOKEN tvault=$TVAULT_TOKEN"; printf "%s\\n" "$DEMO_PRIVATE_TOKEN"'
      timeoutMs: 30000
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

const passingSpec = (name: string) => `version: 1
name: ${name}
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

/** Every regular file under `root`, read as text. */
async function readTree(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.set(path, await readFile(path, "utf8"));
    }
  };
  await visit(root);
  return files;
}

function expectAbsent(files: Map<string, string>, needles: string[]): void {
  for (const [path, text] of files) {
    for (const needle of needles) {
      expect(text.includes(needle), `${needle} in ${path}`).toBe(false);
    }
  }
}

async function journalLogs(artifactRoot: string): Promise<string> {
  const ids = await readdir(join(artifactRoot, "_invocations"));
  expect(ids).toHaveLength(1);
  return join(artifactRoot, "_invocations", ids[0]!, "logs");
}

describe("cairn run secret boundaries", () => {
  it(
    "keeps withheld credentials, multi-line secrets, and hook commands out of logs and narration",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cairn-redaction-env-"));
      const artifactRoot = join(dir, "runs");
      await writeFile(join(dir, "pre.yml"), PRECONDITION_SPEC);
      await writeFile(
        join(dir, "cairntrace.config.yml"),
        `version: 1
environments:
  local: {}
services:
  docker:
    command: 'echo "Authorization: Bearer ${BEARER}" > /dev/null; echo "docker ingest=$FILECHEAP_INGEST_TOKEN tvault=$TVAULT_TOKEN"; printf "%s\\n" "$DEMO_PRIVATE_TOKEN"'
    reuseExisting: false
`,
      );

      const result = await execa(
        CAIRN,
        [
          "--log-format",
          "json",
          "run",
          "pre.yml",
          "--mock",
          "--no-web-server",
          "--artifact-root",
          artifactRoot,
          "--json",
          "--before",
          'echo "before ingest=$FILECHEAP_INGEST_TOKEN tv=$TVAULT_TOKEN"; printf "%s\\n" "$DEMO_PRIVATE_TOKEN"',
          "--before",
          `echo "Authorization: Bearer ${BEARER}" > /dev/null`,
          "--after",
          'echo "after ingest=$FILECHEAP_INGEST_TOKEN"; printf "%s\\n" "$DEMO_PRIVATE_TOKEN"',
        ],
        {
          cwd: dir,
          reject: false,
          timeout: 30_000,
          env: {
            CI: "true",
            FILECHEAP_INGEST_TOKEN: INGEST_CANARY,
            TVAULT_TOKEN: TVAULT_CANARY,
            DEMO_PRIVATE_TOKEN: PEM,
          },
        },
      );
      expect(result.exitCode, result.stderr).toBe(0);

      const logs = await journalLogs(artifactRoot);
      // The children never saw the withheld credentials at all.
      expect(
        await readFile(join(logs, "hook-before-01.log"), "utf8"),
      ).toContain("before ingest= tv=");
      expect(
        await readFile(join(logs, "services-docker.log"), "utf8"),
      ).toContain("docker ingest= tvault=");
      const runDir = (JSON.parse(result.stdout) as { runDir: string }).runDir;
      expect(
        await readFile(
          join(runDir, "logs", "precondition-01-show_env.log"),
          "utf8",
        ),
      ).toContain("ingest= tvault=");

      // Nothing anywhere under the artifact root holds a secret or a fragment
      // of the multi-line one.
      expectAbsent(await readTree(artifactRoot), [
        INGEST_CANARY,
        TVAULT_CANARY,
        PEM_LINES[1]!,
        PEM_LINES[2]!,
        BEARER,
      ]);
      // JSON narration logs hook and services commands through the same
      // redactor.
      expect(result.stderr).toContain(
        '"docker (echo \\"Authorization: [redacted]',
      );
      expect(result.stderr).toContain(
        '"before: echo \\"Authorization: [redacted]',
      );
      expect(result.stderr).not.toContain(BEARER);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "gives each concurrent --after hook its own log and redacts a secret printed in pieces",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cairn-redaction-parallel-"));
      const artifactRoot = join(dir, "runs");
      await writeFile(join(dir, "a.yml"), passingSpec("demo_parallel_a"));
      await writeFile(join(dir, "b.yml"), passingSpec("demo_parallel_b"));

      const result = await execa(
        CAIRN,
        [
          "run",
          "a.yml",
          "b.yml",
          "--parallel",
          "2",
          "--mock",
          "--no-services",
          "--no-web-server",
          "--artifact-root",
          artifactRoot,
          "--json",
          "--after",
          // The secret leaves in two writes 300ms apart; neither half appears
          // in the command text itself.
          'printf "part-$CAIRN_RUN_ID-"; printf "%s" "$(printf %s "$DEMO_API_TOKEN" | cut -c1-11)"; sleep 0.3; printf "%s\\n" "$(printf %s "$DEMO_API_TOKEN" | cut -c12-)"; echo "done $CAIRN_RUN_ID"',
        ],
        {
          cwd: dir,
          reject: false,
          timeout: 30_000,
          env: { CI: "true", DEMO_API_TOKEN: "FIRSTHALFxxSECONDHALF" },
        },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const runIds = (
        JSON.parse(result.stdout) as { results: Array<{ runId: string }> }
      ).results.map((run) => run.runId);
      expect(runIds).toHaveLength(2);

      const logs = await journalLogs(artifactRoot);
      for (const [i, runId] of runIds.entries()) {
        const text = await readFile(
          join(logs, `hook-after-01-${runId}.log`),
          "utf8",
        );
        expect(text).toContain(`part-${runId}-[redacted]`);
        expect(text).toContain(`done ${runId}`);
        expect(text).not.toContain(runIds[1 - i]!);
        expect(text.trimEnd().split("\n").at(-1)).toMatch(
          /^\[exit 0 after \d+ms\]$/,
        );
      }
      expectAbsent(await readTree(artifactRoot), ["FIRSTHALFxx", "SECONDHALF"]);
    },
    E2E_TIMEOUT_MS,
  );
});

describe("runHookCommands child environment", () => {
  const saved = {
    ingest: process.env.FILECHEAP_INGEST_TOKEN,
    tvault: process.env.TVAULT_TOKEN,
  };
  afterEach(() => {
    for (const [key, value] of [
      ["FILECHEAP_INGEST_TOKEN", saved.ingest],
      ["TVAULT_TOKEN", saved.tvault],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("does not let execa merge the parent's withheld credentials back in", async () => {
    process.env.FILECHEAP_INGEST_TOKEN = INGEST_CANARY;
    process.env.TVAULT_TOKEN = TVAULT_CANARY;
    await expect(
      runHookCommands("before", [
        'test -z "$FILECHEAP_INGEST_TOKEN" && test -z "$TVAULT_TOKEN"',
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("collectSpecRedaction", () => {
  it("merges every spec's redaction block and resolves env placeholders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-spec-redaction-"));
    await writeFile(
      join(dir, "a.yml"),
      `${passingSpec("demo_a")}redaction:
  values: ["literal-a-0042", "\${env.DEMO_LITERAL}", "\${vars.notYetKnown}"]
  headers: [X-Demo-Key]
`,
    );
    await writeFile(
      join(dir, "b.yml"),
      `${passingSpec("demo_b")}redaction:
  queryParams: [sig]
  values: ["literal-a-0042"]
`,
    );
    const config = await collectSpecRedaction(
      [join(dir, "a.yml"), join(dir, "b.yml"), join(dir, "missing.yml")],
      { DEMO_LITERAL: "from-env-7788" },
    );
    expect(config).toEqual({
      headers: ["X-Demo-Key"],
      queryParams: ["sig"],
      values: ["literal-a-0042", "from-env-7788"],
    });
  });
});
