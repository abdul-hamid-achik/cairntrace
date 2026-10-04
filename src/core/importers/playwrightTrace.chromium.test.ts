import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { PlaywrightAdapter } from "../../adapters/playwright/PlaywrightAdapter";
import { runSpec } from "../runner/Runner";
import { RunResultSchema } from "../schema/run.v1";
import { SpecSchema } from "../schema/spec.v1";
import { importPlaywrightTrace } from "./playwrightTrace";

/**
 * The trace importer over TWO real Playwright 1.61 traces of a tiny local
 * page, one per archive layout: a library trace (`context.tracing`) and a
 * `@playwright/test` runner trace (`trace: "on"`, with `test.trace` step
 * titles and `Frame.expect` calls). Each draft is then replayed with
 * `cairn run --backend playwright` machinery against the same page. One
 * headless Chromium at a time: the recording browser closes before the replay
 * browser opens, and the runner trace is a bounded child process.
 */

const PAGE = `<!doctype html><html><head><title>Tiny shop</title></head><body>
<h1>Tiny shop</h1>
<form id="f" onsubmit="event.preventDefault();doLogin()">
 <label for="email">Email</label><input id="email" name="email" type="text" />
 <label for="pw">Password</label><input id="pw" name="password" type="password" />
 <button type="submit">Sign in</button>
</form>
<p id="status" role="status"></p>
<label for="color">Color</label>
<select id="color"><option value="r">Red</option><option value="b">Blue</option></select>
<label><input type="checkbox" id="terms" /> Accept terms</label>
<button id="load" data-testid="load-items">Load items</button>
<ul id="items"></ul>
<script>
async function doLogin(){
  const r = await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer abc'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('pw').value})});
  const j = await r.json();
  document.getElementById('status').textContent = 'Welcome ' + j.name;
  history.pushState({}, '', '/home');
}
document.getElementById('load').onclick = async () => {
  const r = await fetch('/api/items?limit=2');
  const j = await r.json();
  document.getElementById('items').innerHTML = j.items.map(i=>'<li>'+i+'</li>').join('');
};
</script></body></html>`;

const secret = ["pw", process.pid, Date.now()].join("-");
let dir: string;
let server: Server;
let base: string;

