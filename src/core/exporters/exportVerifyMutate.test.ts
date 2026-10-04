import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  findOutcomeBlocks,
  findStepCalls,
  matchBracket,
  mutantFileName,
  mutateOutcome,
  OUTCOMES_MARKER,
  outcomeStepIds,
} from "./exportVerifyMutate";

const TEST_SOURCE = `import { expect, test } from "@playwright/test";

test("sample", async ({ page }) => {
  // --- steps ---
  await test.step("open_home", async () => {
    await page.goto("/");
  });

  // --- outcomes (the contract) ---
  await test.step("greeting_visible", async () => {
    await expect(page.locator("body")).toContainText("Hello {world} /x/ \\"q\\"", { ignoreCase: true, useInnerText: true });
  });

  await test.step("on_home", async () => {
    await expect(page).toHaveURL(new RegExp("/$"));
  });

  await test.step("polled", async () => {
    await expect.poll(async () => (await page.locator("body").innerText()).replace(/\\s+/g, " ").includes("hi"), { timeout: 5000 }).toBe(true);
  });

  await test.step("already_negated", async () => {
    await expect(page.locator("body")).not.toContainText("Error");
  });

  await test.step("retried", async () => {
    await expect(async () => {
      expect(await page.locator("li").count()).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 3000 });
  });

  await test.step("judged", async () => {
    cairnAssertValue(1, { equals: 1 }, "x");
  });

  await test.step("template", async () => {
    await expect(page.locator("body")).toContainText(\`Product \${"}"} created: \${RUN_TOKEN}\`);
  });
});
`;

const ids = [
  "greeting_visible",
  "on_home",
  "polled",
  "already_negated",
  "retried",
  "judged",
  "template",
];

function mutate(id: string) {
  const blocks = findOutcomeBlocks(TEST_SOURCE, ids);
  const block = blocks.find((b) => b.id === id);
  expect(block, `block ${id}`).toBeDefined();
  return mutateOutcome(TEST_SOURCE, block!);
}

describe("exportVerifyMutate", () => {
  it("finds every outcome step block, skipping braces inside strings and regexes", () => {
    const blocks = findOutcomeBlocks(TEST_SOURCE, ids);
    expect(blocks.map((b) => b.id)).toEqual(ids);
    for (const block of blocks) {
      expect(TEST_SOURCE[block.bodyEnd]).toBe("}");
      expect(TEST_SOURCE.slice(block.bodyStart, block.bodyEnd)).not.toContain(
        "test.step(",
      );
    }
  });

  it("does not find an outcome that has no step", () => {
    expect(findOutcomeBlocks(TEST_SOURCE, ["missing"])).toEqual([]);
  });

  it("inverts a text matcher with .not", () => {
    const result = mutate("greeting_visible");
    expect(result).toMatchObject({
      applicable: true,
      operator: "toContainText -> not.toContainText",
    });
    if (result.applicable) {
      expect(result.source).toContain(
        'await expect(page.locator("body")).not.toContainText("Hello {world}',
      );
      // only the one assertion changed
      expect(result.source.replace(".not", "")).toBe(TEST_SOURCE);
    }
  });

  it("inverts a url matcher", () => {
    const result = mutate("on_home");
    expect(result).toMatchObject({
      applicable: true,
      operator: "toHaveURL -> not.toHaveURL",
    });
    if (result.applicable) {
      expect(result.source).toContain("await expect(page).not.toHaveURL(");
    }
  });

  it("inverts an expect.poll chain after the whole call, regex literal included", () => {
    const result = mutate("polled");
    expect(result).toMatchObject({
      applicable: true,
      operator: "toBe -> not.toBe",
    });
    if (result.applicable) {
      expect(result.source).toContain(".not.toBe(true);");
    }
  });

  it("removes an existing .not", () => {
    const result = mutate("already_negated");
    expect(result).toMatchObject({
      applicable: true,
      operator: "not.toContainText -> toContainText",
    });
    if (result.applicable) {
      expect(result.source).toContain(
        'await expect(page.locator("body")).toContainText("Error");',
      );
    }
  });

  it("skips the toPass wrapper and inverts the assertion inside it", () => {
    const result = mutate("retried");
    expect(result).toMatchObject({
      applicable: true,
      operator: "toBeGreaterThanOrEqual -> not.toBeGreaterThanOrEqual",
    });
    if (result.applicable) {
      expect(result.source).toContain(
        'expect(await page.locator("li").count()).not.toBeGreaterThanOrEqual(2);',
      );
      expect(result.source).toContain(".toPass({ timeout: 3000 })");
    }
  });

  it("reports an outcome judged by a throwing helper as not applicable", () => {
    const result = mutate("judged");
    expect(result.applicable).toBe(false);
    if (!result.applicable) expect(result.reason).toContain("helper");
  });

  it("handles template literals with braces and interpolations", () => {
    const result = mutate("template");
    expect(result).toMatchObject({ applicable: true });
    if (result.applicable) {
      expect(result.source).toContain(".not.toContainText(`Product ${");
    }
  });

  it("matches brackets across nested literals", () => {
    const source = `f("a)", \`b\${"}"}\`, /[)]/, [1, {x: ")"}])`;
    expect(matchBracket(source, 1)).toBe(source.length - 1);
  });

  it("keeps the test-match suffix in the mutant file name", () => {
    expect(mutantFileName("login.spec.ts")).toBe(
      "login-cairn-verify-mutant.spec.ts",
    );
    expect(mutantFileName("login.e2e.ts")).toBe(
      "login-cairn-verify-mutant.e2e.ts",
    );
  });
});

