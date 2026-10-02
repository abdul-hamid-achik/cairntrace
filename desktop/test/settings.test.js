/**
 * Settings store: defaults, deep merge, atomic save/load, and recent projects.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after: afterAll, describe, it } = require("node:test");

const store = require("../lib/settings");
const { cleanup, tempDir } = require("./helpers");

afterAll(cleanup);

/** @returns {string} */
function settingsFile() {
  return path.join(tempDir("cairn-settings-"), "settings.json");
}

describe("defaultSettings", () => {
  it("ships safe run defaults", () => {
    const defaults = store.defaultSettings();
    assert.equal(defaults.run.headed, false);
    assert.equal(defaults.run.mock, false);
    assert.equal(defaults.run.parallel, 1);
    assert.equal(defaults.run.logLevel, "info");
    assert.equal(defaults.cairnBin, null);
    assert.equal(defaults.artifactRoot, null);
    assert.deepEqual(defaults.projects, []);
  });
});

describe("mergeDeep", () => {
  it("merges nested objects and replaces arrays", () => {
    const merged = store.mergeDeep(
      { run: { headed: false, env: "local" }, projects: [{ path: "/a" }] },
      { run: { headed: true }, projects: [] },
    );
    assert.deepEqual(merged, {
      run: { headed: true, env: "local" },
      projects: [],
    });
  });

  it("ignores undefined patch values", () => {
    assert.deepEqual(store.mergeDeep({ a: 1, b: 2 }, { a: undefined, b: 3 }), {
      a: 1,
      b: 3,
    });
  });

  it("returns scalars and arrays wholesale", () => {
    assert.equal(store.mergeDeep({ a: 1 }, 5), 5);
    assert.deepEqual(store.mergeDeep([1], [2, 3]), [2, 3]);
  });
});

describe("load/save round trip", () => {
  it("returns defaults when the file is missing or corrupt", () => {
    const file = settingsFile();
    assert.deepEqual(store.loadSettings(file), store.defaultSettings());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json", "utf8");
    assert.deepEqual(store.loadSettings(file), store.defaultSettings());
  });

  it("fills in newly added default keys on load", () => {
    const file = settingsFile();
    store.saveSettings(file, { cairnBin: "/usr/local/bin/cairn" });
    const loaded = store.loadSettings(file);
    assert.equal(loaded.cairnBin, "/usr/local/bin/cairn");
    assert.equal(loaded.run.logLevel, "info", "defaults must backfill");
    assert.equal(loaded.version, store.SETTINGS_VERSION);
  });

  it("updateSettings patches without dropping siblings", () => {
    const file = settingsFile();
    store.saveSettings(file, { cairnBin: "/bin/cairn", run: { headed: true } });
    const updated = store.updateSettings(file, { run: { coldStart: true } });
    assert.equal(updated.cairnBin, "/bin/cairn");
    assert.equal(updated.run.headed, true);
    assert.equal(updated.run.coldStart, true);
    assert.deepEqual(store.loadSettings(file), updated);
  });

  it("leaves no temp file behind", () => {
    const file = settingsFile();
    store.saveSettings(file, { cairnBin: null });
    assert.deepEqual(
      fs
        .readdirSync(path.dirname(file))
        .filter((name) => name.endsWith(".tmp")),
      [],
    );
  });
});

describe("recent projects", () => {
  it("moves an existing entry to the front and counts opens", () => {
    const settings = store.defaultSettings();
    const once = store.withRecentProject(
      settings,
      "/tmp/a",
      new Date("2026-09-01T00:00:00Z"),
    );
    const twice = store.withRecentProject(
      store.withRecentProject(once, "/tmp/b", new Date("2026-09-02T00:00:00Z")),
      "/tmp/a",
      new Date("2026-09-03T00:00:00Z"),
    );
    assert.deepEqual(
      twice.projects.map((entry) => entry.path),
      ["/tmp/a", "/tmp/b"],
    );
    assert.equal(twice.projects[0].openedCount, 2);
    assert.equal(twice.activeProject, "/tmp/a");
    assert.equal(twice.projects[0].lastOpenedAt, "2026-09-03T00:00:00.000Z");
  });

  it("dedupes by resolved path, not by spelling", () => {
    const settings = store.withRecentProject(store.defaultSettings(), "/tmp/a");
    const again = store.withRecentProject(settings, "/tmp/a/");
    assert.equal(again.projects.length, 1);
  });

  it("caps the recent list", () => {
    let settings = store.defaultSettings();
    for (let index = 0; index < store.MAX_RECENT_PROJECTS + 5; index += 1)
      settings = store.withRecentProject(settings, `/tmp/project-${index}`);
    assert.equal(settings.projects.length, store.MAX_RECENT_PROJECTS);
    assert.equal(
      settings.projects[0].path,
      `/tmp/project-${store.MAX_RECENT_PROJECTS + 4}`,
    );
  });

  it("forgets a project and re-points the active one", () => {
    let settings = store.withRecentProject(store.defaultSettings(), "/tmp/a");
    settings = store.withRecentProject(settings, "/tmp/b");
    const after = store.withoutProject(settings, "/tmp/b");
    assert.deepEqual(
      after.projects.map((entry) => entry.path),
      ["/tmp/a"],
    );
    assert.equal(after.activeProject, "/tmp/a");
  });

  it("keeps the active project when forgetting another one", () => {
    let settings = store.withRecentProject(store.defaultSettings(), "/tmp/a");
    settings = store.withRecentProject(settings, "/tmp/b");
    const after = store.withoutProject(settings, "/tmp/a");
    assert.equal(after.activeProject, "/tmp/b");
  });
});

