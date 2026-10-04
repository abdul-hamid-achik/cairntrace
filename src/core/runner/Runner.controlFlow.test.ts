import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { InvocationResult } from "../../adapters/browserBackend";
import { healSpec } from "../healer/Healer";
import { RunEventSchema, type RunEvent } from "../schema/events.v1";
import { RunResultSchema, type StepResult } from "../schema/run.v1";
import type { Step } from "../schema/spec.v1";
import { runSpec, type ProgressListener } from "./Runner";

/**
 * Mock backend whose page reacts to steps: `react(step, backend)` runs after
 * each dispatched step, so a click can reveal copy a later `until` reads.
 */
class ReactiveBackend extends MockBrowserBackend {
  clicks = 0;
  constructor(
    private readonly react: (
      step: Step,
      backend: ReactiveBackend,
    ) => void = () => undefined,
  ) {
    super();
  }
  override async runStep(step: Step): Promise<InvocationResult> {
    const result = await super.runStep(step);
    if ("click" in step) this.clicks += 1;
    this.react(step, this);
    return result;
  }
}

async function project(
  spec: string,
  files: Record<string, string> = {},
): Promise<{ dir: string; specPath: string; artifactRoot: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cairntrace-control-flow-"));
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    "version: 1\nenvironments:\n  local: {}\n",
  );
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  const specPath = join(dir, "flow.yml");
  await writeFile(specPath, spec);
  return { dir, specPath, artifactRoot: join(dir, "runs") };
}

async function events(runDir: string): Promise<RunEvent[]> {
  return (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
}

async function runJson(runDir: string) {
  return RunResultSchema.parse(
    JSON.parse(await readFile(join(runDir, "run.json"), "utf8")),
  );
}

const header = (name: string, extra = "") => `version: 1
name: ${name}
intent: control flow ${name}
coldStart: guest
${extra}outcomes:
  - id: no_errors
    description: no console errors
    verify: { console: { errorsMax: 0 } }
`;

function clicked(backend: MockBrowserBackend): string[] {
  return backend.stepLog
    .filter(
      (step): step is Extract<Step, { click: unknown }> => "click" in step,
    )
    .map((step) => {
      const target = step.click as { selector?: string; name?: string };
      return target.selector ?? target.name ?? "";
    });
}

function ids(steps: StepResult[]): string[] {
  return steps.map((step) =>
    step.iteration !== undefined ? `${step.id}#${step.iteration}` : step.id,
  );
}

describe("repeat", () => {
  it("stops as soon as until holds, splices ${repeat.*}, and records nested steps post-order", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("repeat_until")}steps:
  - id: open_list
    open: /list
  - id: load_more
    repeat:
      max: 5
      indexVar: page
      until: { text: "All rows loaded" }
      steps:
        - click: { by: selector, selector: "#more-\${repeat.index}-\${repeat.iteration}-\${repeat.page}" }
`,
    );
    const backend = new ReactiveBackend((step, b) => {
      if ("click" in step && b.clicks === 3) b.setPageText("All rows loaded");
    });
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(clicked(backend)).toEqual([
      "#more-0-1-0",
      "#more-1-2-1",
      "#more-2-3-2",
    ]);

    const run = await runJson(result.runDir);
    expect(ids(run.steps)).toEqual([
      "open_list",
      "load_more.1#1",
      "load_more.1#2",
      "load_more.1#3",
      "load_more",
    ]);
    const loop = run.steps.find((step) => step.id === "load_more")!;
    expect(loop).toMatchObject({ status: "passed", iterations: 3 });
    expect(loop.parentId).toBeUndefined();
    expect(run.steps[1]).toMatchObject({
      parentId: "load_more",
      iteration: 1,
      status: "passed",
    });

    const started = (await events(result.runDir)).filter(
      (event) => event.type === "step.started",
    );
    expect(
      started.map((event) => ({
        stepId: event.stepId,
        parentId: "parentId" in event ? event.parentId : undefined,
        iteration: "iteration" in event ? event.iteration : undefined,
        kind: "kind" in event ? event.kind : undefined,
      })),
    ).toEqual([
      {
        stepId: "open_list",
        parentId: undefined,
        iteration: undefined,
        kind: "open",
      },
      {
        stepId: "load_more",
        parentId: undefined,
        iteration: undefined,
        kind: "repeat",
      },
      {
        stepId: "load_more.1",
        parentId: "load_more",
        iteration: 1,
        kind: "click",
      },
      {
        stepId: "load_more.1",
        parentId: "load_more",
        iteration: 2,
        kind: "click",
      },
      {
        stepId: "load_more.1",
        parentId: "load_more",
        iteration: 3,
        kind: "click",
      },
    ]);
    const finished = (await events(result.runDir)).find(
      (event) => event.type === "step.finished" && event.stepId === "load_more",
    );
    expect(finished).toMatchObject({ iterations: 3 });
    // Reports name each execution.
    const markdown = await readFile(join(result.runDir, "run.md"), "utf8");
    expect(markdown).toContain("load_more.1 #2");
    expect(markdown).toContain("load_more ×3");
    const report = await readFile(join(result.runDir, "report.html"), "utf8");
    expect(report).toContain("load_more.1 #3");
  });

  it("checks until before the first iteration (zero iterations when it already holds)", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("repeat_already")}steps:
  - id: loop
    repeat:
      max: 3
      until: "text:Ready"
      steps:
        - click: { by: selector, selector: "#go" }
`,
    );
    const backend = new ReactiveBackend();
    backend.setPageText("Ready");
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(clicked(backend)).toEqual([]);
    expect((await runJson(result.runDir)).steps).toEqual([
      expect.objectContaining({ id: "loop", iterations: 0 }),
    ]);
  });

  it("fails when max is reached and until never held (onMax: fail, the default)", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("repeat_max")}steps:
  - id: poll
    repeat:
      max: 2
      until: { text: "Done" }
      steps:
        - click: { by: selector, selector: "#refresh" }
  - id: after
    click: { by: selector, selector: "#after" }
