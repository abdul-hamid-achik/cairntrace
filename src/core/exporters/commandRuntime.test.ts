import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  lateEnvNamesOf,
  renderCommandModule,
  simpleCommandWords,
} from "./commandRuntime";
import { envDefaultSentinel } from "./templateValue";

interface CommandModule {
  cairnCommand(
    command: string | { argv: string[] },
    options: {
      cwd: string;
      timeoutMs: number;
      args?: string[];
      env?: Record<string, string>;
      capture?: boolean;
      label?: string;
      context?: Record<string, string>;
      redact?: string[];
    },
  ): Promise<string>;
  runPrecondition(
    command: string | { argv: string[] },
    options: { cwd: string; timeoutMs: number },
  ): Promise<void>;
  cairnLastJson(stdout: string, label: string): unknown;
  cairnTestContext(
    info: { project: { use: { baseURL?: string } }; outputDir: string },
    runToken?: string,
    status?: string,
  ): Record<string, string>;
  targetPreconditionEnv(
    overrides?: Record<string, string>,
  ): Record<string, string>;
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function loadModule(): Promise<{ module: CommandModule; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-command-runtime-"));
  directories.push(dir);
  const file = join(dir, "preconditions.mjs");
  await writeFile(file, renderCommandModule("js"));
  const module = (await import(
    `${pathToFileURL(file).href}?t=${Date.now()}`
  )) as CommandModule;
  return { module, dir };
}

describe("simpleCommandWords (spawn without a shell where possible)", () => {
  it("splits plain words and quoted words", () => {
    expect(simpleCommandWords("bun run seed")).toEqual(["bun", "run", "seed"]);
    expect(simpleCommandWords(`node -e 'process.exit(0)'`)).toEqual([
      "node",
      "-e",
      "process.exit(0)",
    ]);
    expect(simpleCommandWords(`psql -c "select 1" mydb`)).toEqual([
      "psql",
      "-c",
      "select 1",
      "mydb",
    ]);
    // The run token is a plain word.
    expect(simpleCommandWords("seed --tag __CAIRN_RUN_TOKEN__")).toEqual([
      "seed",
      "--tag",
      "__CAIRN_RUN_TOKEN__",
    ]);
  });

  it("runs a word holding an env / secret value through the shell, like cairn run", () => {
    // `cairn run` substitutes the value into the command text: an empty
    // value drops the word, a value with spaces splits, a glob expands.
    expect(
      simpleCommandWords("deploy --token __CAIRN_SECRET_REF__API_TOKEN__"),
    ).toBeUndefined();
    expect(
      simpleCommandWords(`tool ${envDefaultSentinel("ARGS", "--a --b")}`),
    ).toBeUndefined();
    expect(
      lateEnvNamesOf(
        `seed __CAIRN_SECRET_REF__SEED_TOKEN__ ${envDefaultSentinel("MODE", "x-__CAIRN_SECRET_REF__INNER__")}`,
        { API_KEY: "__CAIRN_SECRET_REF__API_KEY__", plain: 1 },
      ),
    ).toEqual(["API_KEY", "INNER", "MODE", "SEED_TOKEN"]);
  });

  it("needs the shell for pipes, lists, redirection, expansion, assignments and builtins", () => {
    for (const command of [
      "a | b",
      "a && b",
      "a; b",
      "a > out.txt",
      "a < in.txt",
      "echo $HOME",
      "echo `date`",
      "echo $(date)",
      "ls *.ts",
      "FOO=1 run",
      "cd dir",
      "export X=1",
      "a & b",
      "run ${runs.seeded.id}",
      'echo "a $B"',
      "echo \\x",
      "line one\nline two",
      "unterminated 'quote",
      "",
    ]) {
      expect(simpleCommandWords(command), command).toBeUndefined();
    }
  });
});

describe.skipIf(process.platform === "win32")("cairnCommand runtime", () => {
  it("spawns an argv without a shell, so placeholder text is never interpreted", async () => {
    const { module, dir } = await loadModule();
    const hostile = "$HOME; echo pwned `id`";
    const out = await module.cairnCommand(
      {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(process.argv[1])",
          hostile,
        ],
      },
      { cwd: dir, timeoutMs: 20_000, capture: true },
    );
    expect(out).toBe(hostile);
  });

  it("runs a shell command through /bin/sh with args as $1..$n", async () => {
    const { module, dir } = await loadModule();
    const out = await module.cairnCommand(`echo "$1-$2"`, {
      cwd: dir,
      timeoutMs: 20_000,
      args: ["a", "b c"],
      capture: true,
    });
    expect(out.trim()).toBe("a-b c");
  });

  it("returns nothing unless capture is set", async () => {
    const { module, dir } = await loadModule();
    expect(
      await module.cairnCommand(`echo hello`, { cwd: dir, timeoutMs: 20_000 }),
    ).toBe("");
  });

  it("rejects with the label and the output tail, never the command text", async () => {
    const { module, dir } = await loadModule();
    const error = await module
      .cairnCommand(`echo visible-output >&2; exit 3 # TOPSECRETCOMMANDTEXT`, {
        cwd: dir,
        timeoutMs: 20_000,
        label: "Precondition 1",
      })
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Precondition 1 failed with exit 3");
    expect(message).toContain("visible-output");
    expect(message).not.toContain("TOPSECRETCOMMANDTEXT");
  });

  it("scrubs secret values from the output tail before cutting it", async () => {
    const { module, dir } = await loadModule();
    const read = ["late", "Read", "Value", "91"].join("");
    const named = ["named", "Credential", "Value", "37"].join("");
    const saved = {
      EXPORT_READ_VALUE: process.env["EXPORT_READ_VALUE"],
      EXPORT_API_TOKEN: process.env["EXPORT_API_TOKEN"],
    };
    process.env["EXPORT_READ_VALUE"] = read;
    process.env["EXPORT_API_TOKEN"] = named;
    try {
      // The secret straddles where a 2000-character tail would be cut.
      const pad = "x".repeat(1990);
      const error = await module
        .cairnCommand(
          `printf '%s' "$1"; printf '%s\\n' "${pad}"; echo "token $2"; echo "read $1"; exit 4`,
          {
            cwd: dir,
            timeoutMs: 20_000,
            label: "Precondition 1",
            args: [read, named],
            redact: ["EXPORT_READ_VALUE"],
          },
        )
        .catch((e: Error) => e);
      const message = (error as Error).message;
      expect(message).toContain("Precondition 1 failed with exit 4");
      expect(message).toContain("token [redacted]");
      expect(message).toContain("read [redacted]");
      for (const secret of [read, named]) {
        for (const piece of [secret, secret.slice(0, 8), secret.slice(-8)]) {
          expect(message).not.toContain(piece);
        }
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("keeps the last stdout line of a large capture (settles once drained)", async () => {
    const { module, dir } = await loadModule();
    const out = await module.cairnCommand(
      `head -c 3000000 /dev/zero | tr '\\0' a; echo; echo '{"ok":true}'`,
      { cwd: dir, timeoutMs: 20_000, capture: true },
    );
    expect(out.trim().split("\n").at(-1)).toBe('{"ok":true}');
    expect(module.cairnLastJson(out, "run")).toEqual({ ok: true });
  });

  it("settles shortly after the exit when a grandchild keeps the pipes open", async () => {
    const { module, dir } = await loadModule();
    const started = Date.now();
    const out = await module.cairnCommand(`(sleep 5 &) ; echo done`, {
      cwd: dir,
      timeoutMs: 20_000,
      capture: true,
    });
    expect(out.trim()).toBe("done");
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("layers context under env and filters control credentials", async () => {
    const { module, dir } = await loadModule();
    const out = await module.cairnCommand(
      {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write([process.env.CAIRN_RUN_TOKEN, process.env.WHO, String(process.env.FILECHEAP_INGEST_TOKEN)].join(','))",
        ],
      },
      {
        cwd: dir,
        timeoutMs: 20_000,
        capture: true,
        context: { CAIRN_RUN_TOKEN: "ctx-token", WHO: "context" },
        env: { WHO: "override", FILECHEAP_INGEST_TOKEN: "publisher-only" },
      },
    );
    expect(out).toBe("ctx-token,override,undefined");
  });

  it("fails fast when the cwd does not exist, naming CAIRN_PROJECT_ROOT", async () => {
    const { module, dir } = await loadModule();
    await expect(
      module.cairnCommand("true", {
        cwd: join(dir, "missing"),
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/CAIRN_PROJECT_ROOT/);
  });

  it("kills the whole owned tree at the deadline", async () => {
    const { module, dir } = await loadModule();
    const pidFile = join(dir, "child.pid");
    await expect(
      module.cairnCommand(
        `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`,
        {
          cwd: dir,
          timeoutMs: 150,
          label: "Command",
        },
      ),
    ).rejects.toThrow(/timed out after 150ms; killed \d+ process/);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(pid)).toBe(true);
    // The background child must be gone shortly after.
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("keeps runPrecondition as a labelled cairnCommand", async () => {
    const { module, dir } = await loadModule();
    await expect(
      module.runPrecondition("exit 5", { cwd: dir, timeoutMs: 20_000 }),
    ).rejects.toThrow(/Precondition failed with exit 5/);
  });
});

describe("cairnLastJson (the run.assign contract)", () => {
  it("parses the last non-empty stdout line", async () => {
    const { module } = await loadModule();
    expect(module.cairnLastJson('log line\n{"id":7}\n\n', "run x")).toEqual({
      id: 7,
    });
    expect(module.cairnLastJson("[1,2]", "run x")).toEqual([1, 2]);
  });

  it("fails with a message that never echoes the output", async () => {
    const { module } = await loadModule();
    expect(() => module.cairnLastJson("   \n", "run x")).toThrow(
      /run x: assign: the command printed nothing on stdout/,
    );
    try {
      module.cairnLastJson("not-json-SECRETLINE", "run x");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe(
        "run x: assign: the last stdout line is not JSON",
      );
    }
  });
});

describe("cairnTestContext", () => {
  it("builds the CAIRN_* run context from the running test", async () => {
    const { module } = await loadModule();
    const info = {
      project: { use: { baseURL: "http://localhost:3000" } },
      outputDir: "/tmp/out/test-1",
    };
    expect(module.cairnTestContext(info, "tok", "failed")).toEqual({
      CAIRN_RUN_DIR: "/tmp/out/test-1/cairn-run",
      CAIRN_RUN_TOKEN: "tok",
      CAIRN_BASE_URL: "http://localhost:3000",
      CAIRN_RUN_STATUS: "failed",
    });
    expect(
      module.cairnTestContext({ project: { use: {} }, outputDir: "/o" }),
    ).toEqual({ CAIRN_RUN_DIR: "/o/cairn-run" });
  });
});