function sizeOf(path: string): number {
  return statSync(path).size;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cairn-trace-chromium-"));
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api/login")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ name: "Ada" }));
    } else if (req.url?.startsWith("/api/items")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ items: ["Widget", "Gadget"] }));
    } else {
      res.setHeader("content-type", "text/html");
      res.end(PAGE);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${
    typeof address === "object" && address ? address.port : 0
  }`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function replay(yaml: string, name: string): Promise<string[]> {
  const specDir = join(dir, name);
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "draft.yml"), yaml);
  writeFileSync(
    join(specDir, "cairntrace.config.yml"),
    `version: 1\nenvironments:\n  local:\n    baseUrl: ${base}\nsecrets:\n  required: [PASSWORD]\n`,
  );
  process.env["PASSWORD"] = secret;
  const backend = new PlaywrightAdapter({});
  try {
    const result = await runSpec({
      specPath: join(specDir, "draft.yml"),
      artifactRoot: join(specDir, "runs"),
      backend,
    });
    const run = RunResultSchema.parse(
      JSON.parse(readFileSync(join(result.runDir, "run.json"), "utf8")),
    );
    expect(
      run.steps.filter((s) => s.status !== "passed"),
      JSON.stringify(run.steps),
    ).toEqual([]);
    expect(result.status, JSON.stringify(run.outcomes)).toBe("passed");
    return run.outcomes.map((o) => o.id);
  } finally {
    await backend.close();
    delete process.env["PASSWORD"];
  }
}

describe("trace importer over real traces (Chromium)", () => {
  it("imports a library trace into a draft that replays green", async () => {
    const zip = join(dir, "library.zip");
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ baseURL: base });
      await context.tracing.start({
        screenshots: false,
        snapshots: true,
        sources: false,
        title: "tiny shop",
      });
      const page = await context.newPage();
      await page.goto("/");
      await page.getByLabel("Email").fill("ada@example.test");
      await page.getByLabel("Password").fill(secret);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("status").getByText("Welcome Ada").waitFor();
      await page.getByLabel("Color").selectOption("b");
      await page.getByLabel("Accept terms").check();
      await page.getByTestId("load-items").click();
      await page.getByText("Gadget").waitFor();
      await context.tracing.stop({ path: zip });
    } finally {
      await browser.close();
    }
    // a small archive: fixtures of this size are fine to read, never to commit
    expect(sizeOf(zip)).toBeLessThan(200 * 1024);

    const imported = importPlaywrightTrace(readFileSync(zip), {
      sourceLabel: "library.zip",
    });
    const spec = SpecSchema.parse(parseYaml(imported.yaml));
    expect(spec.name).toBe("tiny_shop");
    expect(
      spec.steps?.map((s) => Object.keys(s).find((k) => k !== "id")),
    ).toEqual([
      "open",
      "fill",
      "fill",
      "click",
      "wait",
      "select",
      "check",
      "click",
      "wait",
    ]);
    expect(spec.steps?.[3]).toMatchObject({
      click: { by: "role", role: "button", name: "Sign in" },
    });
    expect(spec.steps?.[7]).toMatchObject({
      click: { by: "testid", testid: "load-items" },
    });
    expect(spec.outcomes.map((o) => o.id)).toEqual([
      "final_url",
      "api_post_api_login",
      "api_get_api_items",
    ]);
    // the typed password never reaches the draft or the report
    expect(imported.yaml).toContain("${secrets.PASSWORD}");
    expect(imported.yaml + JSON.stringify(imported)).not.toContain(secret);
    expect(imported.yaml).not.toContain("Bearer");

    expect(await replay(imported.yaml, "library")).toEqual([
      "final_url",
      "api_post_api_login",
      "api_get_api_items",
    ]);
  }, 120_000);

  it("imports a @playwright/test runner trace (test.step titles, expect calls) into a draft that replays green", async () => {
    const require = createRequire(import.meta.url);
    const testPkg = require.resolve("@playwright/test");
    const cli = join(testPkg, "..", "cli.js");
    const work = join(dir, "runner");
    mkdirSync(work, { recursive: true });
    writeFileSync(
      join(work, "playwright.config.cjs"),
      `const { defineConfig } = require(${JSON.stringify(testPkg)});
module.exports = defineConfig({
  testDir: ".", testMatch: /.*\\.pw\\.cjs$/, workers: 1, reporter: "line",
  outputDir: "./results",
  use: { headless: true, baseURL: ${JSON.stringify(base)},
    trace: { mode: "on", screenshots: false, snapshots: true, sources: false, attachments: false } },
});
`,
    );
    writeFileSync(
      join(work, "shop.pw.cjs"),
      `const { test, expect } = require(${JSON.stringify(testPkg)});
test("signs in and loads items", async ({ page }) => {
  await test.step("open the shop", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Tiny shop" })).toBeVisible();
  });
  await test.step("sign in", async () => {
    await page.getByLabel("Email").fill("ada@example.test");
    await page.getByLabel("Password").fill(${JSON.stringify(secret)});
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("status")).toHaveText("Welcome Ada");
    await expect(page).toHaveURL(/\\/home$/);
  });
  await page.getByTestId("load-items").click();
  await expect(page.locator("#items li")).toHaveCount(2);
  await expect(page.locator("#items")).toContainText("Gadget");
});
`,
    );
    try {
      // async: the page server lives in this process and must keep serving
      await promisify(execFile)(
        process.execPath,
        [cli, "test", "-c", "playwright.config.cjs"],
        { cwd: work, timeout: 90_000, env: { ...process.env, CI: "" } },
      );
    } catch (e) {
      const out = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `playwright test failed: ${String(out.stdout ?? "").slice(-1500)}${String(out.stderr ?? "").slice(-1500)}`,
        { cause: e },
      );
    }
    const results = join(work, "results");
    const traceDir = readdirSync(results).find((n) =>
      statSync(join(results, n)).isDirectory(),
    );
    const zip = join(results, traceDir!, "trace.zip");
    expect(sizeOf(zip)).toBeLessThan(200 * 1024);

    const imported = importPlaywrightTrace(readFileSync(zip), {
      sourceLabel: "runner.zip",
    });
    const spec = SpecSchema.parse(parseYaml(imported.yaml));
    expect(spec.name).toBe("signs_in_and_loads_items");
    // test.step titles from test.trace become the first step's id
    expect(spec.steps?.map((s) => s.id).slice(0, 2)).toEqual([
      "open_the_shop",
      "sign_in",
    ]);
    expect(spec.outcomes.map((o) => o.id)).toEqual([
      "text_visible",
      "text_matches",
      "url_matches",
      "element_count",
      "text_contains",
      "final_url",
      "api_post_api_login",
      "api_get_api_items",
    ]);
    expect(imported.yaml + JSON.stringify(imported)).not.toContain(secret);
    expect(imported.todos).toEqual([]);

    expect(await replay(imported.yaml, "runner")).toHaveLength(8);
  }, 180_000);
});