`,
    );
    const backend = new ReactiveBackend();
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    expect(clicked(backend)).toEqual(["#refresh", "#refresh"]);
    expect(result.failure?.step).toBe("poll");
    expect(result.failure?.message).toContain(
      "did not hold after 2 iteration(s)",
    );
    const run = await runJson(result.runDir);
    expect(run.steps.at(-1)).toMatchObject({
      id: "poll",
      status: "failed",
      iterations: 2,
    });
    expect(run.steps.some((step) => step.id === "after")).toBe(false);
  });

  it("passes at max with onMax: continue, and runs exactly max times without until", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("repeat_continue")}steps:
  - id: soft
    repeat:
      max: 2
      until: { text: "Done" }
      onMax: continue
      steps:
        - click: { by: selector, selector: "#soft" }
  - id: fixed
    repeat:
      max: 3
      steps:
        - click: { by: selector, selector: "#fixed-\${repeat.iteration}" }
`,
    );
    const backend = new ReactiveBackend();
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(clicked(backend)).toEqual([
      "#soft",
      "#soft",
      "#fixed-1",
      "#fixed-2",
      "#fixed-3",
    ]);
  });

  it("keeps unassigned nested requests apart: one file and binding per place and iteration", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("nested_requests")}steps:
  - id: loop
    repeat:
      max: 2
      steps:
        - request: { method: GET, url: "http://app.test/api/first" }
        - request: { method: GET, url: "http://app.test/api/second" }
  - id: branch
    if:
      condition: { urlNotContains: /never }
      then:
        - request: { method: GET, url: "http://app.test/api/then-a" }
        - request: { method: GET, url: "http://app.test/api/then-b" }
  - request: { method: GET, url: "http://app.test/api/top" }
