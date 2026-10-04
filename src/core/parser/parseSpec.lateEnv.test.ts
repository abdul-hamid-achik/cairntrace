import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSpecRuntimeContext } from "../config/runtimeContext";
import { parseSpec } from "./parseSpec";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function specFile(steps: string, vars = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-late-env-"));
  dirs.push(dir);
  const path = join(dir, "s.yml");
  await writeFile(
    path,
    `version: 1
name: late_env
intent: exporters late-bind the environment
${vars}outcomes:
  - id: o
    description: d
    verify: { text: { contains: x } }
steps:
${steps}`,
  );
  return path;
}

const secretRef = (name: string): string => `REF(${name})`;
const envDefaultRef = (name: string, fallback: string): string =>
  `DEFAULT(${name}|${fallback})`;
const open = async (path: string, opts: Parameters<typeof parseSpec>[1]) =>
  (await parseSpec(path, opts)).resolved.steps!.map(
    (step) => (step as { open: string }).open,
  );

describe("parseSpec: exporter late binding of ${env.X}", () => {
  it("without the options nothing changes: a set variable and a default are resolved", async () => {
    const path = await specFile(`  - open: "/a?x=\${env.A}&y=\${env.B:-d}"\n`);
    expect(await open(path, { env: { A: "set" } })).toEqual(["/a?x=set&y=d"]);
    expect(await open(path, { env: { A: "set" }, secretRef })).toEqual([
      "/a?x=set&y=d",
    ]);
  });

  it("lateEnv keeps a plain ${env.X} late-bound even when it is set", async () => {
    const path = await specFile(`  - open: "/a?x=\${env.A}&s=\${secrets.S}"\n`);
    expect(
      await open(path, {
        env: { A: "set", S: "shh" },
        secretRef,
        lateEnv: true,
      }),
    ).toEqual(["/a?x=REF(A)&s=REF(S)"]);
  });

  it("envDefaultRef receives the variable and the already-substituted default", async () => {
    const path = await specFile(
      `  - open: "/a?r=\${env.R:-eu-\${vars.zone}}&t=\${env.T:-x-\${run.token}}"\n`,
      `vars:\n  zone: z1\n`,
    );
    expect(
      await open(path, {
        env: { R: "set" },
        secretRef,
        envDefaultRef,
        lateEnv: true,
        runtime: { runToken: "TOK" },
      }),
    ).toEqual(["/a?r=DEFAULT(R|eu-z1)&t=DEFAULT(T|x-TOK)"]);
  });

  it("envDefaultRef alone (no lateEnv) still binds a default but bakes a plain variable", async () => {
    const path = await specFile(`  - open: "/a?x=\${env.A}&y=\${env.B:-d}"\n`);
    expect(
      await open(path, { env: { A: "set" }, secretRef, envDefaultRef }),
    ).toEqual(["/a?x=set&y=DEFAULT(B|d)"]);
  });

  it("without secretRef the options are inert (cairn run is unaffected)", async () => {
    const path = await specFile(`  - open: "/a?y=\${env.B:-d}"\n`);
    expect(await open(path, { env: {}, envDefaultRef, lateEnv: true })).toEqual(
      ["/a?y=d"],
    );
  });
});

describe("resolveSpecRuntimeContext: a spec's own vars read ${env.X[:-default]} late too", () => {
  it("binds the default and keeps a set variable out of the vars", async () => {
    const path = await specFile(
      `  - open: "/a"\n`,
      `vars:\n  region: "\${env.REGION:-eu}"\n  token: "\${env.TOKEN}"\n  plain: fixed\n`,
    );
    const late = await resolveSpecRuntimeContext(path, {
      env: { REGION: "us", TOKEN: "set-token" },
      envRef: secretRef,
      envDefaultRef,
      lateEnv: true,
    });
    expect(late.vars).toMatchObject({
      region: "DEFAULT(REGION|eu)",
      token: "REF(TOKEN)",
      plain: "fixed",
    });
    const plain = await resolveSpecRuntimeContext(path, {
      env: { REGION: "us", TOKEN: "set-token" },
    });
    expect(plain.vars).toMatchObject({ region: "us", token: "set-token" });
  });
});
