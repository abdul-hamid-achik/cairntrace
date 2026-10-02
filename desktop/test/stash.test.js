/**
 * `cairn stash` argv builders, id/tag validation, and locating the run
 * inside a restored stash.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const stash = require("../lib/stash");
const { cleanup, tempDir, write } = require("./helpers");

after(cleanup);

describe("isSafeStashId", () => {
  it("accepts single path components and refuses flags, traversal, control chars", () => {
    assert.equal(stash.isSafeStashId("stash_7f3a9c"), true);
    for (const bad of [
      "",
      "-rf",
      "--to",
      "..",
      "a/b",
      "a\\b",
      "a\u0000b",
      " padded",
      42,
      null,
    ])
      assert.equal(stash.isSafeStashId(bad), false, String(bad));
  });
});

describe("argv builders", () => {
  it("lists cairntrace stashes by default with every tag", () => {
    assert.deepEqual(
      stash.buildStashListArgv({ tags: ["spec:checkout", "round=2"] }),
      [
        "stash",
        "list",
        "--tool",
        "cairntrace",
        "--tag",
        "spec:checkout",
        "--tag",
        "round=2",
        "--format",
        "json",
      ],
    );
    assert.deepEqual(stash.buildStashListArgv({ tool: null }), [
      "stash",
      "list",
      "--format",
      "json",
    ]);
    assert.throws(
      () => stash.buildStashListArgv({ tags: ["--all"] }),
      /invalid tag/,
    );
  });

  it("builds info and restore, refusing unsafe ids and relative targets", () => {
    assert.deepEqual(stash.buildStashInfoArgv("s1"), [
      "stash",
      "info",
      "s1",
      "--format",
      "json",
    ]);
    assert.deepEqual(stash.buildStashRestoreArgv("s1", "/tmp/x"), [
      "stash",
      "restore",
      "s1",
      "--to",
      "/tmp/x",
      "--format",
      "json",
    ]);
    assert.throws(() => stash.buildStashInfoArgv("-x"), /invalid stash id/);
    assert.throws(
      () => stash.buildStashRestoreArgv("s1", "relative"),
      /absolute/,
    );
  });

  it("renders a copyable CLI line", () => {
    assert.equal(
      stash.cliEquivalent(["stash", "list", "--tag", "two words"]),
      "cairn stash list --tag 'two words'",
    );
  });
});

describe("locateRestoredRun", () => {
  it("finds run.json at the target or the shallowest descendant", () => {
    const flat = tempDir("cairn-restore-");
    write(flat, "run.json", "{}");
    assert.equal(stash.locateRestoredRun(flat), path.resolve(flat));
    const nested = tempDir("cairn-restore-");
    write(nested, "2026-09-01T10-00-00-000Z_demo_spec_aaaaaa/run.json", "{}");
    write(nested, "deeper/a/b/c/run.json", "{}");
    assert.equal(
      stash.locateRestoredRun(nested),
      path.join(
        path.resolve(nested),
        "2026-09-01T10-00-00-000Z_demo_spec_aaaaaa",
      ),
    );
    const none = tempDir("cairn-restore-");
    fs.mkdirSync(path.join(none, "x"));
    assert.equal(stash.locateRestoredRun(none), null);
  });
});