`,
    );
    const backend = new ReactiveBackend();
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(backend.requestLog).toHaveLength(7);
    const files = (await readdir(join(result.runDir, "requests"))).toSorted();
    expect(files).toEqual([
      "request_1_1_i1.json",
      "request_1_1_i2.json",
      "request_1_2_i1.json",
      "request_1_2_i2.json",
      "request_2_then1.json",
      "request_2_then2.json",
      "request_3.json",
    ]);
    const second = JSON.parse(
      await readFile(
        join(result.runDir, "requests", "request_2_then2.json"),
        "utf8",
      ),
    ) as { url: string };
    expect(second.url).toBe("http://app.test/api/then-b");
  });

  it("fails the repeat and the run on a failing nested step", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("repeat_child_fails")}artifacts:
  capture: { screenshots: always }
steps:
  - id: rows
    repeat:
      max: 3
      steps:
        - id: pick_row
          click: { by: selector, selector: "#row" }
`,
    );
    const backend = new ReactiveBackend((step, b) => {
      if ("click" in step && b.clicks === 1) b.failNextStep("row vanished");
    });
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    // The innermost failure is the run's failure (results are post-order).
    expect(result.failure?.step).toBe("pick_row");
    expect(result.failure?.message).toContain("row vanished");
    const run = await runJson(result.runDir);
    expect(ids(run.steps)).toEqual(["pick_row#1", "pick_row#2", "rows"]);
    expect(run.steps.at(-1)).toMatchObject({ id: "rows", status: "failed" });
    expect(run.steps.at(-1)!.error).toContain(
      "repeat iteration 2/3: step 'pick_row' failed",
    );
    // One screenshot per execution: iterations never overwrite each other.
    const shots = (
      await readdir(join(result.runDir, "screenshots"))
    ).toSorted();
    expect(shots).toEqual(["001_pick_row_i1.png", "001_pick_row_i2.png"]);
  });
});

describe("if", () => {
  it("runs then or else and records the branch", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("if_branches")}steps:
  - id: banner
    if:
      condition: "text:Cookie banner"
      then:
        - click: { by: role, role: button, name: Accept }
      else:
        - click: { by: role, role: button, name: Continue }
  - id: only_then
    if:
      condition: { urlContains: /never }
      then:
        - click: { by: role, role: button, name: Never }
`,
    );
    const backend = new ReactiveBackend();
    backend.setPageText("Cookie banner shown");
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(clicked(backend)).toEqual(["Accept"]);
    const run = await runJson(result.runDir);
    expect(run.steps).toEqual([
      expect.objectContaining({
        id: "banner.then.1",
        parentId: "banner",
        branch: "then",
      }),
      expect.objectContaining({ id: "banner", taken: "then" }),
      expect.objectContaining({ id: "only_then", taken: "none" }),
    ]);

    backend.setPageText("nothing here");
    const second = await runSpec({ specPath, artifactRoot, backend });
    expect(second.status).toBe("passed");
    expect(clicked(backend).slice(1)).toEqual(["Continue"]);
    const started = (await events(second.runDir)).filter(
      (event) =>
        event.type === "step.started" && event.stepId === "banner.else.1",
    );
    expect(started).toEqual([
      expect.objectContaining({ parentId: "banner", branch: "else" }),
    ]);
  });

  it("nests repeat and if: branches per iteration with a repeat var predicate", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("nested")}steps:
  - id: rows
    repeat:
      max: 3
      steps:
        - id: odd_even
          if:
            condition: { var: repeat.index, in: [0, 2] }
            then:
              - click: { by: selector, selector: "#even-\${repeat.index}" }
            else:
              - click: { by: selector, selector: "#odd-\${repeat.index}" }
`,
    );
    const backend = new ReactiveBackend();
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(clicked(backend)).toEqual(["#even-0", "#odd-1", "#even-2"]);
    const run = await runJson(result.runDir);
    expect(ids(run.steps)).toEqual([
      "odd_even.then.1#1",
      "odd_even#1",
      "odd_even.else.1#2",
      "odd_even#2",
      "odd_even.then.1#3",
      "odd_even#3",
      "rows",
    ]);
    expect(run.steps[0]).toMatchObject({
      parentId: "odd_even",
      branch: "then",
    });
    expect(run.steps[1]).toMatchObject({ parentId: "rows", taken: "then" });
  });
});

