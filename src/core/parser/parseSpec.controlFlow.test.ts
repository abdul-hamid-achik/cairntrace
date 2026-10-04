import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRetryUseStep, type Step } from "../schema/spec.v1";
import { stepFileScopeAt } from "../runner/stepFiles";
import { BatchSelectorLocatorError, parseSpec } from "./parseSpec";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cairntrace-parse-f14-"));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
}

const SPEC_HEAD = `version: 1
name: nested
intent: nested control flow
outcomes:
  - id: o
    description: d
    verify: { console: { errorsMax: 0 } }
`;

describe("parseSpec — F14 nested steps", () => {
  it("inlines use: inside repeat / if, keeps a retried use as one group, and records nested origins", async () => {
    const dir = await project({
      "flows/spec.yml": `${SPEC_HEAD}imports: [../actions/pick.yml]
vars:
  mode: fast
steps:
  - id: start
    open: /start
  - id: loop
    repeat:
      max: 2
      until: { var: mode, equals: fast }
      steps:
        - use: { action: pick, vars: { size: large } }
        - id: after_pick
          open: /next
  - id: gate
    if:
      condition: { var: mode, in: [fast] }
      then:
        - use: pick
  - id: retried
    use: { action: pick, retry: { times: 1 } }
`,
      "actions/pick.yml": `version: 1
name: pick
vars:
  size: small
steps:
  - id: pick_size
    when: { var: size, equals: large }
    upload: { by: selector, selector: "#file", path: ./fixtures/a.txt }
`,
      "actions/fixtures/a.txt": "a",
    });
    const parsed = await parseSpec(join(dir, "flows/spec.yml"), {
      baseUrl: "http://app.test",
    });
    const steps = parsed.resolved.steps!;
    expect(steps.map((step) => step.id)).toEqual([
      "start",
      "loop",
      "gate",
      "retried",
    ]);
    expect(parsed.origins).toHaveLength(4);

    const loop = steps[1] as Extract<Step, { repeat: unknown }>;
    // The nested use was inlined; baseUrl reaches nested opens.
    expect(loop.repeat.steps.map((step) => step.id)).toEqual([
      "pick_size",
      "after_pick",
    ]);
    expect(loop.repeat.steps[1]).toMatchObject({
      open: "http://app.test/next",
    });
    // Var predicates carry the declaring scope's value.
    expect(loop.repeat.until).toEqual({
      var: "mode",
      equals: "fast",
      resolved: "fast",
    });
    expect(loop.repeat.steps[0]!.when).toMatchObject({
      var: "size",
      resolved: "large",
    });
    const gate = steps[2] as Extract<Step, { if: unknown }>;
    expect(gate.if.then[0]!.when).toMatchObject({ resolved: "small" });

    const retried = steps[3]!;
    expect(isRetryUseStep(retried)).toBe(true);
    expect(isRetryUseStep(retried) && retried.steps.map((s) => s.id)).toEqual([
      "pick_size",
    ]);

    // Nested origins point at the innermost declaring file.
    const actionPath = join(dir, "actions/pick.yml");
    expect(parsed.nestedOrigins?.get("1/steps/0")).toMatchObject({
      filePath: actionPath,
      fileStepIdx: 0,
    });
    expect(parsed.nestedOrigins?.get("1/steps/1")).toMatchObject({
      filePath: join(dir, "flows/spec.yml"),
    });
    expect(parsed.nestedOrigins?.get("2/then/0")?.filePath).toBe(actionPath);
    expect(parsed.nestedOrigins?.get("3/use/0")?.filePath).toBe(actionPath);
    // …so a nested step's relative files resolve against its action.
    expect(stepFileScopeAt(parsed, "1/steps/0").declaringDir).toBe(
      join(dir, "actions"),
    );

    // The spec as written keeps the use: placeholders.
    const raw = parsed.spec.steps![1] as Extract<Step, { repeat: unknown }>;
    expect(raw.repeat.steps[0]).toHaveProperty("use");
  });

  it("does not resolve dotted runtime vars at parse time and refuses an authored resolved", async () => {
    const dir = await project({
      "spec.yml": `${SPEC_HEAD}steps:
  - id: a
    when: { var: waits.banner.matched, equals: true }
    open: /a
  - id: b
    when: { var: missing, exists: false }
    open: /b
`,
      "forged.yml": `${SPEC_HEAD}steps:
  - id: loop
    repeat:
      max: 2
      steps:
        - id: b
          when: { var: waits.banner.matched, equals: "true", resolved: "true" }
          open: /b
`,
    });
    const parsed = await parseSpec(join(dir, "spec.yml"));
    expect(parsed.resolved.steps![0]!.when).toEqual({
      var: "waits.banner.matched",
      equals: true,
    });
    expect(parsed.resolved.steps![1]!.when).toEqual({
      var: "missing",
      exists: false,
    });
    await expect(parseSpec(join(dir, "forged.yml"))).rejects.toThrow(
      /steps\[0\]\.repeat\.steps\[0\]\.when\.resolved .* is set by the parser/,
    );
  });

  it("applies the batch selector-only rule inside control-flow blocks", async () => {
    const dir = await project({
      "spec.yml": `${SPEC_HEAD}steps:
  - repeat:
      max: 2
      steps:
        - batch:
            - hover: { by: role, role: row, name: Acme }
            - click: { by: selector, selector: ".edit" }
`,
    });
    await expect(parseSpec(join(dir, "spec.yml"))).rejects.toBeInstanceOf(
      BatchSelectorLocatorError,
    );
  });
});