/* A host's prettier rewrote the test: single quotes, calls over lines. */
const PRETTIER_SOURCE = `import { expect, test } from '@playwright/test';

test('sample', async ({ page }) => {
  // --- steps ---
  await test.step('open_home', async () => {
    await page.goto('/');
  });

  // --- outcomes (the contract) ---
  await test.step('greeting_visible', async () => {
    await expect(page.locator('body')).toContainText('Hello', {
      ignoreCase: true,
    });
  });

  await test.step(
    'a_very_long_outcome_identifier_that_prettier_breaks_over_several_lines',
    async () => {
      await expect(page).toHaveURL(
        new RegExp('/$'),
      );
    },
  );

  await test.step('stays_done', async () => {
    await cairnPoll(
      async () => {
        // one instantaneous sample, like cairn run: each assertion checks once (no auto-retry)
        const cairnSampleExpect = expect.configure({ timeout: 1 });
        await cairnSampleExpect(page.locator('body')).toContainText('Done');
      },
      { timeoutMs: 10000, everyMs: 1000, stableMs: 2000 },
    );
  });

  await test.step('teardown: cleanup', async () => {});
});
`;

describe("exportVerifyMutate on a reformatted test (syntax tree)", () => {
  const LONG =
    "a_very_long_outcome_identifier_that_prettier_breaks_over_several_lines";

  it("reads the step calls whatever the quotes and line breaks", () => {
    const calls = findStepCalls(ts, PRETTIER_SOURCE);
    expect(calls.map((call) => call.id)).toEqual([
      "open_home",
      "greeting_visible",
      LONG,
      "stays_done",
      "teardown: cleanup",
    ]);
    // After the contract marker, never teardown steps…
    expect(outcomeStepIds(calls, PRETTIER_SOURCE)).toEqual([
      "greeting_visible",
      LONG,
      "stays_done",
    ]);
    // …or exactly the spec's outcome ids, marker or not.
    expect(
      outcomeStepIds(calls, PRETTIER_SOURCE.replace(OUTCOMES_MARKER, ""), [
        "stays_done",
        "greeting_visible",
      ]),
    ).toEqual(["greeting_visible", "stays_done"]);
  });

  it("finds and inverts the assertion of each outcome block", () => {
    const blocks = findOutcomeBlocks(
      PRETTIER_SOURCE,
      ["greeting_visible", LONG, "stays_done"],
      ts,
    );
    expect(blocks.map((b) => b.id)).toEqual([
      "greeting_visible",
      LONG,
      "stays_done",
    ]);
    const long = mutateOutcome(PRETTIER_SOURCE, blocks[1]!);
    expect(long).toMatchObject({
      applicable: true,
      operator: "toHaveURL -> not.toHaveURL",
    });
    // A poll sample's non-retrying expect is an assertion too.
    const polled = mutateOutcome(PRETTIER_SOURCE, blocks[2]!);
    expect(polled).toMatchObject({
      applicable: true,
      operator: "toContainText -> not.toContainText",
    });
    if (polled.applicable) {
      expect(polled.source).toContain(
        "await cairnSampleExpect(page.locator('body')).not.toContainText('Done');",
      );
    }
    // The text scanner alone would find none of them in this source.
    expect(findOutcomeBlocks(PRETTIER_SOURCE, [LONG])).toEqual([]);
  });
});