describe("when: var predicates", () => {
  it("reads spec, CLI and use-site vars (equals / in / exists)", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("when_var", "imports: [actions/pick.yml]\nvars:\n  mode: fast\n")}steps:
  - id: fast_only
    when: { var: mode, equals: fast }
    click: { by: selector, selector: "#fast" }
  - id: slow_only
    when: { var: mode, equals: slow }
    click: { by: selector, selector: "#slow" }
  - id: region_known
    when: { var: region, in: [eu, us] }
    click: { by: selector, selector: "#region" }
  - id: flag_unset
    when: { var: featureFlag, exists: false }
    click: { by: selector, selector: "#no-flag" }
  - use: { action: pick, vars: { size: large } }
  - use: pick
`,
      {
        "actions/pick.yml": `version: 1
name: pick
vars:
  size: small
steps:
  - id: pick_large
    when: { var: size, equals: large }
    click: { by: selector, selector: "#large" }
  - id: pick_small
    when: { var: size, equals: small }
    click: { by: selector, selector: "#small" }
`,
      },
    );
    const backend = new ReactiveBackend();
    const result = await runSpec({
      specPath,
      artifactRoot,
      backend,
      vars: { region: "eu" },
    });
    expect(result.status).toBe("passed");
    expect(clicked(backend)).toEqual([
      "#fast",
      "#region",
      "#no-flag",
      "#large",
      "#small",
    ]);
    const finished = (await events(result.runDir)).find(
      (event) => event.type === "step.finished" && event.stepId === "slow_only",
    );
    // A skipped step's event records the predicate, never the var's value.
    expect(finished).toMatchObject({
      skipped: true,
      when: { var: "mode", equals: "slow" },
    });
    expect(JSON.stringify(finished)).not.toContain("resolved");
  });
});

describe("waits: any / all / optional", () => {
  it("wait.any records the first condition that held as ${waits.<name>.index}", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("wait_any")}steps:
  - id: outcome
    wait:
      any:
        - { text: "Saved" }
        - { text: "Already exists" }
      timeoutMs: 2000
      assign: result
  - id: branch_on_it
    if:
      condition: { var: waits.result.index, equals: 1 }
      then:
        - click: { by: selector, selector: "#dup-\${waits.result.index}-\${waits.result.matched}" }
`,
    );
    const backend = new ReactiveBackend();
    backend.setPageText("Item already exists");
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(clicked(backend)).toEqual(["#dup-1-true"]);
    const run = await runJson(result.runDir);
    expect(run.steps[0]).toMatchObject({ id: "outcome", matched: true });
  });

  it("an optional wait that never holds passes with matched=false", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("wait_optional")}steps:
  - id: maybe_banner
    wait: { text: "Maintenance", timeoutMs: 500, optional: true, assign: banner }
  - id: dismiss
    if:
      condition: { var: waits.banner.matched, equals: true }
      then:
        - click: { by: selector, selector: "#dismiss" }
      else:
        - click: { by: selector, selector: "#proceed-\${waits.banner.matched}" }
`,
    );
    const backend = new ReactiveBackend();
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(clicked(backend)).toEqual(["#proceed-false"]);
    const run = await runJson(result.runDir);
    expect(run.steps[0]).toMatchObject({
      id: "maybe_banner",
      status: "passed",
      matched: false,
    });
    const finished = (await events(result.runDir)).find(
      (event) =>
        event.type === "step.finished" && event.stepId === "maybe_banner",
    );
    expect(finished).toMatchObject({ matched: false });
    // Runner-polled: the optional wait never reached the backend.
    expect(backend.stepLog.some((step) => "wait" in step)).toBe(false);
  });

  it("a non-optional wait.any that misses fails with what it observed; wait.all needs every condition", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("wait_any_miss")}steps:
  - id: both
    wait:
      all:
        - { text: "Alpha" }
        - { url: { includes: /done } }
      timeoutMs: 1000
  - id: either
    wait:
      any:
        - { text: "Gamma" }
        - { notText: "Alpha" }
      timeoutMs: 1000
`,
    );
    const backend = new ReactiveBackend();
    backend.setPageText("Alpha and Beta");
    backend.setUrl("http://localhost/done");
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    expect(result.failure?.step).toBe("either");
    expect(result.failure?.message).toContain(
      "wait.any: none of 2 condition(s) held within 1000ms",
    );
    expect(result.failure?.message).toContain('text "Gamma"');
  });
});