describe("interface + per-project launch settings", () => {
  it("ships interface defaults and an empty per-project map", () => {
    const defaults = store.defaultSettings();
    assert.deepEqual(defaults.ui, {
      density: "comfortable",
      screenshotMaxWidth: 720,
      autoRefreshRuns: true,
      livePollMs: 400,
    });
    assert.deepEqual(defaults.projectSettings, {});
  });

  it("merges one project's launch settings without touching another's", () => {
    const base = store.mergeDeep(store.defaultSettings(), {
      projectSettings: {
        "/work/a": {
          launchTemplate: "task run {spec}",
          lockFiles: ["runs/.a.lock"],
        },
      },
    });
    const next = store.mergeDeep(base, {
      projectSettings: { "/work/b": { launchTemplate: null, lockFiles: [] } },
    });
    assert.equal(
      next.projectSettings["/work/a"].launchTemplate,
      "task run {spec}",
    );
    assert.deepEqual(next.projectSettings["/work/b"].lockFiles, []);
  });
});

describe("renderer settings patch (settings:update)", () => {
  it("accepts only run/ui and refuses every other key", () => {
    assert.deepEqual(
      store.sanitizeRendererPatch({ ui: { density: "compact" } }),
      { ui: { density: "compact" } },
    );
    for (const key of [
      "cairnBin",
      "artifactRoot",
      "projectSettings",
      "projects",
      "activeProject",
    ])
      assert.throws(
        () => store.sanitizeRendererPatch({ [key]: "/anything" }),
        /cannot change/,
        key,
      );
    assert.throws(() => store.sanitizeRendererPatch(null), /patch required/);
  });

  it("validates run values that become cairn argv", () => {
    assert.deepEqual(
      store.sanitizeRunSettings({
        env: " staging ",
        backend: null,
        headed: 1,
        parallel: "99",
        labels: ["round=2", ""],
        vars: null,
        junit: "/tmp/out.xml",
        unknown: "dropped",
      }),
      {
        env: "staging",
        backend: null,
        headed: true,
        parallel: 32,
        labels: ["round=2"],
        vars: [],
      },
    );
    assert.throws(
      () => store.sanitizeRunSettings({ env: "--config=/tmp/x.yml" }),
      /cannot start with "-"/,
    );
    assert.throws(
      () => store.sanitizeRunSettings({ labels: ["--junit", "/tmp/x"] }),
      /cannot start with "-"/,
    );
    assert.throws(
      () => store.sanitizeRunSettings({ device: "a\nb" }),
      /single line/,
    );
  });

  it("clamps ui values", () => {
    assert.deepEqual(
      store.sanitizeUiSettings({
        density: "huge",
        screenshotMaxWidth: 99999,
        livePollMs: 1,
        autoRefreshRuns: 0,
        extra: true,
      }),
      {
        density: "comfortable",
        screenshotMaxWidth: 4000,
        livePollMs: 150,
        autoRefreshRuns: false,
      },
    );
  });
});

describe("checkCairnBinary / checkArtifactRoot", () => {
  it("requires an existing executable and flags non-cairn names for confirmation", () => {
    const dir = tempDir("cairn-bin-");
    const cairn = path.join(dir, "cairn");
    const other = path.join(dir, "wrapper.sh");
    const plain = path.join(dir, "notes.txt");
    fs.writeFileSync(cairn, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(other, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(plain, "x", { mode: 0o644 });
    assert.deepEqual(store.checkCairnBinary(cairn), {
      path: cairn,
      needsConfirm: false,
    });
    assert.deepEqual(store.checkCairnBinary(other), {
      path: other,
      needsConfirm: true,
    });
    assert.deepEqual(store.checkCairnBinary(""), {
      path: null,
      needsConfirm: false,
    });
    assert.throws(() => store.checkCairnBinary(plain), /not executable/);
    assert.throws(() => store.checkCairnBinary(dir), /not a file/);
    assert.throws(() => store.checkCairnBinary("bin/cairn"), /absolute/);
    assert.throws(
      () => store.checkCairnBinary(path.join(dir, "missing")),
      /no file/,
    );
    assert.equal(store.checkCairnBinary("~/cairn", { home: dir }).path, cairn);
  });

  it("refuses the filesystem root, home, and parents of home", () => {
    const home = tempDir("cairn-home-");
    assert.throws(
      () => store.checkArtifactRoot("/", { home }),
      /filesystem root/,
    );
    assert.throws(() => store.checkArtifactRoot(home, { home }), /home folder/);
    assert.throws(() => store.checkArtifactRoot("~", { home }), /home folder/);
    assert.throws(
      () => store.checkArtifactRoot(path.dirname(home), { home }),
      /home folder/,
    );
    assert.throws(() => store.checkArtifactRoot("runs", { home }), /absolute/);
    assert.equal(
      store.checkArtifactRoot("~/.cairntrace/runs", { home }),
      path.join(home, ".cairntrace", "runs"),
    );
    assert.equal(store.checkArtifactRoot(null, { home }), null);
    const file = path.join(home, "file.txt");
    fs.writeFileSync(file, "x");
    assert.throws(
      () => store.checkArtifactRoot(file, { home: tempDir("cairn-h2-") }),
      /not a directory/,
    );
  });
});
