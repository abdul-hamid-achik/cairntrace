import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightAdapter } from "../../adapters/playwright/PlaywrightAdapter";
import { runSpec } from "../runner/Runner";
import { RunResultSchema } from "../schema/run.v1";
import { withCairnPrelude } from "./prelude";

/**
 * F20 in real Chromium (Playwright backend): the window.__cairn helpers on a
 * small page, then eval steps, `wait: { app }` and a browser script verifier
 * through `cairn run`. One browser at a time: the helper block closes its
 * adapter before the runner case launches its own.
 */

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Prelude</title></head>
<body>
  <h1>  Team
    dashboard </h1>
  <div id="hidden" style="display:none">secret</div>
  <label for="email">Email address</label>
  <input id="email" />
  <input id="search" aria-label="Search people" />
  <label>Nickname <input id="nick" /></label>
  <input id="tracked" />
  <input id="agree" type="checkbox" />
  <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
  <button id="late" style="display:none">Continue</button>
  <table id="people">
    <thead><tr><th>Name</th><th>Country</th><th></th></tr></thead>
    <tbody>
      <tr><td>Ada</td><td>CH</td><td>Edit</td></tr>
      <tr style="display:none"><td>Ghost</td><td>XX</td><td>Edit</td></tr>
      <tr><td>Lin</td><td>DE</td><td>Edit</td></tr>
    </tbody>
  </table>
  <div id="clicks">0</div>
  <script>
    window.__events = [];
    // A framework-style instance setter: native writes must bypass it.
    var tracked = document.getElementById("tracked");
    window.__instanceWrites = 0;
    Object.defineProperty(tracked, "value", {
      configurable: true,
      get: function () { return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").get.call(this); },
      set: function (v) { window.__instanceWrites++; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(this, v); },
    });
    ["input", "change"].forEach(function (type) {
      tracked.addEventListener(type, function () { window.__events.push(type + ":" + tracked.value); });
      document.getElementById("agree").addEventListener(type, function (e) { window.__events.push(type + ":agree:" + e.target.checked); });
    });
    document.getElementById("clicks").addEventListener("click", function (e) {
      this.textContent = String(Number(this.textContent) + 1) + (e instanceof MouseEvent ? " mouse" : "");
    });
    setTimeout(function () { document.getElementById("late").style.display = "inline-block"; }, 300);
    window.appStore = { state: { count: 0, user: null } };
    var timer = setInterval(function () {
      window.appStore.state.count++;
      if (window.appStore.state.count >= 3) {
        window.appStore.state.user = { id: 7, name: "Ada" };
        clearInterval(timer);
      }
    }, 150);
  </script>
</body></html>`;

const HANDLES = {
  store: "window.appStore",
  user: "window.appStore.state.user",
};

let dir: string;
let pageUrl: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-prelude-"));
  await writeFile(join(dir, "page.html"), PAGE);
  pageUrl = pathToFileURL(join(dir, "page.html")).href;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("window.__cairn helpers (Chromium)", () => {
  let adapter: PlaywrightAdapter;

  async function run(source: string): Promise<unknown> {
    const result = await adapter.evaluate(
      `(async () => { ${withCairnPrelude(source, HANDLES)} })()`,
    );
    if (!result.ok) throw new Error(result.stderr);
    return JSON.parse(result.stdout) as unknown;
  }

  beforeAll(async () => {
    adapter = new PlaywrightAdapter({});
    const opened = await adapter.runStep({ open: pageUrl });
    expect(opened.ok).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await adapter?.close();
  });

  it("reads text, visibility and labels", async () => {
    expect(
      await run(`return {
        heading: __cairn.text("h1"),
        missing: __cairn.text("#nope"),
        visible: __cairn.visible("h1"),
        hidden: __cairn.visible("#hidden"),
        none: __cairn.visible(null),
        forLabel: __cairn.labelOf("#email"),
        aria: __cairn.labelOf(document.getElementById("search")),
        wrapped: __cairn.labelOf("#nick"),
        version: __cairn.version,
      };`),
    ).toEqual({
      heading: "Team dashboard",
      missing: "",
      visible: true,
      hidden: false,
      none: false,
      forLabel: "Email address",
      aria: "Search people",
      wrapped: "Nickname",
      version: "1",
    });
  });

  it("writes through native setters and fires typed events", async () => {
    expect(
      await run(`return {
        value: __cairn.nativeSet("#tracked", "hello"),
        checked: __cairn.nativeSet("#agree", true),
        plan: __cairn.nativeSet("#plan", "pro"),
        instanceWrites: window.__instanceWrites,
        events: window.__events,
        fired: __cairn.fire("#clicks", "click"),
        clicks: __cairn.text("#clicks"),
      };`),
    ).toEqual({
      value: "hello",
      checked: true,
      plan: "pro",
      instanceWrites: 0,
      events: [
        "input:hello",
        "change:hello",
        "input:agree:true",
        "change:agree:true",
      ],
      fired: true,
      clicks: "1 mouse",
    });
    await expect(run(`return __cairn.nativeSet("h1", "x");`)).rejects.toThrow(
      /<h1> is not a form control/,
    );
  });

  it("reads table rows, waits and sleeps", async () => {
    expect(
      await run(`
        const late = await __cairn.waitFor("#late", { timeoutMs: 3000 });
        const started = Date.now();
        await __cairn.sleep(120);
        const slept = Date.now() - started;
        let timeout = "";
        try {
          await __cairn.waitFor(() => false, { timeoutMs: 100 });
        } catch (e) {
          timeout = e.message;
        }
        return {
          rows: __cairn.rows("#people"),
          late: late.id,
          slept: slept >= 100,
          timeout,
        };`),
    ).toEqual({
      rows: [
        { Name: "Ada", Country: "CH", column3: "Edit" },
        { Name: "Lin", Country: "DE", column3: "Edit" },
      ],
      late: "late",
      slept: true,
      timeout: "__cairn.waitFor: timed out after 100ms",
    });
  });

  it("exposes app handles read-only and installs idempotently", async () => {
    expect(
      await run(`
        const before = window.__cairn;
        await __cairn.waitFor(() => __cairn.app.user, { timeoutMs: 3000 });
        let assigned = "";
        try {
          "use strict";
          (function () { "use strict"; __cairn.app.user = null; })();
        } catch (e) {
          assigned = e.constructor.name;
        }
        return {
          same: before === window.__cairn,
          user: __cairn.app.user,
          count: __cairn.app.store.state.count,
          assigned,
          enumerable: Object.keys(window).includes("__cairn"),
        };`),
    ).toEqual({
      same: true,
      user: { id: 7, name: "Ada" },
      count: 3,
      assigned: "TypeError",
      enumerable: false,
    });
  });
});

describe("prelude through cairn run (Playwright backend)", () => {
  it("runs evals that use __cairn, wait: { app } and a browser verifier", async () => {
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      [
        "version: 1",
        "environments:",
        "  local: {}",
        "browser:",
        "  appHandle:",
        "    store: window.appStore",
        "    user: window.appStore.state.user",
        "",
      ].join("\n"),
    );
    const specPath = join(dir, "flow.yml");
    await writeFile(
      specPath,
      `version: 1
name: prelude_e2e
intent: page helpers and app handles replace hand-written eval helpers
coldStart: guest
steps:
  - id: open_page
    open: ${JSON.stringify(pageUrl)}
  - id: user_ready
    wait: { app: { path: user.name, equals: Ada }, timeoutMs: 5000 }
  - id: count_ready
    wait: { app: { path: store.state.count, in: [3, 4] }, timeoutMs: 5000 }
  - id: read_rows
    eval:
      js: "return { rows: __cairn.rows('#people').length, label: __cairn.labelOf('#email') };"
      assign: page
  - id: plain_eval
    eval:
      js: "return typeof window.__cairn;"
      assign: plain
outcomes:
  - id: rows_read
    description: the eval read two visible rows through the prelude
    verify:
      value:
        actual: \${evals.page.value}
        expect: { rows: 2, label: Email address }
  - id: heading
    description: a browser verifier reads the heading through the prelude
    verify:
      script:
        run: "return { ok: __cairn.text('h1') === 'Team dashboard' && __cairn.app.user.id === 7, evidence: __cairn.app.user };"
`,
    );
    const backend = new PlaywrightAdapter({});
    try {
      const result = await runSpec({
        specPath,
        artifactRoot: join(dir, "runs"),
        backend,
      });
      const run = RunResultSchema.parse(
        JSON.parse(await readFile(join(result.runDir, "run.json"), "utf8")),
      );
      expect(
        run.steps.map((s) => [s.id, s.status]),
        JSON.stringify(run.steps),
      ).toEqual([
        ["open_page", "passed"],
        ["user_ready", "passed"],
        ["count_ready", "passed"],
        ["read_rows", "passed"],
        ["plain_eval", "passed"],
      ]);
      expect(result.status).toBe("passed");
      // A source that never mentions __cairn is sent unchanged: the prelude
      // was already installed by the earlier steps, so it is visible here.
      const plain = JSON.parse(
        await readFile(join(result.runDir, "evals/plain.json"), "utf8"),
      ) as { value: unknown };
      expect(plain.value).toBe("object");
    } finally {
      await backend.close();
    }
  }, 120_000);
});