describe("use retry", () => {
  const action = `version: 1
name: submit_form
steps:
  - id: press_submit
    click: { by: role, role: button, name: Submit }
`;

  it("retries a failing action and drops the failed attempt's results", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("retry_ok", "imports: [actions/submit.yml]\n")}steps:
  - id: submit
    use: { action: submit_form, retry: { times: 2 } }
`,
      { "actions/submit.yml": action },
    );
    const backend = new ReactiveBackend();
    backend.failNextStep("button detached");
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(clicked(backend)).toEqual(["Submit", "Submit"]);
    const run = await runJson(result.runDir);
    expect(run.steps).toEqual([
      expect.objectContaining({
        id: "press_submit",
        parentId: "submit",
        iteration: 2,
        status: "passed",
      }),
      expect.objectContaining({
        id: "submit",
        status: "passed",
        iterations: 2,
        retries: [
          {
            attempt: 1,
            error: expect.stringContaining("button detached"),
          },
        ],
      }),
    ]);
    // The retried failure stays visible in the events.
    const failed = (await events(result.runDir)).filter(
      (event) => event.type === "step.failed",
    );
    expect(failed).toEqual([
      expect.objectContaining({
        stepId: "press_submit",
        parentId: "submit",
        iteration: 1,
      }),
    ]);
  });

  it("fails after times + 1 attempts, and retries when until does not hold", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("retry_exhausted", "imports: [actions/submit.yml]\n")}steps:
  - id: submit
    use:
      action: submit_form
      retry: { times: 2, until: { text: "Thanks" } }
`,
      { "actions/submit.yml": action },
    );
    const backend = new ReactiveBackend();
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    expect(clicked(backend)).toEqual(["Submit", "Submit", "Submit"]);
    expect(result.failure?.step).toBe("submit");
    expect(result.failure?.message).toContain(
      "use submit_form: attempt 3/3 failed: until text:Thanks did not hold",
    );
    const run = await runJson(result.runDir);
    expect(run.steps.at(-1)).toMatchObject({
      id: "submit",
      status: "failed",
      iterations: 3,
    });
    expect(run.steps.at(-1)!.retries).toHaveLength(2);
  });

  it("stops as soon as until holds after an attempt", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("retry_until", "imports: [actions/submit.yml]\n")}steps:
  - id: submit
    use:
      action: submit_form
      retry: { times: 3, until: "text:Thanks" }
`,
      { "actions/submit.yml": action },
    );
    const backend = new ReactiveBackend((step, b) => {
      if ("click" in step && b.clicks === 2) b.setPageText("Thanks!");
    });
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(clicked(backend)).toEqual(["Submit", "Submit"]);
  });
});

describe("listener and heal", () => {
  it("tells listeners which steps are nested", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("listener")}steps:
  - id: loop
    repeat:
      max: 2
      steps:
        - click: { by: selector, selector: "#x" }
`,
    );
    const seen: string[] = [];
    const listener: ProgressListener = {
      onStepFinish(idx, stepId, status, _ms, _error, nested) {
        seen.push(
          `${idx}:${stepId}:${status}${
            nested ? `<${nested.parentId}#${nested.iteration}` : ""
          }`,
        );
      },
    };
    const result = await runSpec({
      specPath,
      artifactRoot,
      backend: new ReactiveBackend(),
      listener,
    });
    expect(result.status).toBe("passed");
    expect(seen).toEqual([
      "0:loop.1:passed<loop#1",
      "0:loop.1:passed<loop#2",
      "0:loop:passed",
    ]);
  });

  it("heal skips a failure nested in a control-flow block", async () => {
    const { specPath, artifactRoot } = await project(
      `${header("heal_nested")}steps:
  - id: open_page
    open: /page
  - id: guarded
    if:
      condition: "urlContains:/page"
      then:
        - id: press_go
          click: { by: role, role: button, name: Go }
`,
    );
    const backend = new ReactiveBackend((step, b) => {
      if ("open" in step) b.failNextStep("no element matches role=button Go");
    });
    const healed = await healSpec({ specPath, artifactRoot, backend });
    expect(healed.status).toBe("no-heal-possible");
    expect(healed.exitCode).toBe(5);
    expect(healed.summary).toContain(
      "failed inside control-flow block 'guarded'",
    );
  });
});
