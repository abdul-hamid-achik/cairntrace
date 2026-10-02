/**
 * Environment policy (lib/policy.js): the refusal rules Studio mirrors to
 * warn before Run. The CLI is the authority; these tests pin the contract
 * Studio warns against (requires.env / opt-in / mutates / protected).
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const policy = require("../lib/policy");

describe("policy: normalizing config and spec blocks", () => {
  it("keeps known policy words and drops guesses", () => {
    assert.deepEqual(
      policy.normalizePolicy({
        trait: "protected",
        mutations: "deny",
        description: "  shared  staging\n box ",
      }),
      {
        trait: "protected",
        mutations: "deny",
        description: "shared staging box",
      },
    );
    assert.deepEqual(policy.normalizePolicy({ trait: "nuclear" }), null);
    assert.deepEqual(
      policy.normalizePolicy({ mutations: "maybe", x: 1 }),
      null,
    );
    assert.equal(policy.normalizePolicy(null), null);
    assert.equal(policy.normalizePolicy(["owned"]), null);
    assert.deepEqual(policy.normalizePolicy({ mutations: "allow" }), {
      trait: null,
      mutations: "allow",
      description: null,
    });
  });

  it("reads requires.env names and opt-in entries", () => {
    assert.deepEqual(
      policy.normalizeRequires({
        env: ["local", { staging: { optIn: "ALLOW_STAGING" } }, { qa: {} }, 3],
        mutates: true,
      }),
      {
        env: [
          { name: "local", optIn: null },
          { name: "staging", optIn: "ALLOW_STAGING" },
          { name: "qa", optIn: null },
        ],
        mutates: true,
      },
    );
    assert.deepEqual(policy.normalizeRequires({ mutates: false }), {
      env: null,
      mutates: false,
    });
    assert.equal(policy.normalizeRequires({}), null);
    assert.equal(policy.normalizeRequires("local"), null);
    assert.deepEqual(policy.normalizeRequires({ env: [] }), {
      env: [],
      mutates: null,
    });
  });

  it("describes requires and policies for people", () => {
    assert.equal(
      policy.describeRequires(
        policy.normalizeRequires({
          env: ["local", { staging: { optIn: "ALLOW_STAGING" } }],
          mutates: true,
        }),
      ),
      "env local, staging (opt-in ALLOW_STAGING) · mutates",
    );
    assert.equal(
      policy.describeRequires(policy.normalizeRequires({ mutates: false })),
      "read-only",
    );
    assert.equal(policy.describeRequires(null), null);
    assert.equal(
      policy.describePolicy({
        trait: "protected",
        mutations: "deny",
        description: null,
      }),
      "protected · mutations denied",
    );
    assert.equal(policy.describePolicy(null), null);
  });
});

describe("policy: resolving the environment like the CLI", () => {
  it("prefers --env, then the spec, then defaultEnvironment, then local", () => {
    assert.deepEqual(
      policy.resolveEnvironment({
        override: "staging",
        specEnvironment: "qa",
        defaultEnvironment: "local",
      }),
      { name: "staging", source: "override" },
    );
    assert.deepEqual(
      policy.resolveEnvironment({
        override: null,
        specEnvironment: "qa",
        defaultEnvironment: "local",
      }),
      { name: "qa", source: "spec" },
    );
    assert.deepEqual(policy.resolveEnvironment({ defaultEnvironment: "dev" }), {
      name: "dev",
      source: "config-default",
    });
    assert.deepEqual(policy.resolveEnvironment({}), {
      name: "local",
      source: "fallback",
    });
  });
});

describe("policy: when a spec would be refused", () => {
  const requires = {
    env: ["local", { staging: { optIn: "ALLOW_STAGING" } }],
    mutates: true,
  };

  it("allows a listed environment and refuses an unlisted one", () => {
    const ok = policy.evaluateRequires({ requires, env: "local" });
    assert.equal(ok.refused, false);
    assert.deepEqual(ok.reasons, []);
    const refused = policy.evaluateRequires({ requires, env: "prod" });
    assert.equal(refused.refused, true);
    assert.equal(refused.reasons[0].code, "env-not-listed");
    assert.match(refused.summary, /lists local, staging, not "prod"/);
  });

  it("refuses an opt-in environment until its variable is 1 or true", () => {
    const missing = policy.evaluateRequires({ requires, env: "staging" });
    assert.equal(missing.refused, true);
    assert.equal(missing.reasons[0].code, "opt-in-missing");
    assert.match(missing.summary, /ALLOW_STAGING=1/);
    const denied = policy.evaluateRequires({
      requires,
      env: "staging",
      optIns: { ALLOW_STAGING: false },
    });
    assert.equal(denied.refused, true);
    const granted = policy.evaluateRequires({
      requires,
      env: "staging",
      optIns: { ALLOW_STAGING: true },
    });
    assert.equal(granted.refused, false);
  });

  it("answers opt-in questions with booleans only, never values", () => {
    const states = policy.optInStates(policy.normalizeRequires(requires), {
      ALLOW_STAGING: "1",
      OTHER: "secret-value",
    });
    assert.deepEqual(states, { ALLOW_STAGING: true });
    assert.deepEqual(
      policy.optInStates(policy.normalizeRequires(requires), {
        ALLOW_STAGING: "yes",
      }),
      { ALLOW_STAGING: false },
    );
    assert.equal(policy.optInGranted("true"), true);
    assert.equal(policy.optInGranted("0"), false);
    assert.equal(policy.optInGranted(undefined), false);
  });

  it("refuses a mutating spec where the policy denies mutations", () => {
    const verdict = policy.evaluateRequires({
      requires: { mutates: true },
      env: "staging",
      policy: { trait: "shared", mutations: "deny" },
    });
    assert.equal(verdict.refused, true);
    assert.deepEqual(
      verdict.reasons.map((reason) => reason.code),
      ["mutations-denied"],
    );
    // read-only specs and allowing environments are fine
    assert.equal(
      policy.evaluateRequires({
        requires: { mutates: false },
        env: "staging",
        policy: { mutations: "deny" },
      }).refused,
      false,
    );
    assert.equal(
      policy.evaluateRequires({
        requires: { mutates: true },
        env: "local",
        policy: { mutations: "allow" },
      }).refused,
      false,
    );
  });

  it("refuses a protected environment the spec does not list", () => {
    const unlisted = policy.evaluateRequires({
      requires: null,
      env: "prod",
      policy: { trait: "protected" },
    });
    assert.equal(unlisted.refused, true);
    assert.equal(unlisted.reasons[0].code, "protected-env");
    // Listed explicitly: allowed (no duplicate "not listed" reason either).
    assert.equal(
      policy.evaluateRequires({
        requires: { env: ["prod"] },
        env: "prod",
        policy: { trait: "protected" },
      }).refused,
      false,
    );
    const otherList = policy.evaluateRequires({
      requires: { env: ["local"] },
      env: "prod",
      policy: { trait: "protected" },
    });
    assert.deepEqual(
      otherList.reasons.map((reason) => reason.code),
      ["env-not-listed"],
    );
  });

  it("lists every rule that applies at once", () => {
    const verdict = policy.evaluateRequires({
      requires: { env: ["local"], mutates: true },
      env: "prod",
      policy: { trait: "protected", mutations: "deny" },
    });
    assert.deepEqual(
      verdict.reasons.map((reason) => reason.code),
      ["env-not-listed", "mutations-denied"],
    );
  });

  it("refuses everything when requires.env is an empty list", () => {
    const verdict = policy.evaluateRequires({
      requires: { env: [] },
      env: "local",
    });
    assert.equal(verdict.refused, true);
    assert.match(verdict.summary, /empty/);
  });

  it("accepts normalized shapes as well as raw YAML", () => {
    const normalized = policy.normalizeRequires(requires);
    assert.equal(
      policy.evaluateRequires({ requires: normalized, env: "prod" }).refused,
      true,
    );
    assert.equal(
      policy.evaluateRequires({
        requires: { mutates: true },
        env: "x",
        policy: policy.normalizePolicy({ mutations: "deny" }),
      }).refused,
      true,
    );
  });
});

describe("policy: refusal records", () => {
  it("normalizes run.json refusal blocks and says them in one line", () => {
    const refusal = policy.normalizeRefusal({
      reason: "requires.env does not list prod",
      env: "prod",
      requires: { env: ["local"], mutates: true },
    });
    assert.deepEqual(refusal, {
      reason: "requires.env does not list prod",
      env: "prod",
      requires: { env: [{ name: "local", optIn: null }], mutates: true },
      requiresText: "env local · mutates",
    });
    assert.equal(
      policy.refusalText(refusal),
      "refused on prod: requires.env does not list prod (requires env local · mutates)",
    );
    assert.equal(policy.normalizeRefusal(null), null);
    assert.equal(policy.normalizeRefusal({}), null);
    assert.equal(policy.refusalText(null), "refused by the environment policy");
  });
});

describe("policy: matching the CLI on opt-ins and refused outcomes", () => {
  it("grants opt-ins case-insensitively, like the CLI's isOptInValue", () => {
    for (const value of ["1", "true", "TRUE", "True", " true "])
      assert.equal(policy.optInGranted(value), true, value);
    for (const value of ["0", "yes", "on", "", undefined, null, 1])
      assert.equal(policy.optInGranted(value), false, String(value));
    assert.deepEqual(
      policy.optInStates(
        { env: [{ name: "staging", optIn: "ALLOW_STAGING" }], mutates: null },
        { ALLOW_STAGING: "TRUE" },
      ),
      { ALLOW_STAGING: true },
    );
  });

  it("reads only the asked-for names from a dotenv file", () => {
    assert.deepEqual(
      policy.parseDotEnv(
        [
          "# comment",
          "export ALLOW_STAGING=1",
          'ALLOW_PROD="True" # trailing',
          "OTHER_SECRET=hunter2",
          "ALLOW_QA=no # nope",
          "ALLOW_EMPTY=",
          "not a line",
        ].join("\n"),
        ["ALLOW_STAGING", "ALLOW_PROD", "ALLOW_QA", "ALLOW_EMPTY"],
      ),
      {
        ALLOW_STAGING: "1",
        ALLOW_PROD: "True",
        ALLOW_QA: "no",
        ALLOW_EMPTY: "",
      },
    );
    assert.deepEqual(policy.parseDotEnv("A=1", []), {});
  });

  it("knows a synthetic result (a placeholder runId that names no directory)", () => {
    assert.equal(
      policy.isSyntheticResult({ status: "refused", synthetic: true }),
      true,
    );
    assert.equal(
      policy.isSyntheticResult({ status: "errored", synthetic: true }),
      true,
    );
    assert.equal(policy.isSyntheticResult({ status: "errored" }), false);
    assert.equal(policy.isSyntheticResult(null), false);
  });

  it("knows a refused run or batch document, and its refusal", () => {
    assert.equal(policy.isRefusedOutcome(7, null), true);
    assert.equal(policy.isRefusedOutcome(2, { status: "refused" }), true);
    // an all-refused batch exits 0 without --strict-requires
    assert.equal(
      policy.isRefusedOutcome(0, { summary: { total: 2, refused: 2 } }),
      true,
    );
    assert.equal(
      policy.isRefusedOutcome(0, { summary: { total: 2, refused: 1 } }),
      false,
    );
    assert.equal(policy.isRefusedOutcome(1, { status: "failed" }), false);
    assert.equal(policy.isRefusedOutcome(0, null), false);

    assert.equal(
      policy.documentRefusal({
        status: "refused",
        refusal: { reason: "r", env: "local", code: "env-not-listed" },
      })?.code,
      "env-not-listed",
    );
    assert.equal(
      policy.documentRefusal({
        results: [
          { status: "passed" },
          { status: "refused", refusal: { reason: "second", env: "prod" } },
        ],
      })?.reason,
      "second",
    );
    assert.equal(policy.documentRefusal({ status: "passed" }), null);
  });
});
