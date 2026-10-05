# Changelog

All notable changes to cairntrace are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [3.1.2] - 2026-10-05

### Fixed

- **A run could hang forever in its teardown after a wedged browser.** Bun can
  lose a child process's exit notification on Linux: the child exits, stays
  `<defunct>`, and the event loop never hears about it. Every bounded command
  (suite `before`/`after` hooks, `--before`/`--after` hooks, fixtures,
  preflight, `run.finally`, services teardown commands) awaited that event
  alone, and its deadline only sent SIGKILL to the zombie, which settles
  nothing: a suite `after` hook ran for an hour past `--hook-timeout-ms` until
  Ctrl-C. A lost exit is now settled from the process table (on Linux with
  the zombie's real exit code), a command killed at its deadline or on cancel
  is given up on 2 s later even if no exit is ever reported, and the hook
  narrates which of the two happened.
- **A wedged Playwright run wrote empty `network/` and `console/` evidence.**
  After a hard deadline killed the browser, the run skipped the request and
  console logs as if they lived in the dead browser; they are kept in the cairn
  process, so `requests.ndjson` came out empty and a `network` outcome on a
  request made before the wedge failed with "no requests were captured". They
  are now written and judged as captured up to the kill (agent-browser, whose
  logs live in its daemon, still skips them).
- **Closing a browser could hold the rest of the invocation.** Playwright's
  close is bounded at 10 s and then kills the browser process (also a browser a
  hard deadline abandoned without a watchdog kill), Playwright gains the
  synchronous signal-path kill agent-browser already had, and the engine bounds
  every spec's close at 90 s before killing the backend's processes, so the
  next spec, the suite `after` hooks and the exit always run.

## [3.1.1] - 2026-10-04

### Fixed

- **JSON piped out of a command could be cut at 64 KiB.** Most commands print
  their document and then exit, and a pipe is written asynchronously, so a
  slow reader (`cairn spec verify --json | jq`, an agent reading the output)
  got whatever had drained before the exit: a large spec-verify report arrived
  as 64-72 KiB of a 90 KiB document. stdout and stderr now write
  synchronously whenever they are not a terminal; a reader that closes early
  (`| head`) ends the output quietly. `cairn mcp` keeps the runtime's writer.

## [3.1.0] - 2026-10-04

Fewer `eval` files: loops, branches, retries, custom form controls, API
sign-in, request polling, workbook checks and page helpers are typed. Fewer
wrapper scripts: config composition (`vars`, `extends`, `include`), a `run:`
policy, `suites:`, `metrics:` probes, service operations (restart, logs,
tunnels, a provisioner, files), a seed transaction and an engine pin replace the
Taskfile around `cairn run`. The Playwright bridge goes both ways: an export
that can prove itself faithful (`--verify`, differential and mutation runs), fit
an existing Playwright tree (host profiles, an export map, `export.targets`) and
run host commands (`--preconditions`), and importers that turn a Playwright
test or trace into a draft spec. Every new field is optional and additive;
specs and configs that use none of them run as they did in 3.0.1.

### Added

- **Control flow.**
  - `repeat: { max (≤ 100), until?, steps, indexVar?, onMax: fail | continue }`
    loops. `until` is checked before each iteration and once after the last.
    Nested steps see `${repeat.index}` (0-based), `${repeat.iteration}`
    (1-based) and `${repeat.<indexVar>}`.
  - `if: { condition, then, else? }` branches.
  - `when:`, `repeat.until`, `if.condition` and `use.retry.until` share one
    grammar. It gains `url` and `{ var, equals | in | exists }`: a plain
    name reads config, spec or use-site vars, and a dotted name reads a
    runtime value (`waits.*`, `repeat.*`, `captures.*`, `runs.*`,
    `requests.*`, `evals.*`, `fixtures.*`).
  - `wait: { any | all: [...], timeoutMs }` and `wait.optional: true`, with
    `assign` → `${waits.<name>.matched}` / `.index`. The runner polls them
    with short bounded probes, so a miss never stops the browser.
  - `use: { action, retry: { times, until?, delayMs? } }` re-runs an
    action's steps as one group.
  - Nested steps keep stable ids (`<parent>.<n>`, `<parent>.then.<n>`, or
    their own `id`). Their results are recorded post-order (a block's steps
    before the block), and their artifacts get an `_i<n>` (iteration) or
    `_a<n>` (attempt) suffix. An unassigned `request` inside a block is
    named after its place (`request_3_2_i2`).
  - Heal returns `no-heal-possible` for a failure inside a block, and
    `teardown:` refuses control flow.
- **Widget kit.**
  - `set`, `check`, `uncheck`, `choose` and `form` steps. They find
    `field: <key>` through config `browser.fieldRoot` templates (the first
    visible match wins) or take any locator. Each step detects a driver,
    writes the value in the page and reads it back. A field that already
    holds the value is left alone. The step fails with
    `widgets/<n>_<id>.json` evidence when the field did not commit.
  - Built-in drivers: vue-multiselect, primevue-autocomplete,
    primevue-calendar, pills, radio-group, checkbox-group, native-select and
    native-input. Project drivers are modules listed under
    `browser.widgets: [{ file }]` that export `{ name, match, read, write,
    equals? }` and run in the page, like an eval file.
  - Options match by label: an exact label first, then one unique partial
    match, then the value attribute. vue-multiselect searches before it
    trusts a partial match, and a partial-label commit is named in the
    step's `detail`.
  - A single autocomplete commits only when its suggestion list closes. A
    `+Add` list ignores inputs the app rejects. A lone visible checkbox is
    never toggled for an option that is hidden.
  - `form` writes fields in order, with `dependsOn` mount waits, optional
    fields, `verify: committed | none`, a final re-read of every field and
    `onFailure: dumpUnanswered`.
  - Project drivers are bounded by the step budget, an async `match()` is
    refused, and driver modules load only for operations that pick a
    driver.
- **Click and fill flags.** `click.optional` (presence window of 750 ms ×
  waitScale; skipped with `skipReason: absent`), `click.dispatch` (a DOM
  click; fails on a disabled target) and `click.fallback: dispatch` (a hit
  test first; the step's `detail` says `pointer blocked by …`).
  `fill.mode: set` (native setter + input/change, no focus or keys, read
  back) and `fill.optional`. The in-page resolver behind them sees open
  shadow roots and names that come from image alt text.
- **Request v2.**
  - `credentials: include | omit`. `omit` sends no cookies and keeps no
    `Set-Cookie`.
  - Headers splice `${requests.<name>.…}` (a captured bearer) and
    `${secrets.X}`.
  - `until: { status?, json?, every?, timeoutMs? }` re-sends until the
    answer holds. A transport error counts as "not yet". An exhausted poll
    keeps the last answer in `requests/<name>.json` without binding it.
  - `retry: { times (≤ 10), on: [5xx | network], delayMs? }` (not with
    `until`).
  - `capture: { <key>: <path> }` → `${requests.<name>.captures.<key>}`. A
    wildcard or filter captures its first match, and a path that matches
    nothing fails the step.
  - `matrix: { <key>: [values] }` + `expectStatus` sends one request per
    combination (≤ 200) with `${matrix.<key>[.field]}` spliced into method,
    URL, headers and body. Every combination runs, and the step lists each
    mismatch.
  - `artifact.request` events gain `attempts`, `combinations` and
    `mismatches`.
- **Environment sign-in.** Config `environments.<env>.auth`
  (`alreadyAuthenticated?` probe, `login` request, `after?` follow-ups with
  `when`, `hydrate?` page script that sees only the login response) and
  the built-in `use: login` / `use: { action: login, vars }`. An imported
  action named `login` always wins.
  - Secrets resolve when the step runs and are registered for redaction
    before the first request. An unset one fails the step before anything
    is sent.
  - `use: login` satisfies the cold-start contract and heal never patches
    it. Cold-start lint, `cairn spec lint` and discovery `setup` accept it.
  - With tvault, the auth block's secret names are fetched when a flow uses
    `use: login`.
- **xlsx verifier v2.** `sheet` (name, `{ match }` or 0-based index),
  `contains` (scoped by `sheet`, every sheet otherwise), `headers`
  (`labelRow` / `keyRow` / `strip` / `caseSensitive`, `present`, `absent`,
  `labels`, `includesInOrder` and `withinListInOrder` against a list or
  `${captures.x.headers}`), `rows` (`afterKeyRow` bounds, `match` on one
  row), `cells` (`equals` / `matches` / `numFmt`) and
  `validations[].formulaMatches`. Excel 2010 `x14` validations count, and
  `sheet` is optional on validations. Operands splice runtime references;
  one that does not resolve fails the outcome at once.
- **`ctx.xlsx` in the verifier SDK** uses the same parser as the verifier
  and adds `columns({ labelRow, keyRow })`, `numFmt(ref)` and validation
  `formula1` / `formula2`.
- **Page prelude.** An eval source, a browser `script` verifier or a login
  `hydrate` script that mentions `__cairn` gets `window.__cairn` first:
  `sleep`, `visible`, `text`, `labelOf`, `nativeSet`, `fire`, `rows`,
  `waitFor`. It installs once per document, is read-only, and never
  overwrites a page-owned `window.__cairn` (the step fails instead).
  Sources that do not mention it are sent unchanged.
- **App handles.** Config `browser.appHandle: { <name>: <page expression> }`
  adds read-only accessors (`__cairn.app.<name>`, re-evaluated on every
  read), and `wait: { app: { path, equals | in | exists } }` polls one. It
  works with `optional`, `assign` and `wait.any` / `wait.all`. The value
  stays in the page. A failure preview is masked and bounded, and an
  unknown handle fails at once.
- **Evidence and events (all optional fields).** Events and `run.json` step
  results gain `parentId`, `iteration`, `branch`, `iterations`, `taken`,
  `matched`, `retries`, `via`, `driver`, `detail` and `skipReason`. A new
  `widget.field` event per field never carries the value.
- **Playwright export.**
  - `repeat` → a bounded `for`, `if` → `if/else`, `wait.any` / `all` →
    `Promise.any` / `all` (`wait.all` polls every condition each tick),
    optional waits catch the miss, and retry becomes a try/catch loop. A
    condition that reads a capture, run output or fixture is a hard skip
    unless an exported step or the global setup binds it (see below).
  - Widget steps → `cairnWidget` / `cairnWidgetForm`, which embed the
    runner's own in-page runtime (`lib/widgets` in `--project`). Dispatch
    clicks and `fill mode: set` run the same in-page operations as the
    runner, and exported widget errors hide sensitive values.
  - v2 requests → `cairnRequest` / `cairnRequestMatrix` (same retry,
    polling, matchers, filters and captures as `cairn run`). `use: login`
    → `cairnLogin(page, CAIRN_AUTH)`, with secrets read from `process.env`;
    it throws on an unset secret before sending anything.
    `cairnLoginState` writes a storageState for a globalSetup.
  - Sources that use `__cairn` run after `CAIRN_PRELUDE`, and app waits
    become `expect.poll(() => cairnAppCheck(...))` (`lib/prelude`).
  - **Export modes (E10).** `--preconditions inline|global|skip|manifest`
    decides how host commands are exported: preconditions, `run:` steps, the
    spec `teardown:`, config fixtures and `preconditions.wait` gates.
    `inline` runs them through a bounded helper in the generated runtime
    (`cairnCommand`, inlined in a standalone file, `preconditions.ts` in a
    project): a filtered child env, a process-tree deadline, `/bin/sh -c` like
    `cairn run`, and an argument-vector spawn (no shell string) for a command
    that needs none (one whose words hold an `${env.X}` / `${secrets.X}` value
    runs through the shell, like `cairn run`, which substitutes the value into
    the command text). A failing command's error carries its output tail with
    every secret scrubbed before the tail is cut (sensitive-named env and the
    `${env.X}` / `${secrets.X}` values it read), and the helper settles once
    the output is drained (500 ms after the exit at most), so an `assign`
    never loses its last stdout line. Each file's `beforeAll` runs its preconditions, `run:`
    steps run in the test body (`assign` binds the last stdout line, JSON, for
    `${runs.<name>…}` splices) and the spec `teardown:` runs in a `finally`
    on every exit path with `CAIRN_RUN_STATUS`, each item isolated, bounded by
    its `timeoutMs`, and failing the test only with `failRun: true`; a
    `teardownBestEffort` risk says what a `finally` cannot cover (a test
    timeout, a failed `beforeAll`, cairn's SIGINT path).
    `global` (`--project` / `--into`) runs gates (`cairn wait`), the
    preconditions and the config fixtures (`cairn fixtures ensure <name>
    --json`, outputs through `CAIRN_FIXTURES_FILE` and `cairnFixtureOutputs`)
    once in `global-setup`, tearing run-scoped fixtures down at the end; it
    needs the cairn CLI (`CAIRN_BIN`) and flags what it loses against a
    per-spec run as a `globalPreconditions` risk. `manifest` lists the
    commands in `.cairn-export.json` (`preconditions`, authored `${env.X}`
    text, cwd relative to `source.projectRoot`; `--check` flags a changed one).
    `skip` lists them as a soft skip. Command text comes from the spec and
    `${env.X}` / `${secrets.X}` stay `process.env` reads at run time. Without
    the flag nothing changes: a standalone file skips preconditions,
    `--project` / `--into` run them per file, and run steps, teardown,
    fixtures and gates stay unexported. The flag, `--verifiers` and
    `--gate-env` are also MCP `cairn_export_playwright` inputs
    (`preconditions`, `verifiers`, `gateEnv`), recorded in the manifest and
    followed by `--check`.
  - `--verifiers keep|gate|drop` for node and datasource verifiers. `gate`
    runs a node file verifier only when its required env is set (the env its
    fixtures read, its config datasource's, `--gate-env`); otherwise the test
    ends `test.skip(...)` after every other assertion held and after the
    teardown — reported skipped, never passed — and a verifier an export can
    never run (`mongo` / `temporal` / `http`, inline node scripts) is
    recorded as skipped instead of marking the whole test `test.fixme`.
    `drop` omits them with a `verifierDropped` risk.
  - `${env.X:-default}` in a spec (strings and its own `vars:`) is read when
    the test runs: `(process.env.X || "default")` — an unset or empty
    variable falls back like `cairn run` — instead of being baked at export
    time, so the exported suite follows its environment (a
    `${env.TRANSPORT:-queue}` default is no longer frozen into the test).
    Such env is listed as optional. No `${env.X}` value that is set while
    exporting reaches generated code, the manifest, a report or an error
    (secrets were already never inlined): the config is loaded late-bound
    too, so a config var, the environment `baseUrl` (`baseURL:
    (process.env.APP_URL || "…")` in a project), the `auth:` block of `use:
    login` (also when an export map turns it into an `apiLogin`
    storageState) and the datasources read `process.env` when the test runs,
    and `--check` no longer depends on those values. A typed config field
    the export emits that only an environment value could fill (a viewport
    width from `${env.X}`) is refused naming the field, and so is a
    `browser.testIdAttribute` / `fieldRoot` / `widgets` / `appHandle` holding
    `${env.X}` (strings, but written into code as literals: before, only
    the leaked-placeholder backstop stopped them, with exit 2 and an unclear
    message under `--project`); one it does not emit
    (`webServer.url: ${env.APP_URL:-…}`) no longer blocks the late load,
    which used to fall back silently to the substituted config and bake a
    datasource header or the login password.
  - Primitives that used to be hard skips now export. `capture` steps
    (text / value / attribute / table) run the runner's own in-page probe
    (`cairnCapture`, `lib/probe`) and bind `${captures.<name>…}`. A verifier
    `poll` exports as `expect(...).toPass({ timeout, intervals })`, and
    `poll.stableMs` as `cairnPoll` (the runner's stability window, flagged
    `pollApproximated`; each sample checks once, through
    `expect.configure({ timeout: 1 })`, because a web-first assertion would
    wait a red sample out and pass a flapping state). `when:` / `expect` conditions reading a bound run
    output, capture or fixture translate too. The `table` verifier exports
    through the same probe (`cairnReadTable` / `cairnJudgeTable`).
  - Data verifiers and steps export too, judged by the runner's OWN code
    instead of a re-implementation. The matcher engine, the `${…}`
    resolver and the network / response / `httpJson` / `file` / `xlsx`
    judges, the HTTP wire rules and the workbook reader are emitted from the
    real modules (a checked-in generated copy, `runtimeSources.generated.ts`,
    with a drift test that fails until it is regenerated:
    `CAIRN_UPDATE_GENERATED=1 bun run test
    src/core/exporters/runtimeSources.test.ts`); a project writes them as
    `lib/runtime/matchers`, `refs`, `networkJudge`, `httpWire`, `xlsxJudge`, …
    (a folder of their own, so an `--into` tree keeps its `lib/url`, `lib/refs`)
    plus thin `lib/data*` glue, a single file inlines what
    it calls. Equivalence tests run the generated JavaScript against the
    runner for every matcher, reference form and verifier (the `http`
    verifier over real servers: credentials, redirects, bodies, sizes,
    timeouts, scrubbing). Everything an export writes — the vendored runtime,
    the command helper, the global setup, a standalone file — compiles
    against lib ES2022 (no `toSorted` / `toReversed`), so a host tsconfig
    that predates ES2023 typechecks it; the compile tests hold every export
    shape to `lib.es2022`.
    - `value` and typed references: `${requests|evals|captures|network|fixtures|runs|artifacts.…}`
      resolve like the runner (a whole reference keeps its type; an
      unresolved one fails the check); one with no producer in the export is
      a hard skip naming it.
    - `http` runs through Playwright's `APIRequestContext` (no browser
      cookies) with the runner's header / body / redirect / size / error rules.
      A `kind: http` datasource is baked as `baseUrl` and header names with
      `${secrets.X}` / `${env.X}` (`:-default` included) as `process.env` reads at
      test time (never a value: the config is loaded late-bound, so a set
      `${env.X}` is not baked either); missing env fails with a clear message under `--verifiers keep`
      and is reported skipped under `gate`. `assign` binds
      `${captures.<assign>…}`.
    - `httpJson` `matches` / `atLeast` / `atMost` (and every other matcher)
      use the runner's judge; `network` `body` / `count` / `assign` judge a
      richer in-memory request log (bodies and times, request steps included)
      and `network.assign` binds `${network.<assign>…}`; `expect.request` steps
      send through `page.request` and retry GET / HEAD like the runner.
      `noFailedRequests` is judged by the runner's own
      `judgeNoFailedRequests` over that log, which now records network
      failures (`requestfailed`, a request finished without a response): an
      aborted or refused request fails it like `cairn run`, where the export
      used to check `status >= 400` only.
    - `file` and `xlsx` (`--project`; reader shipped as `lib/runtime/workbook.js` +
      `.d.ts`) verifiers, and `transform` steps (the module is copied next to
      the project and run in the test process: new `transformInProcess` risk)
      export. `process` verifiers keep a precise hard skip.
    - `examples/flows`: `test.fixme` 6 of 24 → 3 by default, 2 with
      `--preconditions inline`, 0 with `--preconditions global` (the rest need
      a `run:` step or fixtures, which only the host modes export).
  - `cairn export playwright --verify` proves an export is faithful. Static
    gates need no browser: no leaked late-bound sentinel, `tsc` with the
    target's own tsconfig (a generated project is also held to
    `noUnusedLocals`; a host tsconfig is used as is, and export files it does
    not include get a strict fallback; host errors are not the export's), the
    host's eslint when a config exists, `playwright test --list` shows one
    test per exported spec (deliberate `test.fixme` skips are counted and
    reported), and manifest freshness (the `--check` engine). Each gate is
    `passed`, `failed` or `skipped` with a reason, and a skipped gate is
    never a pass; the tools are the target's local binaries and are never
    installed. `--verify <dir>` verifies a directory, a bare `--verify` the
    export just written (its own report goes to stderr, so stdout carries the
    verify report alone), `--verify-strict` turns skipped and inconclusive
    results into failures. Exit 0 all pass, 1 a gate / differential / mutant
    failed, 2 usage or environment error, 3 inconclusive (report `status:
    inconclusive`): what was requested proved nothing — neither tsc nor
    `playwright test --list` ran, the differential matched no spec, or no
    mutant was killed or survived — never a pass. A file the host's eslint
    config ignores was not linted (lint skipped, naming it), and a tsc that
    crashed, timed out or rejected its options checked nothing (typecheck
    skipped). Every verify first removes a mutant an interrupted `--mutate`
    left in the tree. The lint gate never hands eslint the vendored runtime
    (`lib/` except `lib/pages/`, the command helper, the global setup: copies
    of the runner's modules with an `eslint-disable` banner), so a host
    eslint config that does not cover `.js` (`lib/runtime/workbook.js`) no
    longer leaves the gate skipped forever.
  - **Multi-project hosts.** On a host config with several `projects` — the
    `npm init playwright` chromium / firefox / webkit trio, devices with a
    setup project and `dependencies` — every Playwright run of the verify
    (the list gate, the differential, the mutants) uses one project, passed
    as `--project`; Playwright still runs its dependencies, and a failed
    dependency makes the spec an `error` naming it. Before, the list gate
    failed (`3 tests listed, expected 1`) and the differential ran every
    browser. The project is `--verify-project <name>` (MCP
    `verifyProject`), else the one the manifest recorded at export time (the
    flag, or the new `export.targets.<name>.verifyProject`;
    `source.verifyProject`), else the first project, among those that
    discover the most exported tests, that runs Chromium (`use.browserName`
    or the device's browser, read statically from the host's playwright-core
    descriptors), else whose name says Chromium, else the first. The report's
    new `playwrightProject` says which, from where and why; an unknown name
    is exit 2.
  - `--verify=differential` (or `--differential`; needs the app up) runs
    `cairn run --backend playwright` and the exported test with the same
    `CAIRN_RUN_TOKEN`, sequentially, cairn first, and compares per-step and
    per-outcome verdicts by id (an exported step is its `test.step` title;
    action steps repeat ids and are not compared), the requests each network outcome matched, and the duration
    (`--duration-ratio`, default 3, ignoring start-up-sized gaps). A
    baseline that did not pass is `inconclusive` when the export agrees with
    it (both failed: the app or spec is unhealthy), never a match; a
    disagreement is a `mismatch`. A skipped export (`test.fixme`, gated) is
    `skipped`, or `inconclusive` when `cairn run` failed; a gated export is
    first compared on the steps and outcomes it did judge before it ended
    skipped, and a disagreement there (the runner failed an outcome the
    export passed, or the reverse) is a `mismatch`. Project
    network outcomes now record a `cairn:network` annotation with the count
    they matched. `--verify-only <spec>` narrows the runs to some specs.
    Specs that mutate shared state must be idempotent or reset by
    preconditions / teardown, because both sides run.
  - `--mutate[=all]` inverts one assertion per spec (`all`: every outcome) in
    a temp copy of the exported test; the test must fail at that outcome. A
    mutant that still passes is an `assertion not effective` finding; an
    outcome judged by a throwing helper has no matcher to invert and is
    reported `not-applicable`. Outcome steps are read from the test's
    TypeScript syntax tree and the source spec's outcome ids, so a host's
    prettier (single quotes, broken lines) no longer turns the mutation into
    a silent no-op.
  - The report is `urn:cairntrace.dev:export-verify:v1` (json, yaml or md on
    stdout), written to `.cairn-export-verify.json` and `.md` in the export
    and summarized in `.cairn-export.json`'s new `verify` field. A
    re-export keeps the summary only while the exported files are identical.
    MCP: `cairn_export_verify`.
  - `cairn run --run-token <token>` (MCP `runToken`) pins `${run.token}` /
    `CAIRN_RUN_TOKEN` (1-64 of letters, digits, `_`, `.`, `-`) instead of a
    random one, so a run and an exported test write the same unique values.
  - **Host profiles (E8).** `cairn export playwright --into <dir>
    --host-config <playwright.config>` fits the generated code to an existing
    Playwright tree. The host's config, its tsconfig (with `extends`) and
    nearest `package.json` are read statically (a TypeScript syntax tree; the
    config never runs; constants, relative imports of other config modules,
    `__dirname`, `path.join` / `path.resolve`, templates, `??` / `||` with
    JavaScript truthiness and `defineConfig` merging are followed; a device,
    spread or a bare `use: devices["…"]`, sets none of the options read).
    Options
    resolve the way Playwright resolves them: a project's value over the top
    level (`use` merged key by key), and only the projects whose `testDir` /
    `testMatch` / `testIgnore` discover the generated tests count; `testMatch`
    is matched with Playwright's own file matcher (regex against the absolute
    path, globs prefixed with `**/`). An option that cannot be read (computed,
    behind a spread or import it cannot follow, or disagreeing between the
    running projects) is named in the report's `host.unread` / `host.notes`
    and never replaced by a default: an unread timeout makes every test set its
    own derived budget, an unread `testIdAttribute` makes `testid` locators
    explicit attribute selectors, an unread `bypassCSP` counts as not set, and
    an unread `testDir` / `testMatch` / `testIgnore` / `projects` refuses the
    export (exit 2). What it adapts: module system (CommonJS → `__dirname`, ESM →
    `import.meta.url`, which also fixes `lib/projectRoot` and
    `lib/fixtures` in a CommonJS host; node16 / nodenext ESM — set or implied
    by `module` — gets `.js` import extensions), test timeouts
    (`test.setTimeout` only when a spec's derived budget is above the host's),
    `testIdAttribute` (explicit attribute selectors, run-time values
    CSS-escaped, when the host reads another attribute than the spec means;
    `process.env.X ?? "lit"` uses the fallback and says so), `bypassCSP` (page
    evals — `eval`, `wait: { app }`, browser scripts, teardown included — are
    refused unless the running projects set it or
    `--allow-eval-without-bypass` is given), `use.storageState` (a
    `coldStart: guest` spec resets it), `testDir` / `testMatch` /
    `testIgnore` (tests are placed and named so the host discovers them; an
    `--into` it would not discover is an error), tsconfig `paths` aliases,
    used and ordered imports, camelCase identifiers (an alias suffix when two
    names collapse), braces on every `if`, an `eslint-disable` banner on
    vendored runtime files, and the host's local prettier when it has a
    prettier config (never installed). `--host-config` (and `--check` /
    `--verify` of such an export) runs the host's own local prettier — its
    JavaScript config and plugins load — and `--verify` its local eslint, tsc
    and `playwright --list`; configs and binaries are looked up only up to the
    host's boundary (the nearest `.git`, else the outermost package root below
    the home directory), never a stray `~/.prettierrc`. The report carries
    `host` (with `projects` and `unread`); the manifest records
    `source.hostConfig`, so `--check` and `--verify` regenerate with the same
    profile. MCP: `hostConfig`, `allowEvalWithoutBypass`.
  - **Export targets.** `export: { targets: { <name>: { input, into,
    hostConfig, preconditions, verifiers, gateEnv, lang, env, mapFile,
    maxEvalRatio, allowEvalWithoutBypass, verifyProject } } }` in the config, used by
    `cairn export playwright --target <name>` (MCP `target`; a flag overrides
    the profile field; paths are relative to the config). `cairn config
    validate` checks each target as an export request on its own and lists them
    under `exportTargets`. `mapFile` is the export map (below); `config validate`
    checks that it exists, parses and names files.
  - **Export map (E9).** `--map <export.map.yml>` (profile and MCP `mapFile`; with
    `--into` / `--project`) binds cairn actions to the host tree's own
    constructs instead of inlining their steps. `fixture`: the test takes the
    host's fixture in its signature (`async ({ page, memberSession }) =>`, `test`
    imported from the host's module, `providesPage` for a fixture that hands out
    the page); the vars a call passes map to `test.use` options (the action's
    default when the call passes none), are checked against constants, or are
    ignored, and any other is an error. `method`:
    `await new OrdersPage(page).openOrder(arg)` (or a fixture's instance, which
    must share the spec's `test` module) with arguments mapped from the
    action's vars; host imports follow the host's alias, relative path and `.js`
    extension (a barrel stays `…/index.js`, `.mts` / `.cts` become `.mjs` /
    `.cjs`). `apiLogin`: a request-only login (detected only for a leading
    call named login / log_in / signin / sign_in / authenticate — never logout,
    revoke, delete, refresh, reset … — or mapped explicitly) becomes
    `lib/authState`: `request.newContext`, the session saved under `.auth/`
    owner-only (0600) and atomically (git-ignored; a path outside `.auth/` is
    an error), signed in once per process in a `test.beforeAll` or once in
    `global-setup` with `--preconditions global`, or taken from the host's own
    `setupProject`; credentials are `process.env` reads at run time and never
    appear in generated code, manifest, reports or the saved state. `when`
    picks a mapping by the call's var, `note` is kept in the report, and
    `strict: true` makes an unmapped action a listed error. Unmapped actions
    become generated page objects under `lib/pages/` (one class per action, or
    several with `generate.class`; a derived name that is already a host class
    the map imports gets a number), extending the map's `basePage` or a
    generated minimal base, formatted by the host's prettier and subject to its
    lint rules. The manifest records `source.map` (file and a content digest), so
    `--check` regenerates with the map and warns when it changed; the report
    carries `map` and each spec's `mapped`, and the README an Export map
    section. A fixture or storageState that replaces a `use:` which was not
    first adds the `mappedOrdering` risk; an API login's storageState in a test
    whose page comes from a `providesPage` fixture adds `mappedStorageState`.
    `--verify` typechecks a mapped export against the host's real fixture and
    page-object types.
  - **Eval ratio (E12).** `--max-eval-ratio <0..1>` (profile and MCP
    `maxEvalRatio`) refuses a spec whose share of page `eval` steps (imported
    actions, blocks and `teardown:` included) is above the limit. Per spec: the others are
    exported, the refusals are listed (`refused`, stderr) and the command exits
    1; every spec refused writes nothing. Coverage gains
    `evalRatio: { evalSteps, totalSteps, ratio }`, the markdown report prints
    `eval 2/3 (67%)`, and `cairn spec lint` warns (`eval-ratio`) when an
    `export.targets` limit would refuse the spec. The manifest records the
    limit, so `--check` / `--verify` regenerate the same set.
- **Config composition.** A config value lives once instead of once per
  environment. A config that uses none of this reads exactly as before
  (anchors and `<<:` merge keys included).
  - Top-level `vars:` apply to every environment; an environment's own
    `vars` win by name. An environment the config does not define still
    gets them.
  - `environments.<n>.extends: <other>` deep-merges another environment:
    objects key by key, lists and scalars replace, `vars` by name,
    `services: false` / `datasources.<name>: false` replace. Chains work;
    a cycle or an unknown name is a config error, and the merged
    environment is validated again.
  - Vars may reference vars (`apiUrl: "${vars.host}/api"`), resolved once
    per environment after the merge. A value that is exactly one reference
    keeps the referenced type; `${vars.x:-default}` falls back. A cycle is a
    config error naming the var and environments; a reference to a var the
    config does not define is a warning and resolves at run time from the
    authored template (`runTag: "${vars.ticket}-smoke"` with `--var
    ticket=…`). References are only read from what was authored: a
    `${vars.X}` inside an env value or a secret stays inert, as in 3.0.1.
  - Typed vars: lists and objects. An unquoted whole `key: ${vars.x}` keeps
    the structure (a script verifier's `fixtures:`, a fixture's `with:`,
    `ctx.vars`); string contexts render compact JSON; `${vars.x.key}` and
    `${vars.x.0}` read inside (specs, fixtures, datasources, environment
    login, Playwright export).
  - `include: [paths or globs]` merges `vars`, `fixtures`, `gates`,
    `datasources` and `suites` from other YAML files, validated with the
    same schema. Later files win and the including file wins; every
    override is a finding with both locations. A missing file or an include
    cycle is an error, a glob that matches nothing a warning.
  - `environments.<n>.include: [paths or globs]` merges files of that
    environment's own `vars` (the files hold `vars:` and `include:` only,
    so environments with different var sets split into
    `config/vars/<env>.yml` without promoting names to the top level).
    Precedence: top-level vars < the `extends` chain (each member's files,
    then its own vars) < the environment's files < its own inline vars.
    Overrides inside one environment are findings keyed
    `environments.<n>.vars.<name>`; cycles, missing files and other keys
    are errors naming the file, and an include cannot declare an
    environment. `cairn config vars` reports `file:line` of the included
    definition, dead-var and `literal-var-ref` warnings work as before, and
    `${env.X}` in these files stays late-bound for `cairn export
    playwright`.
  - `cairn config vars [--env] [--unused] [--used-by <spec>]` and MCP
    `cairn_config_vars` (`urn:cairntrace.dev:config-vars:v1`): each var's
    kind, effective value per environment (secret-like values masked, and a
    var whose value carries env or secret data — at any depth, or through
    another var — shows its authored template, `fromEnvironment: true`),
    definitions
    (`file:line`), overrides and uses (specs, actions, script verifiers that
    read `ctx.vars`, fixtures, datasources, gates, suites, env login, other
    vars).
  - `cairn config validate` reports composition errors, dead vars as
    warnings, include overrides as `findings` and the merged `includes`.
  - `cairn catalog` var rows gain `definedIn: top-level | extends` and
    `file` for vars an environment does not write itself, and rows for
    `vars: *anchor` aliases.
- **Run policy.** A config `run:` block replaces the wrapper script around
  `cairn run`. The run engine enforces it for the CLI and for MCP `cairn_run`
  alike; a config without `run:` runs as before. A top-level `run:` applies
  to every environment and `environments.<n>.run` merges over it key by key.
  - `lock: true | { scope: config | project, staleAfterPidDead }`: one run at
    a time per config (or per `project:`). `~/.cairntrace/locks/…run.lock.json`
    holds the owner's pid, start time, redacted argv (`--var` keys only),
    invocation and env, is taken atomically before anything starts and is
    released on every exit path, signals included. A live foreign owner
    refuses with exit 4 naming its pid, age and command; a dead owner's lock
    (or a recycled pid) is reclaimed with a warning. A policy guards one
    config: specs from several configs where any declares `run:` (or
    `runtimes.node`) are refused with exit 4, naming each config with a spec
    that resolves to it (run each config's specs on their own, or pass
    `--config` to run them all under one; a suite's specs still load their
    nearest config), and so is a `run:` whose config does not load.
    `cairn services up | down | restart` (and `cairn_services_up|down|restart`)
    respect the lock: while a live run of the config (or of the `project:`,
    for any lock scope the config declares) holds it they refuse with exit 4,
    touch nothing — no provisioner `down` under a live run's billable
    resource, no tunnel stopped — and name the owner (`runLock` in their
    result; stopping the run runs its own teardown). Otherwise they hold the
    lock for their own duration (the lock file names the holder, `command:
    services down`, and a run started meanwhile refuses), reclaim a dead
    owner's lock as a run does, and a command the owner started itself (a
    suite hook, a `run:` step) runs under the owner's lock: the run exports
    `CAIRN_RUN_LOCK` to its processes.
  - `preflight: [{ json, assert } | { secret } | { command, expectExit?,
    timeout? } | { gate }]` runs after secrets resolve and before any service
    starts. The first failure refuses the run (exit 4) naming the check;
    messages are redacted and a secret is only checked for presence (with
    `secrets.provider: tvault` it is fetched from the vault, like every
    `${env.X}` of a preflight command or a `finally` entry). `assert`
    is a small language (paths, `== != < <= > >=`, `in [..]`, `exists`,
    `and` / `or` / `not`, parentheses) with a real parser, never `eval`;
    `cairn config validate` reports a syntax error with its offset (nesting
    deeper than 64 or more than 1024 tokens included), an unknown `gate` and a
    malformed check. `when: { suite, env }` limits a check to those suites
    and environments (as on seed post-commands): the others are named as
    skipped and a failure keeps the check's own index.
  - `verifyClean: [browsers | tmux | docker-project]` (or `{ tmux: name }`,
    `{ docker-project: name }`) asserts before the run (dirty = exit 4) and
    after it (dirty = exit 9, listing the survivors). Only cairn-owned or
    this-project resources count: browsers the session ledger names (while
    still the same process), or agent-browser daemons of cairn run sessions
    working inside the project; never another project's, a discovery or user
    session, or cairn's own ancestors. A Docker daemon that is not running
    counts as clean, with a warning. It kills nothing; under
    `--reuse-services` only `browsers` is checked.
  - `finally: [commands]` run after the teardown with `CAIRN_EXIT_CODE` and
    `CAIRN_INVOCATION_DIR`. They are non-fatal and journaled. On SIGINT /
    SIGTERM they run synchronously after the services teardown (with the
    suite's `after` hooks before it, and every still-running command of the
    run ended first), each bounded by `CAIRN_SIGNAL_HOOK_TIMEOUT_MS` and
    together by three times that in a window of their own (the suite's
    `after` hooks have theirs), and the lock is released last.
  - `services.teardown` entries accept `{ run, critical: true, timeout,
    onSignal: wait }`. A failed or timed-out critical entry is exit 8. `timeout`
    kills the entry's process group, and `onSignal: wait` makes the
    SIGINT/SIGTERM path wait for it up to that timeout instead of the short
    signal cap.
  - Journal: `run.lock.acquired|reclaimed|refused|released`,
    `preflight.started|passed|failed`, `cleanliness.clean|dirty` and
    `finally.started|finished` events (additive in `events.v1`, with goldens),
    `critical: true` on the `services.teardown.*` events of a critical entry,
    and `summary.runPolicy` (`lock`, `criticalTeardown`, `dirty`,
    `finallyFailed`) in `invocation.json`.
- **`cairn run --bail`** (MCP `bail`). The first failed or errored spec stops
  the scheduling of the rest. They are reported as skipped, never as results:
  `BatchRunResult.skipped[]` (`reason: bailed`, `bailedBy`), `summary.skipped`
  and an `invocation.bailed` event. Specs already running finish, teardown runs
  as usual, the exit code follows the usual precedence over the specs that
  ran (skipped ones do not count), and `--repeat` / `--matrix` stop starting
  iterations.
- **Owned browser-session ledger and `cairn doctor --orphans`.** Every
  agent-browser or Playwright session cairn starts is recorded in
  `~/.cairntrace/sessions-ledger/` (session, backend, invocation, owner pid,
  browser pids with their start time and command) and removed when the browser
  closed cleanly. `cairn doctor --orphans [--kill] [--yes] [--only
  <session|pid,...>] --json` (`urn:cairntrace.dev:doctor-orphans:v1`) lists the
  sessions whose cairn process is gone but whose browser survives; `--kill`
  ends them after a confirmation on a terminal, or with `--yes` (a structured
  or non-interactive run never prompts). Only a ledger-named process that is
  still the one cairn learnt and still looks like a browser cairn launches is
  listed, and it is checked again right before it is signalled; entries whose
  owner is gone for 7 days expire.
- **Suites.** A config `suites:` registry replaces a Taskfile's suite switch:
  `cairn run --suite <name> [--env]` (MCP `cairn_run { suite }`, no spec paths
  needed) runs a named, ordered spec set.
  - `suites.<name>`: `specs` (paths, directories, globs, spec names; `dir/**`
    means everything below), `tags` (AND on `metadata.tags`), `order` (these
    first), `parallel`, `bail`, `requires: { env, vars }`, `vars`, `before` /
    `after` / `hookTimeoutMs`, `description`, `processEnv`, `labels`,
    per-environment `env.<name>: { vars, before, after, hookTimeoutMs, specs,
    bail, processEnv, labels, seed }` (its `specs` and `bail` replace the
    suite's, its `processEnv` / `labels` merge over the suite's by name, its
    `seed.postCommands.skip` adds to the suite's) and `seed.postCommands.skip`. Drafts (`_` folders and
    files) are skipped by directories and globs and run when named by path.
    `suites` merges through `include:`; an environment name that the config
    does not define is a schema error.
  - Precedence: `--parallel` beats the suite's `parallel`, `--bail` adds to its
    `bail` and `--no-bail` (MCP `bail: false`) turns it off, `--var` beats its
    vars — in the specs and in the hooks' `CAIRN_SUITE_VAR_<NAME>` alike —
    and `--tag` narrows it. Every run is labelled with the suite's `labels`,
    then `suite=<name>`, then the caller's `--label` (later wins; `cairn stats
    --group-by suite`). Suite vars resolve once
    the vault's secrets are in (`requires.vars` is checked then); a suite var
    whose `${env.X}` is still unset is not passed. Two vars that reach hooks
    as the same `CAIRN_SUITE_VAR_<NAME>` are a `cairn config validate` error.
  - Spec paths next to `--suite` narrow it to those of its own specs, with
    its hooks, vars and labels (what a delegated runner's `cairnArgs` carry
    when the local policy refused a spec); a path that is not one of its specs
    is a usage error (exit 2). An unknown suite or
    a reference that names no spec, an ambiguous name, an `order` entry outside
    the selection or an empty selection is exit 4; `requires` ruling the
    environment out is exit 7.
  - `before` hooks run once after services and the webServer are up (a failure
    or timeout is exit 2); `after` hooks run once on every exit path once the
    before phase began (a cancel or a signal included) with `CAIRN_EXIT_CODE`
    (the specs' verdict; 130 / 143 on a signal), services still up, non-fatal.
    Both run in the config directory, bounded by `hookTimeoutMs` (default
    `--hook-timeout-ms`, process group killed at the deadline), and see
    `CAIRN_SUITE`, `CAIRN_SUITE_VAR_<NAME>` and `CAIRN_INVOCATION_DIR`. Hooks
    the config declares (suite hooks, `run.preflight` / `run.finally` commands,
    metric commands) are trusted like `services`: MCP's `--allow-hooks` gates
    only the `before` / `after` a `cairn_run` request carries.
  - `processEnv: { NAME: value }` (and `env.<name>.processEnv`) exports
    environment variables to every process of the run: `run.preflight`
    commands, the services phases (provisioner, tunnels, docker, seed), suite
    hooks, specs, their commands and verifiers; `${env.X}` in the config and
    specs resolves against them. Values may use `${env.X}` / `${vars.X}`
    and resolve once the vault's secrets are in; an entry whose `${env.X}`
    is unset is not exported (a warning says so). `PATH`, `HOME`, `SHELL`,
    `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `TVAULT_*` and the variables cairn
    sets itself (`CAIRN_SUITE`, `CAIRN_SUITE_VAR_*`, `CAIRN_EXIT_CODE`, …)
    are refused; only names reach the log, `suites list` and the catalog.
  - `seed.postCommands.skip` drops the named seed post-commands from the run's
    services plan (a named post-command is matched by `name`, a plain string one by
    its exact command text); an entry that matches none warns.
    `env.<name>.seed.postCommands.skip` adds an environment's own skips, so a
    suite that runs in several environments skips an environment-only
    post-command only there (`cairn config validate` checks those against
    that environment's post-commands).
  - Journal (additive in `events.v1`, with a golden): `suite.started`,
    `suite.hook.started|finished` (live log `logs/hook-suite-<phase>-NN.log`) and
    `suite.finished`; `invocation.json` gains `suite`.
  - `cairn suites list [--config] [--env] [--json]`
    (`urn:cairntrace.dev:suites:v1`) and `cairn catalog --kind suites` (MCP
    `cairn_catalog`) list each suite with the spec files it resolves to per
    environment, or why it does not (hook counts and var names, never commands
    or values; per environment its own `bail`, the seed skips it adds, the
    `processEnv` names and the labels). `cairn config validate` resolves every suite per environment and
    reports one that resolves to nothing; a `seed.postCommands.skip` entry that
    matches no post-command is a warning.
- **Metric probes.** A config `metrics:` list (and `environments.<n>.metrics`,
  merged over it by name) replaces `--after` collector scripts.
  - A probe has a `command` with `parse: { json: <path>, reduce? }` or
    `{ regex, group?, unit? }`, or an `http` GET (`headers`, `auth: { bearer |
    basic }`, `json: { path, reduce?: sum | max | min | count }`); `sample:
    [before, after]` (default) or `every: <duration ≥ 250ms>`; `scope: spec`
    (default) or `invocation`; `timeout` (default 10s, max 5m). `${secrets.X}`,
    `${env.X}` and `${vars.X}` in an `http` block stay placeholders when the
    config loads and resolve at every sample; an unset one fails that sample.
  - Results land in `<runDir>/diagnostics/metrics.json`
    (`urn:cairntrace.dev:metrics:v1`: before, after, delta, series stats,
    failures) and as flat `<name>.before|after|delta` (`.min|.max|.mean` for
    `every`) numerics merged into `diagnostics/report.json` after the `--after`
    hooks, so `cairn stats --metric <name>.delta` works (stats reads non-negative
    numbers). Invocation-scope rows also go to `<journal>/metrics.json` and to
    every run of the iteration (stamped with the `--repeat` / `--matrix`
    iteration). A `metric.sampled` event records each before/after sample.
  - Every sample is bounded (process group or request killed at the deadline).
    A failure is recorded, warned once per metric and never fatal. `every:` ticks
    stop with their scope: timer cleared, in-flight probe killed. Secrets, env values,
    tokens and header values are scrubbed from errors and artifacts; an HTTP
    source is recorded by its config template (origin + path, without the
    query), never a resolved value. `dispose()` also cancels a `before` sample in
    flight.
- **`cairn stats --invocation <id>`** keeps the runs of one `cairn run`
  invocation (`run.json` `invocation.id`, the `_invocations/<id>` name); the
  result carries `invocation`.
- **Service operations.** Config replaces the Taskfile glue around a long-lived
  stack. Every key is optional; phases run provisioner → tunnels → docker →
  files → seed → tmux and tear down in reverse.
  - `cairn services restart <window...> [--stop-timeout] [--ready-timeout]`
    (`urn:cairntrace.dev:services-restart:v1`): Ctrl-C, wait for the pane's
    process to exit (never a hard kill), clear the history, print a
    `@@cairn-restart:<id>@@` marker, resend the window's `env`, `preCommands`
    and `command`, and wait for `readyOn` of the new generation (text only below
    the marker, so stale scrollback never counts). It refuses with exit 4,
    touching nothing, a window the config does not own, a session that is not
    running, a window missing from it, and a session a live `cairn run` is
    supervising (its `tmux-supervisor.*.json` marker names the run). A pane
    whose shell runs a foreground job (`bash start.sh`) counts as running.
  - MCP: `cairn_services_restart` (needs `--allow-services`) and the read-only
    `cairn_services_logs`, with the same results.
  - `cairn services logs <window> [--since-restart] [--lines] [--wait <regex>
    --timeout] [--follow]` (`urn:cairntrace.dev:services-logs:v1`): the redacted
    pane with wrapped lines joined; `--wait` is exit 0 on a match, 1 on timeout.
    There is no `services exec`: typed keys race the service and report no exit
    status (use a `run:` step, `teardown`/`finally`, a fixture or `restart`).
  - tmux windows: `restart: { policy: on-exit | never, backoff, max }` and
    `healthcheck.onUnhealthy: restart | warn`, supervised by cairn while a run is
    active (backoff default 1s doubling to 30s, `max` consecutive restarts
    default 5, then `services.restart.giveup`). `cairn services up` exits after
    the boot, so it supervises nothing. `tmux.columns` / `rows` size new sessions
    (default 250x50).
  - `services.tunnels: [{ name, command, restart: always | never, giveUpAfter,
    backoff, ready: gate }]`: own process group, pid, state and owner under
    `~/.cairntrace/services/<project>.<env>.<config hash>.tunnel.<name>.json`, a
    failed start reports the tunnel's output, a copy a crashed run left behind is
    stopped first (one a live run owns is never touched: the boot fails
    instead), only a running tunnel's own process (start time checked) is ever
    signalled, and every tunnel is stopped on every exit path (normal end,
    failed boot, SIGINT/SIGTERM, `services down`).
  - `services.provisioner: { up, down, exports }`: `down` is mandatory, defaults
    to `critical: true` and `onSignal: wait`, and is registered before `up` runs
    through the same critical-teardown machinery, so it runs after a failed `up`,
    a failed later phase and SIGINT/SIGTERM, after the tmux session and tunnels.
    A failed `down` is exit 8 (`cairn services down` too, and `cairn services
    up` when its failed boot's cleanup could not complete it: `teardown[]` and
    the boot's `events[]` say so). An `up` that failed or was cancelled before
    its exports still gets them evaluated for the `down`, and a SIGINT/SIGTERM
    during `up` forwards SIGTERM to it and waits up to the `down`'s own budget
    before the `down` runs. `exports` (each
    command prints one value) become env for every later phase, hook, spec and
    verifier; events carry names only and credential-named values are redacted.
    A provisioned environment never reuses a tmux session, and `--reuse-services`
    evaluates the exports again.
  - `services.files: [{ path, json | text, restart, mode }]`: atomic, validated
    writes (temp file + rename; an existing file that is not a JSON object is
    never overwritten; a symlink is written through to its target; an existing
    file keeps its mode and a new one is `600` unless `mode` says otherwise),
    `${exports.NAME}` / `${env.NAME}` in values, before/after fingerprints keyed
    per run (`hmac-sha256:`, never content) in the journal, and a restart of the
    listed windows that were already running when the content changed.
  - `cairn services status` lists each tunnel (state, pid, whether it runs), the
    names a provisioner exports (never values) and, for a phased seed, each
    phase's last outcome and a pending resume.
  - `environments.<n>.services.docker: false` drops the docker phase;
    `provisioner` merges key by key, `tunnels` and `files` replace, and `false`
    removes any of them. An environment's block also stands alone when the
    config has no top-level `services:` (a provisioner only one environment
    owns); `cairn config validate` reports a provisioner left without `up` or
    `down` after the merge, and lists the phases each environment boots
    (`environmentServices`); `cairn catalog --kind envs` lists
    `provisioner`, `tunnels` and `files` next to docker / seed / tmux.
  - `cairn run --services-dry-run` prints the whole plan: the environment, the
    suite and its `processEnv` names, the provisioner's `up` / `down` and export
    names, each tunnel (and its `ready` gate), each file, the seed
    post-commands that run, the ones the suite skips and the ones a `when`
    leaves out, and how many teardown entries are critical; without services
    it says so.
  - Journal (additive in `events.v1`, with goldens `services-ops-pass`,
    `services-ops-fail`, `services-restart`): `services.provisioner.start|ready|
    exports|fail`, `services.tunnel.start|ready|exit|restart|giveup|stop|fail`,
    `services.files.write|unchanged|fail`, `services.restart.start|stop|ready|fail|
    giveup`; the provisioner's `down` appears as `services.teardown.*` with
    `provisioner: true`; live log `logs/services-provisioner.log`.
- **Seed transaction.**
  - `services.seed.phases: [{ name, command | run, skipIf, always }]` replaces the
    single `command`: a phase is skipped when a recorded success of the same
    command is within `ttlSeconds` or its `skipIf` (a command or a gate) passes.
    Each outcome is persisted per project + environment + `seed.target` hash and a
    failure is recorded at once; a run that failed on a phase is resumed, so the
    phases that had succeeded in it are skipped next time — once: a resumed
    phase with a `skipIf` must still pass it, a resume older than `ttlSeconds`
    is ignored, a phase only carried by a resume is not carried again, and a
    teardown (failure cleanup, signal, `cairn services down`) drops it. Events `services.seed.phase.start|skip|complete|fail`.
  - `seed.commit: afterPostCommands` stamps freshness only after every
    post-command succeeded (`services.seed.commit`); the default is unchanged.
  - `postCommands` accept objects `{ name, run, when: { suite, env },
    continueOnError, timeout, expectOutput }` next to plain strings; a fatal
    failure lists every tolerated one; `when` skips with
    `services.seed.postcommand.skip`.
  - `expectOutput: { notMatches: [regex] }` (seed, phase or post-command) fails a
    command that exits 0 but prints an error.
- **Engine pin.** Config `requires: { cairntrace: <semver range> }` refuses an
  older cairn with exit 4 in `cairn run`, `cairn spec verify`, `cairn catalog`,
  `cairn services up|restart|logs|status`, every command that loads the config
  and every MCP tool, naming both versions; `cairn services down` warns and
  tears down anyway. Ranges npm rejects (`3.x.1`, `*-3`, `03.0.1`) are invalid.
  `runtimes: { node: { path, version } }` and `CAIRN_NODE` choose the node binary
  of node scripts, `script` verifiers and transforms (`CAIRN_NODE` wins, then
  `path`, then the first matching `node` on PATH, then the highest matching
  nvm/fnm/volta/asdf/mise/Homebrew install); a missing or out-of-range node is
  exit 4. `cairn doctor [--config <path>]` adds `config-requires` and
  `config-node-runtime` rows (exit 4 when unmet) and `cairn config validate`
  reports both.
- **MCP.** New tools `cairn_config_vars`, `cairn_services_restart` (needs
  `--allow-services`) and the read-only `cairn_services_logs` (65 tools in all, 68
  with the export and import tools of the Playwright sections);
  `cairn_run` gains `suite` and `bail` (`false` turns a suite's bail off) and reports exits 8 / 9 through
  `isError` and `cairn_run_status.exitCode`; `cairn_catalog` takes
  `kind: suites`.
- **Authoring checks.**
  - The lint rule `duplicate-step-id` is an error inside blocks and a
    warning between top-level steps. Eval hints, the password-field check
    and shell-argument checks now also walk `repeat` / `if` bodies.
  - `cairn spec verify` adds the `missing-auth` finding (exit 4: `use:
    login` with no `auth:` block) and `unknown-app-handle`.
  - `cairn config validate` checks widget driver modules, the `hydrate`
    file and `browser.appHandle` expressions, and warns (`literal-var-ref`,
    naming the field path) when an authored `${vars.X}` sits in a config field
    that never expands it, such as `environments.<n>.baseUrl`, `webServer` or a
    metric `command`. `${vars.X}` expands in specs, actions, fixtures, gates,
    datasources, suites, `http` metric probes, environment `auth` and other
    vars; elsewhere the run reads the text as written.
- **Docs.** `cairn docs widgets` (and `docs/widgets.md`), new sections in
  the `steps` topic (Control Flow, Widgets And Interaction Flags, Request
  v2, Environment Login, Page Prelude And App Handles), Workbooks (xlsx) in
  `verifiers`, `cairn explain` entries, and an eval-to-typed-step table in
  `AGENTS.md`. `cairn docs services` gains "Suites", "Metrics Probes", "Service Operations", "Seed Transaction" and "Engine Pin" sections, and
  `cairn explain` documents `--suite`, `suites list`, `config vars`,
  `doctor --orphans`, `services restart|logs` and exit codes 8 / 9. `docs/services.md`
  (and `docs/configuration.md`, `docs/doctor.md`, `docs/mcp.md`, `docs/commands.md`)
  cover composition, run policy, suites, metrics, service operations, the seed
  transaction and the engine pin, and AGENTS.md has a "Replace your Taskfile /
  wrapper scripts with config" section. `cairn docs run-policy` (MCP
  `cairn_docs { topic: run-policy }`) gathers what replaces a wrapper — a
  wrapper-to-config table, then the run policy, suites, metrics,
  per-environment services, services commands and dry-run sections.
- **Playwright import (E11).**
  - `cairn import playwright <file.spec.ts>` is now a TypeScript AST walk (the
    file is parsed, never executed) instead of a line-by-line regex. It uses
    the project's own `typescript` when it has the JavaScript API, else
    cairntrace's own (a TypeScript 7 without the API is skipped and named). It
    imports one test (the first, or
    `--test <title|n>`; the others are named) and what runs around it: enclosing
    `beforeEach` hooks, `test.step` bodies (titles become step ids),
    page-object methods (fields, getters, constructors, base classes; same
    file or relative imports, through `export *` / `export { A as B } from`
    barrels; an `if` on a literal flag runs only its branch), helper
    functions, `Promise.all([...])` and custom fixtures in the test signature
    (a `test.extend` found through the file's relative imports or a barrel:
    setup runs before the body, an option fixture's default is its value unless
    a `test.use({ option })` in scope sets it, a page built with
    `browser.newContext()` becomes the spec's page (approximated), code after
    `use()` is a TODO). The selector-first page API (`page.fill(sel, v)`,
    `page.click(sel)`, `type`, `check`, `press` …) and
    `waitForSelector("css=… >> text=…")` map like the locator methods. It resolves
    multi-line chains, `getByRole` (name, exact), `getByLabel` / `getByText` /
    `getByTestId` / `getByPlaceholder` / `getByAltText` / `getByTitle`,
    `locator` (CSS, `text=`, `id=`, `:has-text`), `filter({ hasText })`, `nth` /
    `first`, `check` / `uncheck` / `selectOption` / `press` / `setInputFiles`,
    `waitForURL` / `waitForLoadState` / `waitForTimeout`, `request.*`, and the
    assertions `toHaveURL`, `toBeVisible` / `toBeHidden` (and `.not`),
    `toHaveText` / `toContainText`, `toHaveCount`, `toHaveValue`,
    `toBeEnabled` / `toBeDisabled`, `toHaveAttribute` and `expect(page.url())`.
  - Nothing is dropped silently. Output (json / yaml / md) carries
    `coverage { mapped, approximated, unmapped, total }`, `todos` (each with
    the reason), `approximations` and `check` (the `cairn spec lint` and
    `spec verify` findings still open on the written file). TODOs are also
    comments in the YAML, before the step they precede; approximations are
    `# APPROXIMATED:` header lines.
  - Typed credentials never reach the YAML or its comments: a value typed
    into a password / token / key / pin / one-time-code field (whichever
    argument it is, `page.fill(selector, value)` included), a credential
    header, values under a credential-named request body key (nested, numbers
    included), a URL's user:password, credential-named or credential-shaped
    query values and path segments, and credential-shaped literals (a JWT, a
    long hex or base64 token) become `${secrets.X}`; `process.env.X` becomes
    `${env.X}` (`${secrets.X}` for credential names).
  - Both importers refuse to overwrite an existing file (exit 2; `--force`),
    and a draft that maps nothing (no step, no outcome) is not written: a
    stderr warning, `status: refused` with the TODOs, exit 1 (`--allow-empty`
    writes it; MCP `force` / `allowEmpty`). More TODOs than mapped constructs
    adds a `low coverage` warning (`warnings`).
  - `cairn import playwright-trace <trace.zip> [--out] [--name] [--intent]
    [--stdout] [--format]` turns a Playwright trace archive into a DRAFT
    spec. It reads the action and network logs only (no screenshots,
    sources, DOM snapshots or response bodies; the zip is read with a small
    built-in reader, no new dependency). Steps: `open`, `click`, `fill`,
    `type`, `press`, `select`, `check`, `uncheck`, `hover`, `focus`, `wait` and
    `request` from the recorded calls, with the best locator the trace holds
    (role+name, label, test id, text, css; a CSS-only selector is upgraded
    from the element the call log resolved). `test.step` titles become step
    ids. Outcomes are drafts (`DRAFT:` descriptions): recorded `expect()`
    calls, the final URL (id or token segments generalized to `url.matches`)
    and same-origin API calls (method + path pattern + status; no query
    strings, bodies or headers). Credentials are `${secrets.X}` placeholders
    (typed into password-like fields, credential headers, values under
    credential-named body keys — nested and numbers included —, URL
    user:password, credential query and fragment values, credential-shaped
    values including token path segments), and a final pass replaces every
    identified value wherever else it was recorded (an earlier call, TODO and
    approximation text, the YAML; a step id derived from one becomes
    `<verb>_redacted`). Both importers match credential names as whole words
    (separators and camelCase split them: `password`, `passe`, `pin`,
    `access_token`, `X-CSRFToken` are credentials; `Compass heading`,
    `passengers`, `tokenizer`, `token_count`, `secretary`,
    `x-session-locale` and a body `signature` are not); a hex path segment
    is a credential only after a credential-context segment
    (`/reset-password/<token>`), never a commit SHA, an avatar digest or
    `/api/tokens/<id>`; a request / trace id header is not judged by its hex
    shape; and the final pass only replaces a strong credential (password
    field or credential name) of 4+ characters or another of 8+ or
    credential-shaped, so a short value no longer rewrites a title, URLs and
    ids. A number under a credential key becomes a text `${secrets.X}`
    reference, and an approximation says the request now sends it as a
    string. Log entries are bounded
    (64 MB each, 160 MB per archive) and parsed line by line; step parent
    links that cycle terminate.
    Failed recorded calls, raw keyboard input, evaluate, reload / back,
    cookies and routes become TODOs. The command lints and verifies the
    written draft and reports the findings that remain.
  - MCP: `cairn_import_playwright` and `cairn_import_playwright_trace`
    return the same report as `structuredContent`, YAML included. `cairn explain`, `cairn docs import` (new topic),
    `cairn docs author-flow` (import as an alternative to discover → export)
    and `docs/export.md` document both commands.
- **Examples.**
  - `widgets.html`: a vendor-profile page with a native select, radio and
    checkbox groups, a vue-multiselect look-alike, a field that mounts
    later, a masked Save button and a page store.
  - `13-widgets-form.yml`: the widget kit, click and fill flags,
    `wait.app` and the prelude.
  - `08-conditional-step.yml` is rewritten for control flow.
  - `platform/32-api-login-v2.yml`: `use: login`, request v2 and a fixture.
  - `platform/33-export-workbook.yml`: xlsx v2 against the rendered
    catalog.
  - The examples config gains `browser.fieldRoot`, `browser.appHandle` and
    `environments.local.auth`, top-level `vars` with `staging` `extends: local`,
    a `run:` block (lock + a preflight command), a `smoke` suite and a
    `metrics:` command probe.
  - The examples config gains an `export.targets.demo` profile (inline host
    commands, gated verifiers); the CI export job exports it, checks it fresh,
    typechecks it and runs the static `--verify` gates on it next to the
    default, inline, global and manifest exports.
  - The CI smoke runs 08, 13, 32 and 33.
- **Environment aliases.** `environments.<name>: { alias: <target> }` is the
  same environment under another name (`--env remote` for `chalupa`).
  `--env` (and a spec's `environment:`, `defaultEnvironment`) is
  canonicalized to the target where it is parsed, in the CLI, MCP and Studio's
  spawn path alike, so suites (`requires.env`, `env.<name>`), a spec's
  `requires.env`, the environment policy, seed and tunnel state keys,
  services and run locks, `CAIRN_ENV`, the vault environment and
  `cairn config vars --env <alias>` all see the target name. `run.json` and
  `invocation.json` record `envAlias` (additive; absent when the real name was
  used). `cairn config validate` rejects an alias combined with other keys, to
  an unknown environment, chained or cyclic, extended by another environment
  or named by a suite. `extends` inherits and overrides a new environment; an
  alias copies nothing.
- **Delegated runners.** `environments.<name>.runner: { command: [argv…],
  cwd?, env?, timeoutMs?, idleTimeoutMs?, cancelGraceMs? }` runs an invocation
  on another machine while the local `cairn run` (or MCP `cairn_run`) keeps
  it: the invocation journal, the run directories under the local artifact
  root, the exit code, Ctrl-C / SIGTERM / Studio Stop and Live Cancel /
  `cairn_run_cancel`. Contract
  `urn:cairntrace.dev:delegate:v1` (`docs/delegate.md`, `cairn docs
  delegate`); cairntrace knows nothing about the machine behind the runner.
  - Locally: the suite and spec selection, the environment policy (every
    spec refused is exit 7 with nothing spawned), scoped secrets, `run.lock`
    (scoped to the delegated environment, so it never blocks the local
    environments or `cairn services`; `run.lock: false` when the runner
    manages capacity), `run.preflight`, then `run.finally`, JUnit and the
    document. A runner environment never runs a spec locally: an invocation
    that mixes it with another environment (a spec's own `environment:`, in
    any order) is exit 4, and `runSpec` refuses one on every other path. A
    spec the local policy refused never runs remotely: the request moves it
    from `planned` to `refused` and `cairnArgs` name the other specs (next to
    `--suite`, narrowing it). Never locally: services, webServer, browser, suite hooks,
    metrics, fixtures, `run.verifyClean`, the `runtimes.node` pin. An
    environment with a runner may not own a `services:` block (also one
    inherited through `extends`); `cairn config validate` lists
    `delegatedEnvironments` and no longer counts the top-level services for
    them.
  - The runner is spawned (argv, no shell; `${env.X}`, `${secrets.X}`,
    `${vars.X}`, `${config.dir}` resolve) in its own process group with
    `CAIRN_DELEGATE_REQUEST` (JSON: specs relative to the config directory,
    the caller's portable options, `cairnArgs` for the remote `cairn` with
    `--label cairn.delegate=<invocationId>`, `artifactRootLocal`,
    `cancelGraceMs`…) and `CAIRN_DELEGATE_EVENTS`, a file it appends the
    remote invocation's events.v1 NDJSON to. Its output goes to
    `logs/delegate.log` (redacted), the masked request to
    `delegate/request.json`.
  - The relay validates every line (a newer producer's unknown fields are
    dropped), records a malformed, invalid or unknown line as a
    `delegate.diagnostic` and keeps going (the first 20 narrated, the first
    100 journaled), drops exact repeats (bounded memory), remote heartbeats
    and `log.opened`, maps the remote plan onto the local one by spec path,
    and writes the rest into the local journal with `delegated: true` (an
    optional marker every events.v1 type accepts). Re-streaming is safe: run
    lines repeat by state (a settled run never goes back to running), the
    event after a torn line is recovered, and `cairn logs --relay` derives
    run lines with stable timestamps. `delegate.*` lines other than
    `delegate.progress`, relative paths that leave their directory, a run of
    a locally refused spec (`refused-run`) and a synthetic pass are refused;
    a line is read with at most 1 MiB of memory. New events:
    `delegate.started`, `delegate.progress`, `delegate.remote.started|
    finished`, `delegate.diagnostic`, `delegate.cancel.requested|escalated|
    finished`, `delegate.finished`, `invocation.run.started|finished`,
    `invocation.summary`.
  - After the runner exits, every run's `<artifactRoot>/<runId>/run.json` is
    checked (v1 conformance): present (`missing-run-dir`), labelled
    `cairn.delegate=<the local invocation id>` (`foreign-run`; the remote
    cairn adds it from `cairnArgs`), not a directory that was there before
    the runner started (`stale-run`), with the stream's status
    (`status-mismatch`; run.json wins); and every planned run must be
    settled or accounted for by the remote summary (`missing-run`). A
    foreign or stale run directory never becomes this invocation's document.
  - The runner's exit code is a claim, never a pass on its own: 0 stands
    only with every planned run settled by a verified run directory, the
    remote invocation's own `invocation.finished` / `invocation.summary`
    (same invocation) passed, every relayed run passed and a clean stream;
    otherwise it becomes 2, the remote invocation's code or the runs' code.
    1 stands only when a relayed run (or the remote verdict) failed; else 2
    (an infrastructure failure is never a red test). 2–9 / 130 / 143 are
    never lowered; any other code, a foreign signal, a runner that cannot
    start, `timeoutMs` and `idleTimeoutMs` (`idle`: the stream stayed
    silent; a warning after 5 minutes without it) are 2. Every override
    adds an `exit-mismatch` diagnostic.
  - A cancel sends SIGINT to the runner's pid only (its helpers, such as an
    ssh follower or an rsync, keep working), waits `cancelGraceMs` (default
    180000) while the relay and the heartbeat keep going, then SIGTERM and
    SIGKILL to its process group; on Ctrl-C this happens synchronously before
    the journal is marked aborted, and the process exits 130 / 143. The
    signal path tells a zombie from a live runner through `/proc` on Linux
    and `ps` elsewhere, and counts an unknown state as running.
  - `invocation.json` and MCP `cairn_run_status` carry a `delegate` block;
    documents carry `invocationOutcome.delegate`. `--services-dry-run` and
    `--select-only` print the masked plan (`delegate` on the document) and
    spawn nothing.
  - `src/testing/fakeDelegateRunner.ts` is a reference runner: it replays a
    recorded stream and copies run directories the way the contract asks,
    and misbehaves on demand (foreign run directories, a reconnect that
    tears a line, a helper in its process group).
- `cairn logs --invocation <ref> [--follow] --relay` prints the
  delegated-runner events stream of one journal (its events plus
  `invocation.run.*` lines derived from `invocation.json` and a final
  `invocation.summary`). `--invocation` also takes `label:<key>=<value>`
  (the newest journal with that label; waited for with `--follow`, at most
  `--wait-timeout <duration>`, default 10m, `0` without end; then exit 2).
  `cairn logs <run> --follow` on a run a delegated invocation copied follows
  that invocation's local process instead of the remote heartbeat's pid.
- `cairn stats --invocation <id>` also matches runs labelled
  `cairn.delegate=<id>` (a delegated invocation's runs, whose run.json names
  the remote invocation).
- `cairn config validate` finding `suite-env-fallback` (warning): a suite's
  `requires.env` admits an environment with no `env.<name>` block while a
  sibling admitted environment has one, so a run there silently takes the
  suite-level specs, vars and hooks. The message names the suite and the
  environment.
- `cairn export playwright --strict-locators` (profile
  `export.targets.<name>.strictLocators`, MCP `strictLocators`,
  `--no-strict-locators` to override a profile): no `.first()` on a locator
  without `nth`, so an ambiguous locator fails the exported test the way
  `cairn run --backend playwright` does. The default keeps `.first()` (the
  config has no run-backend setting to infer the mode from). The manifest
  records `source.strictLocators` (`--check` / `--verify` regenerate the same
  mode); the differential report carries `strictLocators: true` for a strict
  export and, for a default one, warns on a spec the run failed and the export
  passed.
- **Server timestamps in publish receipts.** `cairn publish` accepts the
  optional `committed_at` and `expires_at` that file.cheap 0.37 adds to the
  `filecheap-publish/1` receipt (RFC 3339; any other unknown field is still
  rejected). `publish-receipt.json` and the `cairn publish` output use the
  server's `expires_at` for `expiresAt` instead of computing it locally, and
  gain an optional `committedAt`. A console `webUrl` from the receipt
  continues to appear in the receipt, the output and Studio's "Open in
  file.cheap" button.
- A contract test builds RunIndexV1 sidecars for a passed run, a failed run
  past the outcome and evidence caps, and unicode names, and checks them
  against a vendored copy of file.cheap's console schema and the 12 KiB limit.

### Changed

- `cairn import playwright` is rebuilt on the TypeScript AST (see Playwright
  import above). Differences from the regex importer: `beforeEach` hooks and
  page-object / helper calls are inlined as steps instead of being ignored or
  left as TODOs; a locator `.nth(n)` on a CSS selector is kept (`nth` is
  valid there); a `getByRole` assertion that names the role now maps to a
  page-text check (a role count cannot filter by name) and says so under
  `approximations`; `getByTestId` steps use `by: testid`; a typed credential
  is a `${secrets.X}` placeholder; every TODO line now ends with its reason;
  the report gains `coverage`, `approximations` and `check`.
- `typescript` is now a runtime dependency (same `^5.9.3` range, moved from
  devDependencies): `cairn import playwright` and the export's host profile
  read code with its compiler API, and a project without its own TypeScript
  — or with only the native TypeScript 7 compiler, which has no JavaScript API
  — must still work. Resolution prefers the project's `typescript` when it
  exposes the API (`createSourceFile`), else cairntrace's own, and names a
  TypeScript without the API precisely instead of advising `npm i -D
  typescript`.
- Playwright export: an action module whose name is a binding the generated
  code uses (`page`, `expect`, `test`, `join`, a reserved word …) is
  exported as `<name>Action` (`pageAction(page)`) instead of shadowing it.
- Playwright export: an exported `wait: { app }` blocked by a page's Content
  Security Policy fails at once naming the CSP and `bypassCSP` instead of
  polling to a timeout.
- Playwright export: an action module (and a generated page object) takes only
  the `vars` its steps read, so a declared but unused var no longer trips the
  host's `noUnusedLocals` / `noUnusedParameters`, and a call site passes only
  those. The neutral CommonJS host tree used by the tests now sets
  `target: ES2022`.
- Playwright export: `lib/pages/` (generated page objects) is not vendored
  runtime: it gets the host's import ordering and no `eslint-disable` banner.
- Playwright export: `--lang` no longer has a commander default (a profile's
  `lang` would otherwise lose to it); omitted still means `ts`. A test's
  console-error listener and the JSON body parser use braces on every `if`
  (generated tests pass a `curly` lint rule).
- Playwright export `--verify`: with a host profile the typecheck gate uses the
  tsconfig the profile names and the list gate runs `playwright test --list
  --config <host config>`; the `playwright test --list` JSON is read past
  lines the host's own code printed before it (a dotenv banner); and a tsc that
  rejects the tsconfig itself (an option error such as `TS5095`) makes the
  typecheck gate `skipped` instead of a pass (tsc skips the type check then).
  A passing `--verify` does not lower the exit code 1 that a refused spec set.
- Playwright export: `datasources/http.ts` keeps its public behavior but its URL
  joining, credential, request / reply shaping and redirect policy moved to
  `datasources/httpWire.ts`; `network`, `xlsx`, `file`, `httpJson` and the
  response judge were split into pure modules (`networkJudge`, `xlsxJudge`,
  `fileWait`, `httpJsonMatch`, `responseJudge`) that the runner and the
  export share.
- Playwright export: the 30-minute test-timeout floor now follows what the
  export emits — it applies only to a test that emits a node file verifier
  (never with `--verifiers drop`) and to a `beforeAll` that runs a long
  precondition. Unexported datasource / value / table verifiers and unexported
  run steps no longer reserve a default 30 seconds each, and exported run
  steps, captures, teardown and poll windows add their own budgets.
- Playwright export: the `--project` `preconditions.ts` runner now spawns
  `/bin/sh -c` (as `cairn run` does, instead of bash), keeps the output tail
  in its errors instead of inheriting stdio, and exports `cairnCommand`,
  `cairnLastJson` and `cairnTestContext` next to `runPrecondition` /
  `targetPreconditionEnv`. `CairnActionBindings` (`lib/splice`) gains
  `runs` and `captures`.
- `cairn run` takes its spec paths as optional (`cairn run [spec...]`) so
  `--suite` can stand in for them; with neither, it exits 2 with "at least one
  spec path is required (or --suite <name>)". `--parallel` no longer defaults to
  `1` in the CLI mapping (the engine still floors it at 1), so a suite's
  `parallel` can apply.
- Exit codes **8** (a critical teardown failed: a `services.teardown` entry
  with `critical: true`, or a failed `services.provisioner` `down`) and **9**
  (dirty state after the run, `run.verifyClean`) join 0–7. `cairn services
  down` exits 8 (not 2) when such a teardown failed. Precedence: 8 > 9 > the
  run's own code, so neither is masked by an earlier verdict. Exit 4 now also
  covers a run the config `run:` policy refuses before anything starts (a live
  run lock, a failed preflight check, a dirty machine before the run, specs from
  several configs where one declares `run:`) and an unmet engine pin.
  `cairn explain`, the docs, the README table, AGENTS.md and the MCP result
  mapping (`isError`, `cairn_run_status.exitCode`, journal `summary`) cover
  them; Studio labels them (see Studio).
- With a `run:` policy or a critical teardown, `cairn run` holds its documents
  until that verdict, so `--json` / md / MCP `structuredContent` agree with the
  process exit code: `exitCode` 8 / 9, a passed spec reads `status: errored`
  (`failure.phase: invocation`), and an additive `invocationOutcome`
  (`exitCode`, `specsExitCode`, `error`, `runPolicy`) on RunResult and
  BatchRunResult says why; run.json in the run directory is unchanged. A
  SIGINT / SIGTERM before that verdict prints the documents of the iterations
  that finished (as 3.0.1 printed them as they finished), with
  `invocationOutcome.exitCode` 130 / 143.
- New files under `~/.cairntrace`: run locks (`locks/<label>.<hash>.run.lock.json`),
  the owned browser-session ledger (`sessions-ledger/`, entries expire after 7
  days), and, under `services/`, seed state (`<project>.<env>.<hash>.seed-state.json`)
  and tunnel state (`<key>.tunnel.<name>.json` plus its log). Runs add
  `diagnostics/metrics.json` and, for invocation-scope probes, `<journal>/metrics.json`.
  `services.seed.command` is optional when `phases` is set, and the JSON results
  of `cairn services up` / `down` gain optional fields
  (`phases.provisioner|tunnels|files`, `tunnels`, `critical` / `provisioner` on
  teardown steps). tmux sessions are created with `-x 250 -y 50` and panes are
  captured with `-J` (wrapped lines are joined).
- `suites.<n>.seed.postCommands.skip` matches a named post-command by `name` (a
  plain string post-command still by its exact text); an entry that matches
  nothing is a warning.
- `when:` gates splice runtime references (`${requests|evals|runs|captures|fixtures|waits|repeat.…}`)
  before they are checked. Before, they were compared literally.
- Shared JSON paths (verifiers, `expect`, fixtures, requests) accept filter
  expressions: `$.tasks[?(@.title == "x")].id` with `== != < <= > >= && ||
  !` and a bare `@.field` for presence.
- The `xlsx` verifier reads workbooks through the SDK's parser
  (`src/sdk/workbook.js`) instead of its own copy. Values compare as the
  strings Excel stores, so a date is its serial number.
- Redaction: every `${secrets.X}` value the parser resolves, every sensitive
  header value (and the token after `Bearer `), and every response field
  under a credential-like key are redacted from all artifacts. `jwt` and
  `bearer` are credential key names, and `jwt` is a credential query
  parameter. Derived values (a spliced `${secrets.X}`, a login secret)
  shorter than 6 characters are not redacted as literals. Provider-injected
  values and `redaction.values` entries still are, at any length.
- Request error messages (`expectStatus`, a capture miss, a matrix, an
  exhausted `until`) show credential-safe excerpts. Values under
  credential-like keys are masked, long or token-shaped strings are shown
  by length only, and a string is never cut in the middle. The exported
  request helpers do the same.
- agent-browser `eval` sends scripts over 96 KiB (counted in UTF-8 bytes),
  and scripts that carry a credential (the request fallback, login
  hydrate, widget values), through `--stdin` instead of argv. A timeout
  message no longer echoes the script.
- The parser refuses an authored `when.resolved`. That field is internal:
  the parser stores a plain var's value there.
- Evidence of failed runs now expires after 90 days by default: auto-stash
  uses `stash.failTtl`, else `stash.ttl`, else `90d` (it never expired
  before). Pin a run to keep it (`cairn pin <run> --stash`, no TTL), or set
  `stash.failTtl: never` to keep every failed-run stash. `passTtl` stays 7d,
  and existing stashes keep their expiry.

### Fixed

- Stash `--meta` values are cut to file.cheap's real limit of 256 UTF-8 bytes
  on a character boundary (it was 200 UTF-16 units, so a long multi-byte spec
  or environment name made fcheap refuse the whole save), control characters
  (C1 included) are stripped, and keys fcheap rejects or reserves are dropped.
  If fcheap still refuses the metadata, the save is retried once without it:
  the evidence is stored, a warning says so, and the stash receipt and
  `artifact.stash` event record `metaDropped: true` (additive).

- A command-line usage error (unknown flag or command, a missing subcommand —
  bare `cairn`, `cairn services` —, missing option value or argument) exits 2
  on every command, never 1. Before, commander's own exit 1
  read as a failed outcome (a red test) in scripts. `--help` and `--version`
  still exit 0; MCP is unaffected. The README exit table and `cairn explain`
  say so.
- `cairn run --services-dry-run` no longer fetches secrets. It ran `tvault run`
  (a real vault read) before printing the plan; it now resolves the secret
  names only and prints them on a `secrets:` line, and no `tvault` process
  starts (not even `--version`). `secrets.required` and a suite's
  `requires.vars` are not judged in a dry run.
- On SIGINT / SIGTERM the services tunnels stop after the teardown commands
  (right before the provisioner's `down`), the order of a normal stop. They
  stopped first, so a teardown command that needs a tunnel failed. The bounded
  signal budgets and the provisioner staying last are unchanged.

- An environment's `services:` block runs when the config has no top-level
  `services:` block. Before, `cairn run` skipped the whole lifecycle (a
  provisioner included) without a word, `cairn services status` said "no
  services config block found", `services up` refused and
  `--services-dry-run` printed nothing for such an environment; the run
  engine, `services up | down | restart | logs | status`, the dry run,
  `run.verifyClean`, `cairn catalog`, `cairn config validate` and Studio now
  read the same effective block.
- A `network` / `noFailedRequests` outcome no longer reads a request the page
  already saw complete as `<pending>`. The Playwright backend records the
  status when the response headers arrive (the timing still when the request
  finishes), and the end-of-steps network snapshot waits, at most 2 s, while
  a request one of those outcomes judges has neither a status nor an error
  (nothing waits otherwise). agent-browser never marks a failed or cancelled
  request (its `network requests` log keeps neither a status nor an error,
  like one in flight), so there the log is read once more after 100 ms
  instead of waiting out the 2 s, and `noFailedRequests` evidence says how
  many matching requests never completed and could not be judged on that
  backend (use `--backend playwright` when transport failures must fail). Before, an outcome
  judged right after the last step could fail a request that answered 200,
  or pass `noFailedRequests` over one that was about to answer 500. Its
  evidence also shows a network error instead of `<pending>`.
- agent-browser uploads that the page cannot read (`ERR_ACCESS_DENIED`) are
  rebuilt in the page from the host bytes (DataTransfer, up to 25 MB). Only
  the input the upload changed is probed or rebuilt. `via` records
  `setInputFiles` or `dataTransfer`.
- The workbook parser (`xlsx` verifier and `ctx.xlsx`) refuses a sheet
  whose grid exceeds 5,000,000 cells and a zip entry that inflates past
  256 MB. Before, one stray far-off cell could build a grid that exhausted
  memory.
- SIGINT / SIGTERM ends the invocation's still-running preconditions, `run:`
  steps and other bounded host commands (each one's process tree) before
  cairn exits. Before, a precondition of a run stopped by a SIGTERM sent to
  cairn alone kept running, re-parented, after cairn was gone.
- A second Ctrl-C (or a SIGTERM / SIGHUP) while cairn's signal cleanup runs
  no longer kills it halfway. Before, the handler was a one-shot listener, so
  the second signal took the default action: the services teardown (a
  provisioner's critical `down` included), `run.finally` and the run lock's
  release could be skipped, leaving a billable resource up and a stale lock.
  Further signals are now ignored until the bounded cleanup ends, cairn says
  so first (`cleanup in progress (critical teardown pending); further Ctrl-C
  is ignored until it ends, send SIGKILL to force`), and it exits 130 / 143
  as before.
- `cairn run --format md` (and a run's `summary.md`) says why a run did not
  pass: `- reason:` (`failure.message`), and `- invocation: exit N (the
  specs alone: exit M)` when the invocation settled on another code. Before,
  an errored run whose every outcome and step passed named no reason.
- tmux targets are exact (`=session`, `=session:=window`). Before, with the
  configured session (or window) not running, tmux matched another one by
  prefix: `app` reached `app-wt`, so a reuse check, readiness, a teardown's
  `kill-session`, `run.verifyClean`, `services status` and the new restart /
  logs could read, type into or kill a session cairn does not own. Panes are
  read with `list-panes`, which fails on a missing window, instead of
  `display-message`, which answers for another pane.
- A tmux window whose service is started through a shell (`bash start.sh`,
  `sh -c …`) counts as running while its shell has a foreground job. Before,
  the shell name made it look idle: readiness failed at once ("service command
  exited"), a reuse re-launched it by typing into the running service, and a
  restart skipped the Ctrl-C.

### Studio

- Repeat iterations, if branches and retried attempts nest under their
  block as collapsible groups in Run detail and Live. A retried attempt
  reads `retried`, never failed. The Failure panel names the failed
  iteration (`in <block> #N`), and step counts are top-level only. At most
  5000 execution rows are kept per run.
- Widget steps show expected vs committed values per field, the driver and
  path, the final form re-check, failures and the unanswered-fields dump.
  Credential-named fields are masked. Click and fill steps show the
  dispatch fallback and why, and optional steps that were skipped as
  absent.
- Request steps show attempts, captures (masked by name) and the status of
  each matrix combination. `use: login` shows its requests by method, path
  and status only.
- The xlsx verifier's evidence shows the workbook, its sheets, the header
  columns and one line per check.
- Catalog: a Widgets tab (drivers in detection order, field roots, app
  handles), an auth column on Environments (secret names only), and the
  built-in `login` action (an imported one wins and is tagged).
- **Suites.** A Suites view lists the config's `suites:` with the specs each
  resolves to per environment (or why it cannot run there) and runs one as
  `cairn run --suite=<name> [--env]` through the same launch path as Run:
  main resolves it with `cairn suites list` first, so an unknown suite or an
  environment its `requires` rules out is refused before anything spawns.
  Re-run on a finished suite card repeats the suite. A launch template
  (one spec at a time) disables it.
- **Run lock.** When the config takes `run: { lock }`, a live owner of its lock
  file (matched on the key the file stores; a dead or recycled-pid owner does
  not count) disables Run, Heal and services up/down/restart in Studio and
  names the owner, age and command (topbar: "run in progress"). Existing
  suite lock files keep working beside it.
- **Run policy in Live, Invocations and Run detail.** Preflight results,
  verifyClean findings before and after the run, `finally` hooks, the lock,
  critical teardown failures, suite hooks and `--bail` read as a Run policy
  panel (a new Run policy tab in Run detail). Exit 8 (critical teardown
  failed) and exit 9 (dirty state after the run) get a callout and badge that
  differ by shape and words, not only colour. A Studio-launched run that
  exits 8 / 9 (or whose document's `invocationOutcome` says so) reads
  errored on its Live card, never passed from the spec's own events. Specs `--bail` never started
  read as "skipped · bailed" in the plan, never as refused (Studio's refused
  count now subtracts `summary.skipped`).
- **Metrics.** Run detail gains a Metrics tab: before, after, a signed delta,
  min / max / mean for `every:` probes, failed samples, and per metric a
  labelled sparkline across the same spec's earlier runs, with a values table.
  It reads `diagnostics/metrics.json` only; no chart library.
- **Service operations.** Environment lists each tmux window's health with
  Restart (a native confirmation first) and Logs (`services logs`, read-only,
  `--since-restart`), the supervised tunnels, and the provisioner's export
  names (never values). Restart is refused for a window the CLI's status does
  not list, and while a suite or run lock is held. Services declared only per
  environment count: Environment shows their lock and windows for those
  environments only.
- **Config vars.** A Config vars view over `cairn config vars --json`: value per
  environment, where defined, overrides, uses and unused. Masked values stay
  masked; credential-named vars are masked again in main.
- **Orphan browser sessions.** Environment lists `cairn doctor --orphans` and
  ends their processes (`--kill --yes`) only after a native confirmation that
  lists every session and process — and only those: the confirmed sessions and
  pids travel as `--only`.
- **Delegated invocations.** An invocation whose environment has a runner
  reads "delegated" in the Invocations list and detail (the tooltip names the
  runner command, the remote invocation and the runner diagnostics). Studio
  reads its local journal unchanged: the local `cairn` pid owns it, so it is
  live, and Stop (SIGINT) cancels the runner, which cancels the remote
  invocation. Live **Cancel** of a delegated run Studio launched sends SIGINT
  too and never SIGKILLs cairn while it waits for the runner (only a
  safety net after `cancelGraceMs` + 75s); quitting Studio sends it SIGINT
  and cairn finishes the cancel on its own. A run directory a runner copies
  here takes its liveness from the local delegated invocation that lists it,
  not from the remote heartbeat's pid.
- New event kinds (`run.lock.*`, `preflight.*`, `cleanliness.*`, `finally.*`,
  `invocation.bailed`, `suite.*`, `metric.sampled`, `services.restart|tunnel|
  provisioner|files|seed.phase.*`) read as sentences in the Live timeline;
  an event missing the name it is about, or an unknown kind, still degrades to
  a generic line. Exit codes 8 and 9 were already labelled.

## [3.0.1] - 2026-10-02

First npm publish of the 3.0 line: the v3.0.0 tag's publish verify failed on
the flaky test fixed below, so 3.0.0 exists on GitHub and Homebrew only.
Everything in [3.0.0] applies.

### Fixed

- `latest` / `previous` run references (`cairn logs`, `context`, `diff`,
  `stash`, MCP) resolve deterministically when two run directories share an
  mtime (same clock tick or a coarse filesystem clock): the timestamped run
  name breaks the tie, so the newer run always wins.
- MCP `cairn_run_status` for an invocation this server started resolves its
  journal from the artifact root when the registry does not know the
  journal directory yet, and a just-settled invocation briefly re-reads the
  journal until its final state and summary are visible, so status no longer
  returns a settled verdict without the summary and run list.
- Examples: the demo database's readiness check and compose healthcheck use
  `pg_isready -h 127.0.0.1` (TCP). The image's init-time server answers on
  the unix socket and then restarts, so the socket check let the seed connect
  into that restart (ECONNRESET).
- CI: the desktop job installs the root dependencies its `cairn --help`
  parity test needs; the test skips with a clear reason when they are missing.

## [3.0.0] - 2026-10-02

### Upgrading from 2.x

This release changes defaults that CI scripts, MCP clients and
remote-provisioned stacks rely on. Check the items below before upgrading.
Specs and configs that use none of them run as they did in 2.15.

1. **An unknown `--env` is an error (exit 4).** When a config exists,
   `cairn run|spec verify|spec heal|discover|snapshot --env X` fails before
   anything starts if `environments:` has no `X`. `cairn wait`,
   `services up|down`, `fixtures` and `login` reject it too. To check, run
   `cairn config validate`, then `cairn run <specs> --env <name> --select-only`.
   Add the missing environment or fix the name. A spec `environment:` or a
   `defaultEnvironment` that the config lacks only warns.
2. **URL readiness needs a 2xx/3xx answer.** This covers `webServer.url`, the
   webServer's `baseUrl` fallback and tmux `windows[].readyOn.url`. A 401, 404
   or 503 no longer counts as ready. Point the probe at a health route, or add
   `anyResponse: true` to get the 2.x any-answer rule back. If you keep the
   probe, the symptom is a readiness timeout that names the last status. The
   config schema is strict, so a config that uses `anyResponse` no longer
   loads in 2.x. A config shared with 2.x should switch to a health route or
   a `readyOn.text` / gate instead.
3. **New run status `refused`, exit 7.** A spec whose `requires.env` or
   environment `policy` forbids the resolved environment is refused before
   secrets, services or hooks run. Its result has `status: refused`, a
   `refusal` block and `synthetic: true`, and it has no run directory. Update
   anything that parses `run.json` or `--format json` (`status`, `exitCode`),
   and never open a `synthetic` `runDir`. `cairn run` exits 7 when every
   spec was refused; `--strict-requires` fails a mixed batch on any refusal.
   `cairn spec heal` and MCP `cairn_spec_heal` exit 7 on a refused spec.
   Specs without `requires:` on environments without `policy:` are not
   affected.
4. **MCP `cairn_run` runs the `cairn run` lifecycle, and config services are
   gated.** `cairn_run` now boots the config `webServer` and stops it
   afterwards. Pass `noWebServer: true` when you run the dev server yourself.
   Config `services` (docker/seed/tmux) and their teardown start over MCP only
   on a server started as `cairn mcp --allow-services` (or with
   `CAIRN_MCP_ALLOW_SERVICES=1`). Without the flag, `cairn_run`,
   `cairn_spec_finish` and `cairn_audit` fail with exit 4 when their config
   would start services. They fail before anything starts, and the error says
   what to do: pass `noServices: true` when the stack is already up, or
   `reuseServices: true` after a `cairn services up` from a shell.
   `cairn_services_up` and `cairn_services_down` refuse outright without the
   flag. Only grant the flag where an agent may provision and tear down that
   stack. Environments whose services cost money should never get it. The
   CLI is not gated.
5. **MCP hooks are opt-in.** `before` and `after` hooks over MCP are refused
   unless the server runs as `cairn mcp --allow-hooks` (or with
   `CAIRN_MCP_ALLOW_HOOKS=1`).
6. **Child processes get a filtered environment.** Preconditions, hooks,
   docker/seed/tmux commands, services teardown commands (the SIGINT/SIGTERM
   teardown included, which got the raw environment in 2.x) and webServer
   commands no longer inherit `CAIRN_TVAULT_ENV`, `TVAULT_*` keys that were
   not selected, or `FILECHEAP_INGEST_TOKEN`. To find what breaks, run
   `grep -rn 'CAIRN_TVAULT_ENV\|TVAULT_'` across your config commands and
   provisioning scripts. Read `CAIRN_ENV` instead, pass `--env` explicitly, or
   select the key as a secret. A guard written `${CAIRN_TVAULT_ENV:-local}`
   now silently reads `local`. A key a services phase or the `webServer` sets
   in its own config `env:` is still passed as written. One example is a
   provisioner that needs `TVAULT_DIR` for a non-default vault. Another fix is
   to set the key inline: `TVAULT_DIR=… ./provision.sh`.
7. **Evidence that leaves the run directory carries `text` and
   `screenshots` by default.** This covers stash, auto-stash, `pin --stash`,
   investigate, clip and the retention archive. To keep the 2.x contents, set
   `stash.include: [text, screenshots, traces, videos, downloads]` and
   `retention.publish.include`, or pass `cairn stash save --include traces
   --include videos`. With `retention.archiveToStash`, pruned runs lose their
   traces, videos and downloads unless they are included. Traces are
   sanitized first. Unsanitized traces need `stash.unsafeIncludeRawTraces:
   true`. `publish` never sends traces.
8. **The agent-browser trace is renamed.** `traces/agent-browser-trace.zip`
   is now `traces/agent-browser-trace.json`, a Chrome trace-event JSON file.
   Open it in Perfetto, not `playwright show-trace`. Update your globs and
   scripts. Old runs are still read.
9. **The package has an `exports` map.** Only
   `@thelacanians/cairntrace/verifier` and `/package.json` resolve, so a deep
   import such as `@thelacanians/cairntrace/src/...` fails. Move verifiers to
   `defineVerifier` from the SDK. Verifiers that cairn runs need no local
   install. The `cairn` binary is unchanged.
10. **`session.resume` is enforced.** A missing, expired or other-origin
    checkpoint now fails the run (`failure.phase: "session"`) instead of
    running unauthenticated, and a failed `loadState` fails the step.
    Remote-provisioned environments can hit this: their tunnel or port
    origin can differ from the one the checkpoint was captured on. To check,
    run `cairn checkpoint list --json` (its `health` should be `ok` or
    `unscoped`) and `cairn spec verify --env <env>`. To recapture, run
    `cairn login <name> --env <env> --ttl 12h`. A checkpoint that a
    precondition rewrites reads as `unscoped` and still loads.
11. **Directory runs skip `_` folders.** `cairn run flows/` no longer runs
    specs under `flows/_drafts/` or `_smoke/`. `cairn run <dir> --select-only`
    lists them under `skipped` (`draft`), and a directory that holds only
    drafts is an error (exit 2). Rename those folders, or name the specs
    explicitly.
12. **`cairn spec verify` is stricter (exit 4).** It fails on missing files
    that a spec or its actions reference, on unknown `preconditions.wait`
    gates or `fixtures:`, and on an `--env` the policy refuses. Run it before
    CI does.
13. **The MCP discovery defaults changed.** Snapshots default to `diff`
    mode, so an unchanged page returns no elements, and they are capped at
    `maxBytes: 16384`. Sessions close after 30 minutes idle, and each one gets
    its own browser daemon. Pass `snapshotMode: "full"` (and a larger
    `maxBytes`) where the agent expects whole trees. Every open session keeps
    its own Chrome alive for up to 30 minutes, so close sessions with
    `cairn_discover_close`, or lower `discovery.sessionTtlMs` on machines
    with little memory.
14. **Teardown commands run detached, and the SIGINT/SIGTERM teardown
    changed.** Services teardown commands (normal, failure cleanup and
    signal path) now run in their own process group and session, with no
    terminal and their output in a private temp file. The Ctrl-C, Studio
    Stop or group SIGTERM that stops cairn no longer kills a provisioner's
    `down` halfway. A teardown command that prompts on the terminal fails
    now; make it non-interactive. On a signal, the teardown first waits up
    to `CAIRN_SERVICES_SIGNAL_GRACE_MS` (default 5000) for a boot command
    that is still running (a provisioner's `up`) to exit. It sends no
    signal of its own, and it waits for the command's whole process tree,
    so a long-lived child that survives the Ctrl-C (a tunnel supervisor)
    holds the teardown for the whole grace. Then it runs the teardown
    commands that have not run yet, each capped at
    `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` (default 10000, as before).
    For the command the normal teardown is running, it waits up to the same
    cap and never starts a second copy while that one is alive; one still
    running after the wait finishes in the background, and one that is gone
    runs again, as in 2.x. For a remote `up` / `down` that takes minutes,
    raise both budgets in the environment of the `cairn run`, for example
    `CAIRN_SERVICES_SIGNAL_GRACE_MS=180000
    CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS=240000`. 2.x ignores both
    variables.
15. **The services lock.** While `cairn services up` holds a config's lock,
    `cairn run` and `cairn audit` for that config (any environment) exit 4
    unless they pass `--reuse-services`. Add `--reuse-services` to runs
    against a stack you started with `services up`, and stop it with
    `cairn services down`.
16. **`cairn logs` flags are strict.** `--format` / `--json` apply only to
    `--invocation` summaries. On a run reference (`cairn logs latest --json`)
    they now exit 2 instead of being ignored. Drop the flag, or use
    `cairn logs --invocation <id|latest> --json`.
17. **`cairn audit` boots services before the webServer**, as `cairn run`
    does. If a webServer setup assumed the services were not up yet, move
    that step to the services `postCommands`.
18. **MCP runs that boot a stack are serialized.** Invocations that boot
    services or a webServer from the same config file run one at a time,
    and one server runs at most 8 invocations. Parallel blocking `cairn_run`
    calls queue and can hit a client's tool timeout. Raise the timeout, or
    use `cairn_run {wait:false}` with `cairn_run_status` / `cairn_logs` /
    `cairn_run_cancel`.
19. **Smaller behavior changes:**
    - A spec's own `vars:` now resolve `${env.X}`.
    - Plain `${secrets.X}` / `${env.X}` placeholders under sensitive keys are
      no longer redacted, because they are names, not values.
    - `precondition.run.output` keeps the last 4000 characters.
    - `latest` / `previous` ignore `_invocations/`.
    - `services.stash` is deprecated in favor of `services.artifacts`. It now
      honors `autoStash: on-failure`, so a failed run makes one extra
      services save.
    - Exported Playwright projects turn `requires.env` into `test.skip` on
      `CAIRN_ENV`, mark `transform` / `run` / `capture` steps `test.fixme`,
      and write `.cairn-export.json`. Re-export, then gate CI with
      `cairn export playwright --check <dir>`.
    - `cairn run` exits 4 (lint or config error) for an unknown `--env`, a
      held or refused services lock, and an MCP services boot without
      `--allow-services`.

**Zero-cost preflight before a run that provisions paid infrastructure.**
None of these commands starts services:

- `which cairn && cairn --version` shows which build runs.
- `cairn config validate --config <cfg>` checks the config.
- `cairn spec verify <specs> --env <env>` checks for an unknown env, missing
  files, refusals and unusable checkpoints.
- `cairn run <suite> --env <env> --select-only --format json` shows what
  would run. It starts no browser, services or webServer and reads no
  secrets.
- `cairn run <suite> --env <env> --services-dry-run` prints the services
  lifecycle, including the teardown commands, without running it. It does
  read the environment's scoped secrets.
- `cairn checkpoint list --json` checks every checkpoint a spec resumes.

### Added

- **`cairn audit --no-services`** (MCP `cairn_audit` `noServices`) audits
  against a stack that is already up without starting or tearing down the
  config services.
- **Teardown evidence in the invocation journal.** The failure cleanup of a
  services boot now leaves the same per-command
  `services.teardown.complete` / `services.teardown.fail` events as a normal
  teardown, and both carry `durationMs`. Every teardown command's redacted
  output lands in `logs/services-teardown.log` (`cairn logs --invocation
  latest --log services`). The SIGINT/SIGTERM teardown records each step as
  a `services.teardown.signal` event: the boot command it waited for, and
  each command's `completed` / `failed` / `timed-out` status, or, for the
  command the normal teardown was running, `finished` / `in-flight` (with
  its pid and output file) / `re-run`. Its output goes to the same log,
  even after the journal was marked aborted.
- **One run engine for the CLI and MCP.** `cairn run` and MCP `cairn_run`
  now share one engine (`src/cli/invocation/`) and one
  `RunInvocationOptions` schema (`urn:cairntrace.dev:run-invocation:v1`), so
  they cannot drift. `cairn_run` honors everything `cairn run` does: config,
  vars, `browser.*` (including `testIdAttribute`), scoped secrets,
  services (behind `--allow-services`, see Changed)/webServer, hooks,
  repeat/matrix, stash/investigate/annotate,
  retention archive/publish, stamp-if-green, JUnit and the invocation
  journal. It accepts every run flag in camelCase plus `specs`/`path`/`wait`,
  returns the same document as `--format json` (plus `nextActions`) and sends
  MCP progress notifications when the request carries a `progressToken`.
  Parity tests fail the build when a run flag is missing from the schema or
  the MCP input, and an end-to-end test checks that a spec run through both
  transports produces an equivalent `run.json`.
- **Background runs over MCP.** `cairn_run {wait:false}` returns the
  invocation id immediately. New tools: `cairn_run_status`,
  `cairn_run_cancel` (idempotent, waits for teardown) and `cairn_logs`
  (incremental reads of events and live logs with a per-file cursor,
  `urn:cairntrace.dev:run-logs:v1`). One server runs at most 8 invocations;
  closing stdin cancels background runs.
- **MCP safety.** `--before`/`--after` hooks over MCP are refused unless the
  server runs with `cairn mcp --allow-hooks` (or `CAIRN_MCP_ALLOW_HOOKS=1`),
  and config services start only with `cairn mcp --allow-services`; these
  are gates, not a sandbox. Invocations that boot services or a
  webServer from the same config run one at a time. MCP browser sessions are
  unique per invocation. `invocation.json` records `origin` (`cli`/`mcp`) and
  the MCP `client`.
- **Versioned event stream.** `events.ndjson` follows a new `events.v1`
  schema that covers every runner and services event, with golden fixtures.
  New events: `phase.changed` (phase, item, budget, deadline),
  `run.heartbeat` every 15s while a phase is active, `outcome.started` (kind
  and timeout), live outcome verdicts with `durationMs`, `log.opened`,
  `precondition.progress` / `outcome.progress`, and `hook.*` /
  `invocation.*` in the invocation journal. `step.started` gains
  index/total/kind/label (never fill values or URL query strings);
  `step.finished` / `step.failed` gain `url` (without its query string) and
  `screenshot`.
- **Invocation journal.** Every `cairn run` (single, batch,
  `--repeat`/`--matrix`) writes `<artifactRoot>/_invocations/<id>/`:
  `invocation.json` (redacted argv, plan, live status, each run's result and
  the final summary; marked `aborted` on SIGINT/SIGTERM), its own
  `events.ndjson` with live services, hook and phase events, and `logs/`
  (`narration.log`, `services-docker.log`, `services-seed.log`,
  `hook-before-NN.log`, `hook-after-NN-<runId>.log`). Runs carry an
  `invocation {id, index, total, dir}` link in `run.json` and `run.started`.
  Retention keeps the newest 20 journals plus any that still reference a run
  directory, and never removes one whose process is alive.
- **Live logs.** Every run writes `run.log` (plain narration ending in a
  `run end:` line), `logs/precondition-NN-<name>.log` and
  `logs/outcome-<id>.log` for node script verifiers, redacted line by line.
  Precondition events gain `logPath`. Docker and seed command output streams
  live, redacted, into the journal.
- **Progress reporting.** Preconditions get `CAIRN_PROGRESS_FILE` (append one
  line per update) and node script verifiers get `ctx.progress(message)`;
  updates become `precondition.progress` / `outcome.progress` events and show
  in `run.log`, stderr narration, JSON narration and the TUI.
- **Run context for shell steps.** Preconditions receive `CAIRN_ENV`,
  `CAIRN_BASE_URL`, `CAIRN_CONFIG_DIR`, `CAIRN_RUN_ID`, `CAIRN_RUN_DIR` and
  `CAIRN_RUN_TOKEN` (a precondition's own `env:` wins). `--before` hooks get
  the environment, base URL and config dir; `--after` hooks get all six.
- `cairn run --format json|yaml --log-format json` narrates progress as NDJSON
  on stderr (`scope: "progress"`): run start, preconditions with budgets,
  steps, outcome verdicts with expected/actual, batch rows and run end. Raw
  service output and the `--repeat` summary stay NDJSON too.
- `cairn logs` gains `--follow` (stream until the run or invocation settles;
  exit 0 when it settled, 2 when its process died or the target is missing),
  `--log run|precondition|outcome|<file>`, and
  `--invocation <id|latest|previous>` with
  `--log narration|services|hook|<file>` and a `--format json|yaml|md` /
  `--json` summary. While a `cairn run` is still going, `latest --follow`
  follows that invocation's current run, and waits while it is still booting
  services or `--before` hooks instead of replaying the previous, finished
  run (`--invocation latest --follow` streams that boot phase). `--format` /
  `--json` apply to invocation summaries only; on a run reference they exit 2
  instead of being ignored. `cairn explain` now documents `cairn logs`.
- **Export manifest and drift check.** `--project`, `--into` and `--out-dir`
  exports write `.cairn-export.json` (exporter version, content-only spec
  digests, file hashes; `--var` values are never recorded, and `generatedAt`
  is kept when nothing else changed). `cairn export playwright --check
  <exportDir>` regenerates the export in memory and reports stale, missing,
  orphaned and hand-modified files plus a status per spec: exit 0 fresh,
  1 stale, 2 error. CI runs it on the exported examples project.
- Export coverage adds `diagnosticSkips`, `semanticRisks` (`envBaked`,
  `absolutePath`, `requiredInfra`, `requiredSetup`, `unresolvedSplice`,
  `literalSplice`, `evalRatio`, `secretInBrowser`) and `fixme`. Coverage of an
  imported action is copied into every test that calls it, and the markdown,
  JSON and generated README list reasons and risks per spec.
- Exported tests bind `${requests|evals|artifacts.…}` splices: `request`,
  `eval`, `download` and network-postcondition `assign:` values become typed
  bindings, and `--project` actions return what they captured. A splice that
  cannot be bound marks the test `test.fixme` instead of emitting a literal
  `${…}`. Request-step responses feed the test's network evidence.
- `--project` exports are relocatable: the project root is resolved relative
  to the export on real paths, `CAIRN_PROJECT_ROOT` overrides it with a
  fail-fast message, and upload files are copied into `fixtures/` (regular
  files inside the project root up to 10 MiB; anything else keeps its path
  and gets an `absolutePath` risk).
- `cairn import playwright` ignores `test.step`, hooks, `test.use` and
  `describe` when finding the test, accepts `test(title, options, fn)`, turns
  `test.step` titles into step/outcome ids, and maps the exporter's
  `verifiedFill` / `verifiedType` / `clickUntil` helpers back.
- `cairn spec heal --env/--config/--var` resolve exactly like `cairn run`
  (environment, vars, config `browser:` block) for every heal rerun; MCP
  `cairn_spec_heal` takes the same `env`/`config`/`var` inputs.
- `cairn discover` and `cairn snapshot` accept `--var key=value` for
  `${vars.X}` in the URL, scan `browser.testIdAttribute` and report it. MCP
  `cairn_discover_open` accepts `config` and `var`; `cairn_run` accepts
  `config` and `var`.
- New placeholder `${config.dir}`: the directory of the resolved
  `cairntrace.config.yml` (an explicit `--config`, else the one found above
  the spec; the cwd without a config), in specs, actions and the config file
  itself. `cairn run`, `spec verify`, `spec heal` and both exporters resolve
  it the same way. `${project.root}` (the parsed file's own directory) is now
  documented.
- `cairntrace.config.yml` supports YAML anchors and merge keys
  (`<<: *shared`).
- MCP `cairn_spec_verify` runs the same code path as `cairn spec verify`,
  including the placeholder reference audit; it accepts `var` and returns
  `exitCode`, `errors` and `referenceFindings`.
- A test fails the build when `cairn explain` lists a flag a command does not
  register, or omits one it does.
- **Environment policy.** Specs declare where they may run with
  `requires: { env: [local, { dev: { optIn: VAR } }], mutates: true }`;
  environments declare `policy: { trait: owned | shared | protected,
  mutations: allow | deny, description }`. `cairn run` and MCP `cairn_run`
  check every spec before secrets, services, the webServer, hooks,
  preconditions or a browser start. A refused spec gets the new status
  `refused`, a `refusal` block (`reason`, `env`, `requires`, `code`,
  `policy`), skipped outcomes, no run directory and a `run.refused` event in
  the invocation journal; it is never stashed, investigated or retained.
  `cairn run` exits 7 (new exit code) when every spec was refused — one spec
  or many, whatever `--parallel` — and the journal settles `failed` with
  `summary.exitCode: 7` and `summary.refused` (MCP `cairn_run_status`
  says `failed` too). A batch where other specs ran fails on a refusal only
  with the new `--strict-requires` (MCP `strictRequires`). `--select-only`
  lists refused specs under `skipped` with the reason. The markdown batch
  summary, the TUI, MCP text and `cairn_run_status` show a refused count and
  the reason, never a run directory. A spec only `runSpec`'s own guard
  refuses (one the preflight could not evaluate) is reported the same way.
  `cairn spec heal` and MCP `cairn_spec_heal` exit 7 (`no-heal-possible`)
  on a refused spec.
- `cairn spec verify` reports where a spec may run: `environment` (the
  resolved one, allowed or not) and `environments[]` (every configured
  environment), plus structured `findings`. An explicit `--env` the policy
  refuses is an `env-not-allowed` error (exit 4). Verify also fails (exit 4)
  when a file the spec or its actions reference is missing where a run would
  look, and warns on absolute host paths outside the project. MCP
  `cairn_spec_verify` returns the same `findings`, `environment` and
  `environments`.
- **Action-relative step files.** `upload.path`, `eval.file`,
  `transform.file` / `input` and eval `args.filePath` / `fixtureFiles` in
  an imported action resolve against the action's own directory. The old
  spec-relative location still works with a deprecation warning naming the
  action and step (once per process on stderr, and in every run's `run.log`).
  New placeholder alias `${file.dir}` = `${project.root}`. Single-file
  exports (`cairn export playwright`, `--stdout` and MCP `stdout`) resolve
  the same way, fallback included; `--project` action modules resolve
  against the action's directory only.
- **Scoped checkpoints.** `cairn login` and `checkpoint capture-from-session`
  take `--env`, `--config` and `--ttl`, and write `<name>.meta.json`
  (`baseUrl`, `env`, `createdAt`, `ttl`, `expiresAt`, and the state file's
  `stateSha256`); MCP `cairn_checkpoint_capture` writes the same scope (the
  discovery session's environment baseUrl, else the page origin; optional
  `ttl`). Runs enforce the scope (see Changed: `session.resume` is
  enforced). `checkpoint list` /
  `show --json` and MCP `cairn_checkpoint_list` / `_show` report `health`
  (`ok` / `expired` / `unscoped`) and `staleMeta: true` when the state was
  rewritten after its metadata (which is then ignored). `spec verify` warns
  about unusable checkpoints. Without `--env`, `cairn login` scopes to the
  origin where the login ended, not the `--url` start page (an identity
  provider on another domain); `--env` is the reliable scope.
- **Cancellation reaches inside runs and the services boot.**
  `cairn_run_cancel` and a cancelled MCP request kill the process tree of a
  running precondition, node transform, node script verifier, or
  docker/seed/readiness/healthcheck command, stop readiness waits, skip the
  remaining preconditions, steps and outcomes (reported `skipped`) and tear
  down the services already started. The running spec still writes a
  consistent run with `status: errored`, `failure.phase: "cancelled"`, also
  when the cancel lands while the spec is still being parsed. Only teardown
  commands and an in-flight `file` / `xlsx` check keep running (the
  `cairn_run_cancel` description says so).
- **Export and the environment policy.** `requires.env` becomes a run-time
  `test.skip(...)` on `process.env.CAIRN_ENV` (plus opt-in variables)
  before `beforeAll`. When the export bakes an environment's baseUrl, the
  guard accepts only that environment; where the policy refuses the spec
  there, the test always skips and a new `envPolicy` semantic risk is
  reported.
- **Evidence gate.** Every stash of a run directory (auto-stash,
  `cairn stash save`, `pin --stash`, the retention archive, auto-investigate,
  `cairn investigate`, `cairn audit --connect`, `cairn clip --stash`, MCP
  `cairn_clip`) and every publication carries only `[text, screenshots]` by
  default; `stash.include`, `retention.publish.include` or `--include` on
  `cairn stash save` / `cairn publish` opt into `traces`, `videos` and
  `downloads`. What is left out is listed as `excluded` and saved through a
  private staged copy named after the run.
- Every `artifact-manifest.json` entry has a `sensitivity`: `redacted`
  (written by cairn through the run redactor), `safe` (screenshots, videos,
  downloads), `sanitized` (a trace the sanitizer rewrote: stashed only when
  `traces` is included, never published) or `secret-bearing` (an
  unsanitized trace, a raw `monitor` heap profile, any text file cairn did
  not write itself such as `--after` collector output: stashed only with
  `stash.unsafeIncludeRawTraces: true`, never published).
- Kept traces are sanitized when the run ends (best effort, shape kept so
  Trace Viewer and Perfetto still open them): credential headers and cookies
  by name pattern (custom auth headers included), `storageState` /
  `localStorage` / `sessionStorage` contents, values typed into password
  fields wherever they appear, sensitive `name=value` parameters in URLs,
  fragments and form bodies (a leading parameter, `client_secret`,
  `id_token`, `code`, `SAMLResponse`), and registered secret values. A trace
  that cannot be rewritten stays local as `secret-bearing`.
- `artifacts.capture.traceMaxBytes` (default 50 MiB) and a new
  `artifact.trace` event (`saved` with `format` and `sensitivity` |
  `error` with a reason | `dropped`); a dropped or failed trace never
  changes the run status.
- **Pin.** `cairn pin <run> [--reason] [--stash]` / `cairn unpin <run>`
  (`--json`; MCP `cairn_pin` with `unpin: true`) write
  `pinned: {at, reason?}` on run.json. Retention never prunes a pinned run
  (it re-checks the pin right before archiving and before deleting), pinned
  runs take no `keepRuns` / `keepFailedRuns` slot, `cairn clean --all`
  keeps them and `--include-pinned` removes them. `pin --stash` saves the
  run with the `keep` tag and no TTL.
- **Publish.** `cairn publish <run> [--retention-days N] [--include] --json`
  and MCP `cairn_publish` send the gated run to the private file.cheap
  artifact service, plus a metadata-only RunIndexV1 sidecar (at most 12 KiB;
  passed outcomes are dropped first when it would not fit) when fcheap
  supports `--run-index`. The run gains `publish-receipt.json` and an
  `artifact.publish` event; `runIndexSkipped` (`unsupported` | `too-large`
  | `build-failed`) says why no sidecar was sent. Failures exit 2 with a
  reason code (`auth` matched as a word, not inside a path; `too-large`,
  `timeout`, …) and never print fcheap's stderr; retention event messages
  are path-free. `ArtifactRefV1` accepts a validated https `web_url` (no
  credentials, query or fragment).
- **Auto-stash options.** `cairn run --stash` (MCP `cairn_run` `stash`)
  stashes every run whatever its status; `stash.autoStash` gains `always`;
  `stash.ttl` / `passTtl` (default 7d) / `failTtl`; `stash.labelsAsTags`
  (default false); `stash.meta` (run_id, status, spec, env, backend and
  cairn_version as `fcheap save --meta` when supported); a spec's top-level
  `stash: { tags }`. MCP `cairn_stash_save` takes `include` and `config`.
- `stash-receipt.json` gains `action`, `contentHash`, `fileCount`,
  `sizeBytes`, `ttl`, `expiresAt`, `tags`, `excluded` and
  `secretsFound` (file.cheap's save-time secret scan; the CLI warns with the
  matched rules), and is written for `cairn stash save`, `pin --stash`,
  `cairn investigate`, `audit --connect` and `clip --stash` too (`action:
  "manual"`). A failed stash, archive or publish records an `artifact.stash`
  / `artifact.publish` event with `status: "error"`, a reason code and a
  path-free message.
- `cairn doctor` and MCP `cairn_doctor` report the fcheap version and
  `save --meta` / `publish --run-index` support (`fcheap`), the console
  session (`fcheap-auth`, informational) and publisher readiness
  (`fcheap-publisher`, failing only when exactly one of the two variables is
  set), never printing values.
- Run documents gain `synthetic: true` (additive) when cairn never created
  the run — a refused spec, or one that errored or was cancelled before its
  run started: `runId` and `runDir` are placeholders with nothing on disk.
  Invocation journal run entries and `cairn_run_status` rows carry the same
  flag; the CLI, MCP and Studio never point at those paths. A spec whose run
  had already started keeps its real run directory in the document.
- The invocation journal summary gains an optional `refused` count, and a
  refused spec no longer stays the journal's `current` run.
- **Project catalog.** `cairn catalog [--config] [--env] [--query <words>]
  [--kind actions|vars|verifiers|envs|flows|checkpoints] [--limit N]
  [--artifact-root] --format json|yaml|md`
  (`urn:cairntrace.dev:catalog:v1`) lists what a project already has so an
  agent reuses it instead of re-recording literals: reusable actions
  (description, inputs with defaults, steps, used-by including chains, last
  green run), config vars per environment (authored value with placeholders
  kept, the YAML comment above the key, `environment` or `inherited` through
  `<<:`), script verifiers with their fixtures contract and each use's
  `unknownKeys` / `missingKeys`, environments (policy, services, secret key
  names), flows (intent, tags, requires, actions, checkpoint, draft, last
  run) and checkpoints. It reads files only. `--query` ranks rows by keyword
  (name > description/intent/tags > inputs > comments; camelCase /
  snake_case / kebab-case words, light stemming, `log in` / `logged in` /
  `sign in` → `login`) and explains each match (`score`, `matched`). Last
  runs are matched by the spec's own path (`matchedBy: "name"` marks a
  fallback to a same-named run). Only checkpoints a spec here resumes or one
  captured for a configured environment's origin are listed; the rest are
  counted in `scan.otherCheckpoints`. A malformed file or row is left out
  and named in `warnings`. Exit 2 usage, 4 config error (invalid config,
  unknown `--env`, `--env` with no config). MCP `cairn_catalog` takes the
  same inputs and answers with a short text summary plus the rows in
  `structuredContent` (at most 20 per kind without `query` or `limit`);
  the `cairn://catalog` resource is the compact catalog of the server's
  project. New docs topic `cairn docs catalog`.
- Secret-looking catalog vars are masked: credential words in the name
  (plurals and run-together names such as `accessTokens`, `DBPASSWORD`,
  `codeVerifier`, `samlAssertion`; `otp` only as a whole word), token-looking
  literals, token-looking `${env.X:-…}` fallbacks and passwords inside URLs.
- Reusable actions accept an optional `description:` and
  `inputs: { <name>: { description, required, default } }`. The parser
  rejects an input `default` that differs from `vars.<name>` (or has no
  `vars.<name>`) and a `required` input with a default. A required input
  must reach the action from the importing spec's `vars:`, a config
  environment var or `--var`; a `use:` call site can override it but is not
  enough on its own.
- **Discovery sessions start from a setup.** `cairn_discover_open` takes
  `setup` — imported actions (`[{ use, vars? }]`) or a spec's first steps
  (`{ fromSpec, untilStep }`, keeping its imports, vars, `requires`,
  `coldStart: guest`, `settleMs`, `viewport` and `redaction`; its
  preconditions are not run, and a warning says so) — plus `imports`,
  `resume` (a checkpoint), `backend` (`playwright` accepted per session),
  `config` / `env` / `var` and `ttlMs`; `url` is optional when the setup or
  resume leaves you on the page. Actions are found through explicit
  `imports`, then config `authoring.template.imports`, then an `actions/`
  folder under the config directory. Every discovery action (setup, open,
  interact, resume replay) runs through the `cairn run` engine on the
  session's live browser, without a cold start. Export writes the setup as
  `imports` + `use:` steps (or the source spec's own steps), never the
  expanded steps.
- `cairn_discover_interact` adds `focus`, `press` with a target, `eval`,
  `wait`, `request`, `assert` (recorded as a wait step, 5s limit live) and
  a raw `step` (any spec step, `use:` included, whose action file then
  travels into the export, the draft and resume). Recorded steps are checked
  against the spec schema; a value equal to a known secret is recorded as
  `${secrets.X}` / `${env.X}`; relative upload and eval paths are recorded
  as `${config.dir}/…`; eval and request values come back in `result`. An
  eval/request `assign` makes `${evals.X…}` / `${requests.X…}` available to
  later actions (the recorded step keeps the placeholder). A step that
  references a value nothing captured, a captured value that was redacted,
  or an earlier action's `${artifacts.X}` is refused instead of running with
  the literal placeholder.
- Network visibility in discovery: interact and navigate results carry
  `network.mutations` (method, path, status of non-GET requests), and the
  new `cairn_discover_network` lists every request seen, including ones that
  finish after an action returned. Entries never carry headers, bodies or
  query strings.
- Discovery snapshot modes `none | diff | compact | full` with stable element
  keys and `maxBytes` (default 16384, covering the elements and `removed`
  together). The mode passed to open becomes the session default (MCP
  default `diff`, so an unchanged page returns no elements); the full text
  is always journaled. Element names and attribute values are redacted
  before keying, diffing and measuring.
- **Session journals.** Every discovery and accompany session writes
  `<artifactRoot>/_sessions/<id>/`: `session.json` (atomic; status, origin,
  client, setup, imports, current URL, step count, last export's intent and
  outcomes, …), `events.ndjson` (session events in `events.v1`),
  `snapshots/`, `screenshots/`, `network/`, `draft.spec.yml` and the setup
  run. The browser closes after `ttlMs` idle (default 30 min; config
  `discovery.sessionTtlMs`) and the journal stays as `expired`; export,
  suggest and network work from the journal alone. New MCP tools
  `cairn_discover_resume` (re-opens a browser, restores the checkpoint, runs
  the setup and replays every recorded step; refused while the session is
  open in this or another live process) and `cairn_discover_remove_step`;
  `cairn_discover_list { all: true }` includes closed journals. Journals keep
  values made only of placeholders (`?token=${secrets.X}`,
  `Bearer ${env.X}`), and resume refuses — a journal export warns about — a
  step stored as `[redacted]`. Retention and `cairn clean` keep the newest
  50 journals plus open ones and any an existing exported spec still names.
- `cairn discover [url]` takes setup flags (`--use`, `--import`,
  `--from-spec`, `--until-step`, `--resume`; exit 7 when the environment
  policy refuses a `--from-spec` setup, 4 when a setup cannot be resolved),
  `--snapshot-mode` and `--max-bytes` (the whole tree unless given), and
  leaves a journal. New `cairn discover sessions` lists
  journals, and `cairn discover export --from-session <dir|id>` writes a spec
  from one after the browser is gone; its `--intent` / `--outcomes` default
  to the session's last export (a warning says so).
- Config `discovery: { sessionTtlMs, backend }` joins the config schema
  (`cairn config validate` accepts it).
- Accompany sessions journal each choice under `_sessions/` and apply
  accepted replacements to a draft copy (`draft.spec.yml`, or `draftTo`),
  never the source spec or its imported action files; the draft keeps the
  spec's placeholders, comments and YAML validity. A `draftTo` that is the
  source through a symlink, a hard link or a letter-case variant is refused.
- **Convention exports.** `cairn_discover_export` and
  `cairn discover export` take `into`, `name`, `conventions`,
  `reuseActions`, `liftVars`, `refuseSecrets` (CLI
  `--allow-secret-literals`), `requires` and `tags`. A convention export
  writes a draft the project's way: recorded steps that match a catalog
  action (at least two steps, confidence ≥ 0.8) become `use:`, literals equal
  to a config var become `${vars.X}` (never in locator keys, numbers or
  short values that only coincide), URLs become relative to `baseUrl`,
  steps get snake_case ids, navigations get a URL wait that the page before
  them cannot satisfy, saves get `postcondition.network`, and
  `authoring.template` applies. The result's `report` lists reused actions,
  lifted vars, secrets written as placeholders and warnings, located at the
  step's position in the written file.
- Config `authoring: { draftsDir, template: { requires, metadata.tags,
  imports } }`; `draftsDir` (default `flows/_drafts`) must name a folder
  starting with `_`.
- **`cairn spec lint <spec...> [--env a,b] [--fix]`** and MCP
  `cairn_spec_lint` (`urn:cairntrace.dev:spec-lint:v1`): fix-its before a
  run — unquoted `#` selectors, schema problems explained per step, missing
  files (precondition `cwd` included), echo-only cold starts, script fixture
  keys outside the verifier's contract, literal secrets, evals a typed step
  does better, host paths, placeholders that would reach a shell literally,
  missing step ids, and `${vars.X}` per environment. Exit 4 on any error.
  `--fix` only quotes `#` selectors and adds step ids, writes only when the
  edited file parses to the same document plus those edits, and adds no ids
  to a file with YAML anchors or aliases.
- **`cairn spec finish <spec>`** and MCP `cairn_spec_finish`
  (`spec-finish:v1`): lint, a cold-start run through the `cairn run` engine,
  stamp when green, the `agent_context.md` summary and next actions. It
  takes the run flags it needs (`--env`, `--config`, `--var`, `--backend`,
  `--mock`, `--headed`, `--no-services`, `--no-web-server`,
  `--reuse-services`, `--artifact-root`, `--provider`, `--device`; MCP
  camelCase), reuses a `cairn services up` lock held for its environment,
  suggests `--no-web-server` when a dev server is already listening, and
  records a finish receipt (status, content hash, backend) under
  `<artifactRoot>/_finish/` for promote. A green finish on the mock backend
  says "green on the mock backend only".
- **`cairn spec promote <draft> [--to] [--force] [--expect-content-hash
  <sha256>]`** and MCP `cairn_spec_promote` (`spec-promote:v1`): moves a
  draft out of the drafts dir only after a green real-backend finish of its
  exact content, rebases relative paths (imports, files, precondition
  `cwd`, eval `args.filePath` / `fixtureFiles` next to the draft), stamps
  the contract hash, never overwrites a spec, and rolls back (keeping the
  draft) when the promoted copy would point at files that do not exist.
  `--expect-content-hash` refuses (exit 4, even with `--force`) a draft
  whose text is no longer the one a reviewer saw.
- The MCP prompt `author-flow`, `cairn docs author-flow` and
  `cairn init agent-kit [--write]` give agents the recipe from a request to
  a promoted spec: catalog → discovery started by the login action →
  convention export into the drafts dir → `cairn spec finish` → report, and
  promote only after the human approved.
- **`cairn services up [--config] [--env]`** starts the config services
  (docker → seed → tmux) through the run's own code path, leaves them
  running and writes an owner lock, one per config file
  (`~/.cairntrace/services/<config dir>.<hash>.lock.json`, keyed by the
  config's real path). **`cairn services down`** runs the configured
  teardown commands in order, kills a still-running tmux session and
  removes the lock; it warns when no teardown command stops the docker
  phase. Both print `urn:cairntrace.dev:services-up:v1` /
  `services-down:v1` and are MCP tools (`cairn_services_up` /
  `cairn_services_down`).
- **`cairn run --reuse-services`** (MCP `reuseServices`) runs against the
  locked stack: one readiness check (docker `readinessCheck`, else
  `docker compose ps` with the command's own `-f` / `-p` /
  `--project-directory` / `--env-file` / `--profile` and `docker.env`; a
  command it cannot read is trusted and reported as `unchecked`), then it
  starts and tears down nothing — only `services.docker.reuse`,
  `services.seed.skip` and `services.tmux.reuse` events — and the browser
  starts cold unless `coldStart` is set. `cairn audit --reuse-services` and
  MCP `cairn_audit` `reuseServices` too.
- `cairn services status` / `cairn_services_status` take `--env` / `env` and
  report `env` and `lock` (owner, env, age; for a lock held for that env
  also `stale`, `problems` and `unchecked`, checked with the env's scoped
  secrets).
- **Datasources.** A top-level `datasources:` config block names the
  connections the data verifiers (and mongo/http fixtures) read: `kind:
  mongo` (`uri`, or `docker: { service | container, project?, uri? }`, plus
  `database`; the optional `mongodb` driver is used when the project installed
  it — looked up from the spec's directory and the working directory first —
  else `mongosh`, else `docker exec -i` into the compose service's
  container), `kind: temporal` (`api`, `namespace`, basic or bearer `auth`)
  and `kind: http` (`baseUrl`, `headers`, `auth`).
  `environments.<env>.datasources` merges a partial entry over the top-level
  one (`<name>: false` disables it there). Strings take `${secrets.X}`,
  `${env.X}` and `${vars.X}`; an unset secret fails at once. `guard.databases`
  / `guard.hosts` (also checked against a docker `uri`) and `mode: read-only`
  refuse anything else. The mongo query reaches `mongosh` as EJSON on stdin and
  the connection string through the environment, never on a command line.
  Evidence names a source by `{ name, kind, transport, database, hosts }`;
  connection strings and credentials never reach artifacts, and transport
  errors are scrubbed.
- **Data verifiers** `mongo` (find + count with extended-JSON filters,
  `expect.count` / `exists` / `fields`), `temporal` (describe a workflow — 404
  means absent — or a visibility `query` with its count; `status`,
  `activities.includeAll|includeAnyOf|maxAttempts` (still-retrying activities
  count), `inputBytes.atMost`, `absent: true | { stableMs }`; full history
  across pages and continue-as-new), `http` (a Node-side call, no browser
  cookies, to a datasource or a URL; `status` and JSON paths), `value`
  (path matchers over `${captures|requests|evals|runs|fixtures|network.*}`,
  `${run.startedAt}` or a JSON file) and `table` (a rendered table:
  `rows`, `contains`, `headers`, blank rows). They share one matcher shape
  (`equals`, `contains`, `matches`, `oneOf`, `atLeast`, `atMost`, `exists`,
  `empty`, `each` / `all`, `ignoreCase`), whose operands may splice runtime
  references. `mongo`, `temporal` and `http` take `assign`, exposing their
  result to later outcomes as `${captures.<name>…}`. Each writes
  `outcomes/<id>.raw.json` with the redacted request and a bounded
  observation (20 rows of at most 4KB, `truncated`).
- **`poll` on every verifier:** `poll: { timeoutMs, everyMs, stableMs,
  failFastOnStepFailure }` next to the verifier kind. With `stableMs` a pass
  only counts once it held for the window over at least two samples (a red
  sample restarts it); `stableMs + everyMs` must fit in `timeoutMs`. Errors
  waiting cannot fix (unknown datasource, guard refusal, missing secret or
  binary, unresolved reference, Temporal 400/401/403, an `http` URL outside
  its datasource's origin) fail at once. Each attempt is an
  `outcome.progress` event (`attempt 3/~30: count=0 (want 1)`);
  `outcome.passed` / `outcome.failed` carry `attempts` and `polledMs`, and the
  raw sidecar keeps the first 5 and last 15 attempts.
- `network` verifier: request `body: { json, match: subset | exact }`,
  `count` (a matcher over the matching requests) and `assign`
  (`${network.<name>.at|firstAt|count|…}` for later outcomes); `status` is
  now optional.
- **`expect` step:** a mid-flow assertion with outcome-like evidence — a
  locator plus `visible` / `hidden`, `count`, `text`, `value`, `attribute`,
  `enabled`, or `expect.request` (status and JSON paths through the
  browser-session request transport), retried every 250ms until `timeoutMs`
  (default 5000 × `waitScale`). A mismatch fails the step; evidence goes to
  `expects/<NNN>_<id>.json` with an `expect.passed` / `expect.failed` event.
- **`capture` step:** stores `text`, `value`, `attribute` or a whole `table`
  (`{ headers, rows, cells, rowCount }`) from the page as
  `${captures.<assign>…}` for later steps and verifiers, with
  `captures/<assign>.json`. `expect` and `capture` resolve references
  themselves: typed where the schema is typed, and an unknown name fails the
  step instead of becoming `""`.
- **Readiness gates.** A top-level `gates:` registry of named probes — `tcp`,
  `http` (`status` as a code, class, range or list; dotted-path `json`
  matchers; `text`; `headers`; basic/bearer `auth` with `${secrets.X}`
  resolved when the probe runs), `command` (`exitCode`, `stdout`; the process
  group is killed past its timeout), `gate` (another name), `all` / `any` —
  plus `stable`, `every` and `timeout`. Gates are used by
  `services.docker.ready`, tmux `windows[].readyOn.gate` (in addition to
  url/text) and `windows[].after` (boot a window once its gates pass),
  `webServer.ready`, and a spec's `preconditions.wait` (before the
  precondition commands; a failed gate errors the run as precondition
  `wait <gate>`). `cairn wait <gate|url…>` (`--status`, `--any-response`,
  `--timeout`, `--every`, `--stable`; `urn:cairntrace.dev:wait:v1`; exit 0
  ready, 1 not ready, 2 unreadable config, 4 invalid input) and MCP
  `cairn_wait` check them from outside a run. Waits emit `gate.started`,
  `gate.attempt` (coalesced), `gate.passed` and `gate.failed` into the run's
  events and, for services and the webServer, the invocation journal. The
  config schema rejects unknown gate names and reference cycles.
- **`run:` step:** a host shell command (`args` become `$1…$n`) or a node
  script (resolved against the file that declares the step) with `cwd`,
  `env`, `timeoutMs` (default 120000) and `assign` (the last stdout line as
  JSON, read later as `${runs.<assign>.<path>}`). It gets the `CAIRN_*` run
  context, runs in its own process group (killed at the deadline, on cancel
  and when cairn exits) and settles when the command exits even if a
  background process it started holds stdout. Step events carry a label
  without the command text.
- **Spec `teardown:`** — a list of steps, or `{ steps, failRun, timeoutMs }`
  — always runs after the steps and outcomes: on pass, fail, an early stop
  (failed precondition or gate) and cancel, with `CAIRN_RUN_STATUS` in the
  child environment. On SIGINT/SIGTERM the `run` items that have not started
  run synchronously from the signal handler (at most 30s, with
  `CAIRN_RUN_SIGNAL`), each item exactly once even in a host that survives
  the signal. A failed item is reported (`teardown.started` /
  `teardown.finished` events, `run.log`, a CLI warning) but keeps the run's
  verdict unless `failRun: true`, which turns only a passed run into errored
  (`failure.phase: teardown`). `use:`, artifact-producing steps and
  `expect` / `capture` are refused in teardown.
- **Fixtures registry.** A config `fixtures:` block declares named test data
  — `kind: exec | mongo | http` with `ensure`, `reset`, `verify` (read-only:
  the schema and the adapters refuse writes there) and `teardown`; `scope:
  run | suite | seed`; `with` parameters, `outputs`, `needs`,
  `owner: { exactlyOne, marker }`, `ttl` and `timeoutMs`. A spec lists them
  (`name`, `name.reset`, `{ use, with, write }`): they are ensured (needs
  first) after `preconditions.wait` and the precondition commands and before
  the browser starts, their outputs splice as `${fixtures.<name>.<key>}` into
  steps, teardown and verifiers, and run-scoped fixtures are torn down after
  the spec teardown, newest first, on every outcome. Suite fixtures are
  ensured once per invocation; seed fixtures are reused while the ledger
  shows them fresh and are never torn down by a run. The `mongo` adapter
  offers insert/update/replace/delete, `cloneDoc`, `findOne` / `count` with
  `expect`, marker-scoped deletes and a mongosh `script` escape hatch; the
  `http` adapter does find-or-create by natural key with a login helper and
  tears down only records it created or that carry its marker. On `shared`
  and `protected` environments, and wherever `mutations: deny`, writes are a
  dry-run unless `--allow-fixture-writes` (MCP `allowFixtureWrites`) or
  `write: true` allows them (`mutations: deny` always wins). Evidence:
  `fixture.ensure|reset|verify|teardown` events, `<runDir>/fixtures.json`
  and the ledger `~/.cairntrace/fixtures/<project>.ledger.jsonl`, folded per
  environment and run instance; outputs under sensitive keys are redacted
  everywhere.
- `cairn fixtures list | status [--verify] | ensure | reset | teardown |
  sweep [--older-than] [--apply] [--include-seed] [--allow-writes]`
  (`urn:cairntrace.dev:fixtures:v1`, exit 0/1/2/4) and the MCP tools
  `cairn_fixtures_list`, `_status`, `_ensure`, `_reset`, `_teardown` and
  `_sweep`. `cairn catalog` gains the `fixtures` kind (with `usedBy`
  specs), and `cairn docs fixtures` documents the registry.
- **Actions import actions.** A reusable action may declare `imports:`
  (relative to the action file), so actions load recursively and a nested
  `use:` resolves against the action's own imports, then its importer's.
  Explicit call vars win over inherited ones, then spec vars, then the
  nested action's defaults. Import cycles, `use:` cycles and duplicate action
  names are parse errors; heal, origins and step-file paths point at the
  innermost file, and `--project` exports turn a nested `use:` into a call
  to that action's module.
- **Verifier SDK** `@thelacanians/cairntrace/verifier`:
  `defineVerifier({ description, fixtures: z.object(…), run(ctx) })` gives a
  node verifier typed, validated fixtures (YAML strings coerced to the
  declared number/boolean/date/array/object; unknown keys rejected unless
  `.passthrough()`; mismatches reported without echoing values), `ctx.poll`
  (`until`, `within`, `every`, `stableFor`, `failWhen`; each attempt bounded;
  bounded evidence on timeout), `ctx.datasources.<name>.<method>()` (calls run
  in the runner over an authenticated loopback channel, so credentials never
  enter the verifier), `ctx.network.find` / `findOne`, `ctx.captures`,
  `ctx.runs`, `ctx.fixturesOutputs`, `ctx.run` (`id`, `token`, `startedAt`,
  `labels`, `failedStep`, `lastSuccessfulStep`, `dir`), `ctx.deadline` /
  `remainingMs()`, `ctx.signal` (aborted at the deadline and on cancel:
  SIGTERM, then the process tree is killed 1s later), `ctx.xlsx(path)` and
  `ctx.fail()`. The runner hands the child its own SDK copy, so verifiers need
  no local install. Plain scripts keep working unchanged; `script.fixtures`
  now also accepts YAML lists and maps (top-level scalars stay strings).
- `cairn verifier schema <file> [--load] [--timeout-ms] --format
  json|yaml|md` (`urn:cairntrace.dev:verifier-schema:v1`) prints a
  verifier's fixtures contract, read statically from the `defineVerifier`
  schema without executing the file (`--load` imports it in a bounded Node
  child). `cairn catalog` and `cairn spec lint` prefer the SDK contract; with
  one, an unknown or missing required fixture key is an error. New docs page
  and topic `scripts` cover the SDK.
- `cairn spec verify` reports `unknown-gate` (a `preconditions.wait` name the
  config's `gates:` lacks) and `unknown-fixture` (a `fixtures:` name the
  config lacks) as errors (exit 4). `cairn spec lint` adds
  `shell-arg-unset` (a warning: a `run:` shell command reads `$N` that the
  step does not pass in `args`). `cairn config validate` reports datasource
  entries that only break after an environment's override is merged (exit
  4).
- Exports: `expect` steps become Playwright web-first assertions (count
  matchers through `expect.poll`); `capture`, `run` steps, the data
  verifiers, `expect.request`, `network` `body` / `count` and config
  fixtures are hard skips with reasons (the test becomes `test.fixme`);
  `poll`, the spec `teardown:` and `preconditions.wait` are soft skips with a
  `requiredSetup` risk. A `--project` export whose copied verifier imports
  the SDK lists `@thelacanians/cairntrace` in its `package.json`. The brief
  exporter marks the new steps and verifiers machine-checked.
- `cairn explain` documents the new steps, verifiers (`poll` on each),
  `cairn wait`, `cairn fixtures …` and `cairn verifier schema`; `cairn docs`
  gains the `fixtures` topic and an authoring section on data, readiness and
  cleanup. New docs pages: Fixtures, Script verifiers & SDK; the
  Verifiers page is rewritten (datasources, polling, matchers, evidence) and
  Steps and Services gain the new steps, teardown and readiness gates.
- Examples: `flows/platform/30-restock-job.yml` (a readiness gate, the
  `demo_product` exec fixture, `expect` / `capture`, `expect.request`, an
  `http` verifier on the `demo_api` datasource polled until an async restock
  job is done and stays done, `network` body + count, `value`) and
  `31-run-step-teardown.yml` (a `run:` step with `assign`, `expect`,
  `capture` + `value`, a spec `teardown:`), backed by a small JSON API in the
  demo app (`POST` / `DELETE /api/products`, `POST /api/restock`,
  `GET /api/restock/<id>`) and `examples/fixtures/demo-product.mjs`. CI's
  smoke runs both.

### Changed

- **`session.resume` is enforced.** After a spec's preconditions (which may
  create or refresh the state) and before any browser work, a run refuses a
  `session.resume` checkpoint that is missing, expired or captured for
  another origin (`failure.phase: "session"`), where 2.x ran on
  unauthenticated. A failed `loadState` fails the `session.resume` step
  instead of being ignored.
- **MCP services gate.** MCP tools start config services (docker/seed/tmux)
  and run their teardown only on a server started as
  `cairn mcp --allow-services` (or with `CAIRN_MCP_ALLOW_SERVICES=1`).
  Without it, `cairn_run`, `cairn_spec_finish` and `cairn_audit` whose config
  would start services fail with exit 4 before anything starts, and the
  error names `noServices`, `reuseServices` and the flag. `noServices`,
  `reuseServices`, `servicesDryRun` and environments with `services: false`
  are never gated. `cairn_services_up` and `cairn_services_down` refuse
  without the flag. An agent can no longer provision or sink a remote stack
  through MCP just because the project config can. The webServer and the CLI
  are not gated.
- **Config-authored env keys pass the child-env filter.** The filter that
  keeps `TVAULT_*`, `CAIRN_TVAULT_ENV` and `FILECHEAP_INGEST_TOKEN` away from
  project children now applies to what is inherited. A key a services phase
  or the `webServer` sets in its own config `env:` is passed as written.
- The npm package no longer ships test-only files (`src/testing/`,
  `__fixtures__/`, exporter goldens).
- The tag-time verify gate in `npm-publish.yml` runs on Bun 1.4.2, like
  `ci.yml`, instead of the newest Bun.
- **Unknown environments are config errors.** When a config exists, an
  explicit `--env` (MCP `env`) it does not define fails with exit 4 and lists
  the known environments: `cairn run` (before any secret, service, hook or
  spec starts; `--format json|yaml` still prints a schema-valid errored
  result or batch document), `spec verify`, `spec heal`, `discover` and
  `snapshot`. A spec's `environment:`, `defaultEnvironment` or the `local`
  fallback that the config lacks only warns — `cairn run` prints each
  warning once per invocation on stderr — so batch results no longer depend
  on spec order. `local` against `environments: {}` — the scaffolded
  `environment: local` or an explicit `--env local` — runs silently, as in
  2.15.0.
- **`CAIRN_TVAULT_ENV` and unselected `TVAULT_*` variables no longer reach
  child processes.** Preconditions, `--before`/`--after` hooks, docker, seed
  and tmux commands and the webServer's shell commands now receive exactly the
  filtered child environment; earlier releases merged the parent environment
  back in. Besides `FILECHEAP_INGEST_TOKEN` (see Security), that drops
  `CAIRN_TVAULT_ENV` and every `TVAULT_*` variable that is not an explicitly
  selected secret key, including non-secret ones such as `TVAULT_PROJECT`.
  The earlier notes that `CAIRN_TVAULT_ENV` follows `--env` still hold for
  resolving the config's `tvault:` block, not for a shell that reads
  `$CAIRN_TVAULT_ENV`. Migration: read `CAIRN_ENV` (the environment cairn
  resolved: `--env`, else the spec's `environment:`, else the config
  default) and pass `--env` explicitly. `CAIRN_ENV` does not follow an
  exported `CAIRN_TVAULT_ENV`, so a guard written `${CAIRN_TVAULT_ENV:-local}`
  now silently falls back to `local`; `cairn run` warns once on stderr when
  an exported `CAIRN_TVAULT_ENV` names another environment than the one it
  resolves.
- Discovery records open/navigate URLs as requested: `${secrets.X}`,
  `${env.X}`, `${vars.X}` placeholders and baseUrl-relative paths stay in the
  exported spec, and relative `cairn_discover_navigate` URLs join the
  baseUrl and stay relative. `cairn_discover_export` verifies with the
  session's env/config/var inputs and warns when a `${vars.X}` value came only
  from `var`. A relative discovery URL with no baseUrl fails on a real
  browser instead of navigating to a bare `/path`.
- `cairn discover` / `cairn snapshot` read the project config even for
  absolute URLs (for browser settings); an invalid auto-discovered config
  only warns there unless a config or env was given explicitly.
- `latest` / `previous` run references (`cairn logs`, `stash`, `investigate`,
  `clip`, `diff`, `context`, `export brief --from-run`, MCP) and the
  `cairn stats` scan consider only run directories
  (`<timestamp>_<spec>_<hex6>`), never `_invocations/` or other folders under
  the artifact root.
- `cairn config validate` parses the file exactly like `cairn run`
  (`${env.X:-default}`, YAML merge keys, `${config.dir}`), so a config that
  validates is the config a run sees.
- `cairn spec heal --verify`'s replay hint repeats `--env`, `--config` and
  every `--var`, shell-quoted.
- `precondition.run.output` keeps the last 4000 characters (with
  `outputTruncated`), and precondition failure messages the last 500, both
  redacted before they are cut.
- MCP `cairn_export_playwright` runs the CLI code path: `project`/`into`
  exports copy fixtures and write `.cairn-export.json`, batch `outDir`
  exports write the README and manifest, and specs that fail to export are
  listed under a new `errors` field (also in the CLI batch report).
- Exported test timeouts follow step budgets, including
  `postcondition.network.timeoutMs`; the 30-minute floor applies only to node
  verifiers and preconditions of 5 minutes or more, each `beforeAll` sets its
  own timeout, and the generated config sets `actionTimeout` /
  `navigationTimeout` to 30s.
- Export text needles with run tokens, secrets or action vars are normalized
  when the test runs, `when:` text needles are passed to `page.evaluate` as
  arguments, and a surviving internal `__CAIRN_…__` placeholder refuses the
  export (exit 2) naming the file, line, spec and step.
- Export: `transform` is a hard skip; a precondition counts as documentary
  only when it is a single plain `echo`; outcome splices are exported only
  where `cairn run` splices them (step fields, script `fixtures`,
  `httpJson.url`), elsewhere they stay literal with a `literalSplice` risk;
  downloads save under the test's output directory; generated files import
  only what they use and compile under `strict` + `noUnusedLocals`.
- Each `--after` hook execution writes its own journal log,
  `logs/hook-after-NN-<runId>.log`. A long run id is shortened in the middle,
  never losing its timestamp or random suffix, and a log file is never shared,
  so `--parallel` runs never interleave or lose output.
- **The retention archive is gated and lossy.** `archiveToStash` archives
  pruned runs through the evidence gate (`stash.include`) with `stash.ttl`,
  so traces, videos and downloads of a pruned run are deleted with it unless
  `stash.include` lists them; the CLI says so once per process. Archive and
  publish outcomes are recorded on the pruning run (`artifact.stash` with
  action `archive`, `artifact.publish`, `artifact.retention` warning and
  summary events), and the CLI prints one line per failure instead of
  swallowing it. `cairn publish` and `retention.publish` never send traces.
- agent-browser traces are named `traces/agent-browser-trace.json`
  (Chrome trace-event JSON). `agent_context.md` points them to Perfetto and
  suggests `playwright show-trace` only for Playwright zips; older `.zip`
  names are still read.
- `services.stash` is deprecated (`cairn config validate` reports it in a
  new `warnings` field, and the services stop prints a deprecation line);
  use `services.artifacts`. Until removal it honors `autoStash` (`enabled:
  true` without it keeps stashing after every invocation), redacts captures,
  captures reused tmux sessions and seed output, and passes `ttl` (default
  7d).
- `cairn audit`'s retention adapters are the gated ones `cairn run` uses
  (archive with `stash.include` / `ttl` / `meta`, publish with
  `retention.publish.include`).
- Each discovery session gets its own agent-browser daemon; previously every
  session of one MCP server shared one page.
- `cairn run <dir>` skips `_` folders as well as `_` files, so specs under
  folders like `flows/_drafts/` or `flows/_smoke/` no longer run in
  directory runs or CI unless named directly. `--select-only` lists them
  under `skipped` (reason `draft`), a run logs how many it skipped, and a
  directory holding only drafts is an error.
- While a `cairn services up` lock is held, `cairn run` (and `cairn audit`)
  for that environment refuses with exit 4 unless it passes
  `--reuse-services`, and runs of every other environment of the config
  refuse too (they share its compose project and tmux session). The refusal
  comes before any hook, service, webServer or browser starts and says
  "stale" when the stack behind the lock is down; `--services-dry-run`
  prints the lock state instead. `services up` / `down` for another
  environment of a locked config exit 4. `cairn audit` now starts services
  before the webServer, like `run`.
- `cairn services status` reports the environment's effective services, with
  per-environment overrides applied.
- Exported specs double-quote every string that holds a `${…}`, so a value
  like `${vars.price}` stays a string after substitution.
- A plain `${secrets.X}` / `${env.X}` / `${vars.X}` under a sensitive key is
  no longer redacted in artifacts: it names a value without holding it.
  Literals and `${X:-default}` fallbacks are still redacted.
- Spec lint's `literal-secret` rule and the catalog share one sensitive-name
  check, so names such as `tokenizerModel` or `samlAssertion` are flagged
  too; a literal typed into a field whose name only sounds like a credential
  is a warning, while known secret values and credential vars stay errors.
- The `27-api-session` example reads its demo password from
  `${env.CAIRN_DEMO_PASSWORD:-cairn-demo-2026}`.
- **URL readiness needs a 2xx/3xx answer.** `webServer.url`, tmux
  `readyOn.url` and the `baseUrl` fallback of the webServer used to accept
  any HTTP answer, so a server still answering 503 counted as ready. They now
  need 2xx/3xx; `anyResponse: true` restores the old rule. When one status
  the old rule accepted persists for 10s, cairn warns once per URL, and a
  readiness timeout names the last status and the `anyResponse` fix. The
  port-conflict check still treats any answer as "something is listening".
  This can turn a previously green readiness wait into a timeout.
- `package.json` gains an `exports` map (`./verifier`, `./package.json`):
  the SDK entry is the only public import, and deep imports into the
  package's `src/` no longer resolve. The `cairn` binary is unchanged.
- A spec's own `vars:` values resolve `${env.X}` / `${env.X:-default}` like
  config vars, before they are spliced as `${vars.X}`. Before, the
  placeholder reached the step as literal text (the `27-api-session` example
  sent `${env.CAIRN_DEMO_PASSWORD:-…}` as its password).
- Data-verifier matcher operands (`value` `expect`, `http` `expect.json`,
  `mongo` `expect.fields` / `count`) resolve runtime references such as
  `${fixtures.<name>.<key>}` or `${captures.<name>…}` instead of comparing
  the placeholder text.
- Fixture `exec` verbs run in their own process group through the same
  bounded runner as `run:` steps: a verb settles when its command exits even
  when a background process it started keeps stdout open, and the group is
  killed at the deadline, on cancel and when cairn exits.
- The `22-product-create` example deletes the product it created in a spec
  `teardown:`, so `21-product-catalog`'s exact count holds across runs.
- Discovery sessions limit each screenshot to 45s (above the agent-browser
  adapter's worst case of about 37s).

### Fixed

- **The SIGINT/SIGTERM teardown no longer races the services boot or
  itself.** It used to start the teardown at once, while a boot command
  that was still cancelling (a provisioner's `up` holding its state lock)
  kept running. Now it waits up to `CAIRN_SERVICES_SIGNAL_GRACE_MS`
  (default 5000) for that process tree to exit, without sending a second
  signal that would force a graceful cancel. Then it runs the teardown. The
  teardown skips commands the normal teardown already ran. For the one the
  normal teardown is running it waits (up to the per-command cap) instead
  of starting a second copy while that one is alive, since two copies of a
  provisioner's `down` race for its state lock; one that is gone runs
  again. Every teardown command (normal, failure cleanup, signal path)
  runs detached (own process group and session, output in a private temp
  file), so a terminal Ctrl-C, Studio Stop (SIGTERM, then SIGKILL to the
  group) or a harness's group SIGTERM no longer kills a provisioner's
  `down` halfway and leaves billable compute up. It runs with the scoped
  environment the normal teardown uses instead of the bare process
  environment. The per-command cap is configurable with
  `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` (default 10000).
- A Playwright `download` step whose click fails no longer crashes the
  process with an unhandled rejection (exit 1) after the result was printed.
- `cairn explain --json` reports this installation's `bin/cairn` as
  `cairntrace.binary` instead of a hardcoded `/usr/local/bin/cairn`.
- An invalid `when:` gate writes a `step.failed` event.
- The verify reference audit honors environment-level `secrets.required`.
- `${config.dir}` in `cairntrace.config.yml` is filled in after the YAML
  parse, so directory names containing `#`, `:`, quotes or backslashes no
  longer break the config.
- `cairn explain` describes `--after` as running after each spec with
  `CAIRN_RUN_*`, lists every flag the CLI registers (including `--repeat`,
  `--matrix`, `--stop-on-fail`, `--hook-timeout-ms`, `--progress`,
  `--provider`, `--device` and `export playwright --check`), and documents
  exit code 4 for `run` and `spec heal`. `docs/verifiers.md` no longer claims
  outcomes can be pinned to steps.
- Exported projects: request-step responses use a reserved local (no
  shadowing of a `requests` binding), no unused splice bindings or `expect`
  imports, no `absolutePath` false positives on URL routes, and action header
  comments use project-relative paths.
- Invocation journals written by newer versions stay readable, an unreadable
  journal is never pruned, and `cairn logs --follow --invocation` settles on
  it.
- The journal redactor is rebuilt only when the registered secrets change,
  not once per log line.
- The `28-form-controls` example clicks the listbox option with a
  backend-neutral selector, so it passes on `--backend playwright` and in the
  exported Playwright suite (CI no longer excludes it).
- Discovery redaction picks up `redaction.values` registered after the
  session started (the redactor was built once at open), and the setup
  spec's `redaction` block.
- `cairn explain` lists every `cairn discover` flag (`--use`, `--import`,
  `--from-spec`, `--until-step`, `--resume`, `--snapshot-mode`,
  `--max-bytes`) and the new authoring, catalog and services commands, so
  the explain ↔ CLI parity test covers them.
- The MCP docs list every tool (62), the `author-flow` prompt and the
  `cairn://catalog` resource, and no longer describe discovery sessions as
  nine tools that expire after 5 minutes.
- An agent-browser screenshot that hits its 15s deadline (display asleep or
  locked) no longer kills the browser at once. Only the capture command is
  stopped; the session daemon then gets up to 20s to finish it: a capture
  that lands late counts as a real screenshot, and when none lands
  screenshots are turned off for the rest of the session (a warning and a
  missing-artifact note) while the session keeps going. Only when the capture
  still blocks the daemon after that is the session stopped and marked
  wedged; later commands are then refused at once with an error naming the
  screenshot, instead of running on a blank respawned browser. Only a real
  interaction, wait or query that hits its deadline otherwise marks a
  session wedged.
- Discovery sessions stop taking screenshots after the first timeout, write
  a `screenshots.disabled` journal event (`index`, `reason`) and return a
  `warnings` entry on that action's result (also in the MCP text); the
  warning says when the backend had to drop the browser, so the page state
  is gone and the session must be reopened.
- `cairn run --format json|yaml` prints a schema-valid errored `RunResult` /
  `BatchRunResult` (`failure.phase: "invocation"`) when a `cairn services up`
  lock refuses the run (exit 4) or the services or webServer boot fails (exit
  2): the message is redacted, policy-refused specs keep their refused
  result, `--junit` is written (the JUnit case now names the reason instead
  of "run errored") and MCP `cairn_run` returns the same document.
- Readiness-gate hooks reach the run engine: services and webServer `ready`
  gates resolve against the resolved config's `gates:` (a `--config` file
  not named `cairntrace.config.yml` included), their `gate.*` events land in
  the invocation journal, the webServer's gate waits stop on cancel, and
  readiness warnings go through the warn level so non-interactive runs show
  them.
- Exports: steps the exporter always skips (`expect.request`, `capture`,
  `run`) no longer declare a `${requests.*}` binding nothing reads, which
  failed `tsc --noUnusedLocals` on the exported project; a `run:` step is
  reported with its own reason instead of "unhandled step shape" (and without
  its command text).

### Security

- Precondition commands, `--before`/`--after` hooks, docker/seed/tmux
  commands (including signal-time teardown) and the webServer's shell
  commands no longer inherit
  `FILECHEAP_INGEST_TOKEN` or TinyVault client credentials from the parent
  environment (their child processes no longer re-merge `process.env`).
  Those values are also scrubbed from artifacts as a backstop. The same
  filter drops `CAIRN_TVAULT_ENV` and non-secret `TVAULT_*` variables; see
  Changed for the migration.
- Live logs redact every line of a multi-line secret (PEM keys, JSON service
  accounts), and over-long lines are redacted before they are cut.
- A spec's `redaction` block applies to the invocation journal from its first
  line, including services output and `--before` hooks; hook commands, hook
  failures and services lifecycle lines are redacted in stderr narration
  (including `--log-format json`).
- Discovery never writes a resolved secret into an exported spec, and URLs
  returned or printed by discovery and snapshot are redacted (secret values,
  token-like query parameters, userinfo).
- fcheap child processes (`list`, `save`, capability probes, doctor's
  `auth status`) no longer inherit `FILECHEAP_INGEST_TOKEN` or TinyVault
  controls; only `fcheap publish` receives the publisher token.
- Tests can no longer write to a real file.cheap vault: a vitest guard
  (`src/testing/fcheapTestGuard.ts`, loaded from `vitest.setup.ts`) fails
  any test that runs a mutating real `fcheap` command outside a temp
  `--stash-dir` (read-only commands are allowlisted; a preset `FCHEAP_BIN`
  and flags before the subcommand are covered).
- `http` datasources send their `baseUrl`, `headers` and `auth` only to
  `baseUrl`'s origin: an absolute URL on another origin (written or spliced
  from `${captures.*}`) fails at once, and redirects are followed by hand
  (at most 5): a cross-origin hop drops the credentials and never re-sends a
  request body. The SDK datasource channel goes through the same check.
- A `capture` whose `assign` name marks a credential (`apiToken`,
  `csrfToken`, …) registers its string values as secrets before any evidence
  is written, so `captures/<name>.json` and every later artifact redact them.
- MCP `cairn_run` lifecycle failures (services lock, services or webServer
  boot) return a redacted error text, not only a redacted document.
- Fixture ledger records, `fixture.*` events and `cairn fixtures` / MCP
  documents go through the key-aware redactor, values under sensitive keys
  are registered as secrets, and the run redactor picks up secrets
  registered during setup and teardown.

### Studio

- One shared event describer follows the runner's vocabulary (failed steps
  with their error, `when:` skips, preconditions, outcome and run end states)
  and every `events.v1` addition (phases, heartbeats, progress, announced
  logs, hooks, invocations); unknown events render as `type · key=value`.
- Live repaints incrementally with auto-follow and "jump to latest", and
  shows phase banners with budgets, `i/N` step rows with inline errors,
  outcome progress, the latest screenshot, log tabs, stash/retention badges
  and runs grouped by invocation with an ETA.
- Liveness uses the heartbeat first, then the pid from the heartbeat or
  `invocation.json`, then file timestamps. Finished external runs keep being
  read while their process is alive (up to 10 minutes), so a slow auto-stash
  still shows.
- Runs lists only real run folders, with a labels column, label filters and
  search, and grouping by invocation; Cohorts suggests label keys.
- Spec discovery skips artifact roots, run output and copied specs (but keeps
  authored specs in feature folders named `exports`/`reports`/`runs`) and no
  longer blocks the app.
- Run detail opens failed runs on a Failure panel (failing step, diagnostics,
  expected/actual from the outcome evidence, failed precondition or hook
  output, services evidence) and adds Preconditions, Hooks, Services, Video &
  trace and Logs tabs, streamed video, trace opening and a per-spec history
  strip. Hooks come from the run's invocation journal, where the runner
  writes them: the run's own `--after` hooks and the `--before` hooks of its
  iteration, with their logs.
- Live names each parallel `--after` hook by its run, and a finished hook
  updates its own run's row.
- Heal passes the environment and `--var` values from the run settings, like
  Run does.
- Prune sends `cairn clean --keep N`; it sent `--keep-runs`, which the CLI
  rejects, so every prune with a count failed (also in 2.15.0). A test now
  checks every flag Studio sends against the real `--help`.
- New Stashes view with restore-and-open; runs show stash badges, and partial
  stashes show as a warning. Report, reveal and evidence links work for
  restored stashes.
- Per-project launch templates (run without a shell, `{specs}` may be
  embedded) and suite lock files that block Run and heal with no override.
- The main process no longer trusts renderer arguments: project folders must
  be known, settings changes are validated, binary, artifact-root,
  launch-template and held-lock changes ask in a native dialog, spec writes
  are YAML-only inside the project, and file reads are limited to the
  project, the artifact root, stash restores and explicitly picked files.
- The topbar shows the cairn version and warns when the PATH binary and the
  repo's `bin/cairn` differ. A relative `artifactRoot` resolves against the
  project like the CLI, the config is read like the CLI (`${env.X}`, merge
  keys, `${config.dir}`), object-form `when:` renders as text, and the
  density, screenshot-width and refresh-on-finish settings take effect.
- New Invocations view: every `cairn run` / MCP invocation with its origin
  (CLI or MCP agent and client), planned specs and their status, current
  phase, liveness, and live tails of the narration, services and hook logs.
  Live groups cards by invocation.
- **Stop** asks for confirmation and only signals a process whose command
  line is verified to be the cairn invocation that wrote the journal. When
  cairn leads its own process group it signals the whole group, like Ctrl-C,
  so running hooks stop too; otherwise it signals the pid and says hook
  subprocesses may outlive it.
- The renderer is now typechecked (`checkJs` + JSDoc, with a typed
  declaration of the shared Studio globals), and the main views have DOM
  tests (happy-dom).
- Leaving a view while it loads no longer leaks its pollers or lets a late
  render paint over the current view; phase banners keep the elapsed/budget
  and "no heartbeat" text visible; keyboard focus, aria labels and empty
  states were improved.
- Stash state from `artifact.stash` and `stash-receipt.json`: status, reason
  code and its meaning, members left out (with the `stash.include` hint),
  secret findings, TTL/expiry, tags and file count/size/hash, in badges,
  tooltips and a new Run detail **Evidence** panel. The Stashes view links a
  stash to its local run and flags fcheap's `custom.secrets_found`. Stash
  and publish events about runs a retention pass pruned no longer count as
  the current run's.
- **Publish to file.cheap** in Run detail: a native confirmation states the
  retention days, then Studio runs `cairn publish <runDir> --json` and shows
  the receipt (artifact ref, expiry, members left out, and "not listed in the
  console" with the `runIndexSkipped` reason) or the failure reason. The
  button reads **Publishing…** while it runs and main refuses a second
  concurrent publish. A failed re-publish newer than the receipt shows as the
  failure, an expired package as "publish expired" with nothing to open.
  **Open in file.cheap** opens only the https URL in the run's own receipt,
  under the CLI's rule (no query string or fragment), and names any other
  host.
- **Pin / Unpin** in Run detail (`cairn pin <runDir> [--reason=…] --json`,
  `cairn unpin`), a pin badge in Runs, and prune dialogs that say pinned
  runs are kept and, when `archiveToStash` / `retention.publish` is on,
  name the upload and confirm it natively.
- What leaves the machine: the Evidence panel counts the manifest's files by
  `sensitivity` (`redacted`, `safe`, `sanitized`, `secret-bearing`) and
  names the ones never published; the Video & trace tab and the file list
  tag sanitized and secret-bearing files with their meaning. `artifact.trace`
  events read as trace saved (format, sensitivity), dropped (over
  `traceMaxBytes`) or failed (reason).
- Refused specs (exit 7, `run.refused`, `refusal`) have their own style in
  Live, Invocations and their plan entries, with a refusal box instead of a
  failure; an invocation whose specs were all refused reads "refused", not
  red "failed", and counts them as settled. Studio never adopts the run id
  of a refused or `synthetic` document and offers no "Open evidence" /
  "Open run" for one.
- Environment policy: the Environment view lists each environment's trait,
  mutations and description, and each checkpoint's env, baseUrl, created,
  expiry and health. The Specs view shows `requires`, adds a "run on"
  environment picker (also used by ⌘R and Re-run), and warns before Run when
  the policy would refuse the spec; saving refreshes the warning. Opt-in
  checks match the CLI (`1`/`true` in any case, the project's dotenv files
  read the way Bun loads them) and only booleans reach the renderer.
- New **Sessions** view follows discovery and accompany journals
  (`<artifactRoot>/_sessions/`, read where the CLI and MCP write them even
  when Studio's artifact-root override is set): liveness from pid, last
  activity and TTL; an action timeline with URL changes and network
  mutations; the latest screenshot with thumbnails; the a11y snapshot and
  network log per action; recorded steps; a draft diff per
  `draft.updated`; and exports with their verify findings (a moved export
  reads "moved").
- **Export draft** re-exports a session with the intent and outcomes of the
  agent's earlier export, asks natively before rewriting an existing file,
  and is disabled until the agent has exported.
- **Promote…** shows the intent and every outcome with its `verify:`
  parameters in a native dialog and promotes only the text it showed: the
  draft is re-read after the click, and the CLI gets that text's hash as
  `--expect-content-hash`, so a draft rewritten meanwhile is refused. Only
  drafts that pass cairn's draft rule are offered; a refusal shows the CLI's
  message in full, `--force` is offered only for a missing or stale green
  finish, and the CLI's warnings are shown.
- New **Catalog** view over `cairn catalog --json`: search (`--query`), an
  environment picker (reset when the project lacks it), tabs per kind,
  reveal files, open flows in Specs and last runs in Run detail, and copy
  `use:` / `${vars.…}` snippets; masked vars stay masked.
- The Environment view shows each environment's `services up` lock (owner,
  pid, age, stale) with **Services up / Services down** buttons, confirmed
  natively, re-checked against the suite lock after the dialog, and refused
  while a run or heal started from Studio uses that environment; Run and
  Heal are refused on an environment while `services up|down` runs for it.
- Spec discovery skips `_sessions/`, so a session's `draft.spec.yml` is
  never listed as a spec; the Docs view lists the `catalog` and
  `author-flow` topics. Only commander's own "unknown command/option"
  errors read as an outdated cairn.
- Run detail renders the new evidence: data, `value`, `http`, `table` and
  `network` verifier evidence as bounded tables (the source named by its
  descriptor, truncation notes saying whether the runner or Studio cut the
  table), poll attempt timelines with the dropped-attempt gap, attempts and
  poll time in the outcome summary; `expect` verdicts and `capture` values in
  Steps and Outcomes (with a failed-expect Failure panel); `run` steps with
  kind, label and output tail.
- New Run detail tabs Teardown, Gates and Fixtures (each only when the run
  has them), a gate Failure panel for a `wait <gate>` error, a teardown panel
  that says whether the failure changed the verdict, and badges "teardown N
  failed" and "fixtures dry-run · N".
- Live shows the waiting gate (last probe answer, attempt count) and
  `teardown i/N` in the phase banner, gate rows, fixtures and teardown
  sections, expect verdicts inline and the poll position (`attempt 4/~31`);
  the Invocations detail lists the journal's `gate.*` and suite/seed
  `fixture.*` events.
- Environment and Catalog show the datasources per environment (kind,
  redacted target, inherited / override / disabled), the gates registry with
  who waits on it, and the fixtures registry with each environment's live
  ledger state, folded the way `cairn fixtures status` folds it (reset-only
  fixtures, released records, run instances). Built from the config parsed
  without env substitution.
- Specs: `poll` is a tag on the outcome, not a verifier; the overview shows
  `teardown`, `fixtures` and `preconditions.wait`; the step kinds `run`,
  `expect`, `capture`, `transform` and `snapshot` are recognized.
- Security: `project:inspect` no longer sends the env-substituted parsed
  config to the renderer, and environment `baseUrl`s arrive redacted. Gate
  commands mask credentials passed as separate words (`--password x`,
  mongosh/mysql/sshpass `-p x`, redis-cli `-a x`), in `Cookie` / `X-Api-Key`
  style headers, quoted JSON credential keys and `user:pass@host`;
  `${env.X:-default}` / `${secrets.X:-default}` defaults are masked; captures
  whose name marks a credential and evidence cells or fixture outputs under
  secret keys (at any depth) show `••••••`, while keys that only describe a
  credential (`tokenCount`, `cookieConsent`) stay visible. Masking of gate
  commands is pattern-based: a password passed as a bare positional argument
  still shows.

## [2.15.0] - 2026-10-01

### Added

- `cairn stash save --labels-as-tags` tags the stash with every
  `cairn run --label key=value` from run.json (e.g. `round=…`, `sha=…`,
  `target=…`), so benchmark cohorts can be listed back from file.cheap.
  `--ttl <duration>` passes a file.cheap time-to-live. The MCP
  `cairn_stash_save` tool accepts `labelsAsTags` and `ttl`.
- `cairn stash list --tag` is repeatable; file.cheap requires every tag (AND).

## [2.14.0] - 2026-10-01

### Added

- `cairn run --repeat N` and `--matrix key=a,b[;key2=x,y]` run the spec set
  repeatedly / over a cartesian grid in one invocation. Each run gets its own
  run dir and labels (`repeat=<i>`, `key=value`), matrix values are exported
  as `CAIRN_MATRIX_<KEY>` env vars, `--before` hooks run per run,
  `--stop-on-fail` halts at the first failing run, and a summary prints to
  stderr. Auto-prune keeps at least one run per iteration.
- `cairn stats --metric <name>` also reads numeric top-level fields of
  `<runDir>/diagnostics/report.json` (wins over outcome sidecars).

### Changed

- **`--after` hooks now run after each spec** (pass or fail) with
  `CAIRN_RUN_DIR`/`CAIRN_RUN_ID`/`CAIRN_RUN_STATUS`/`CAIRN_SPEC_PATH` set,
  instead of once after all specs. Single-spec invocations behave as before
  apart from the new env vars. `--hook-timeout-ms` still applies.

## [2.13.1] - 2026-09-29

Ships the 2.13.0 features to npm. The v2.13.0 tag and GitHub release exist,
but its npm publish was rejected by the `audit:production` gate (the advisories
below landed after 2.12.2 shipped), so 2.13.0 was never published to npm — use
2.13.1.

### Security

- Bump the `ip-address` override to 10.7.2 (moderate SSRF advisories
  GHSA-rpw4-54j3-4h4q and GHSA-2vr4-cq9g-pvrc). `express-rate-limit` already
  allows `^10.2.0`, so only the pinned override moves.

## [2.13.0] - 2026-09-29

### Added

- Studio detects runs started outside the app — from a terminal or by an
  agent — and streams them in **Live**. An artifact-root watcher polls for run
  directories without `run.json` (the runner writes it last, so its absence
  means the run is still executing), tails each one's `events.ndjson` from a
  per-run offset, and settles the run when its record lands. Detected runs get
  the same step timeline, event stream, finish toasts and evidence links as
  app-started runs; the nav badge and the topbar pill count them.

### Changed

- Runs history no longer calls a run-less directory written in the last five
  minutes "interrupted": it renders as "running" (filterable, pulsing dot),
  and the run detail of such a run offers "Watch in Live".

### Fixed

- App-owned runs are not reported twice: they leave the detected set as soon
  as the app's own tail claims their directory. Hide on a detected card sticks
  for the session, a dropped run that comes back resumes from its previous
  read offset, a torn `run.json` is retried on the next tick instead of
  reporting "unknown", and the watcher starts only after the window has
  loaded, so no event is consumed before the renderer can receive it.

## [2.12.2] - 2026-09-28

### Fixed

- The docker phase's `readinessCheck` is now polled (1s cadence) until the
  phase deadline (`readyTimeoutMs`, 0 = indefinite) instead of running once.
  A single attempt raced container startup: `pg_isready` executed 140ms after
  `Container … Started` and killed the run on every fresh machine, CI
  included. The failure message now reports how many attempts were made.

## [2.12.1] - 2026-09-28

### Fixed

- `cairn run` now starts the `services` environment (docker/seed/tmux)
  **before** the `webServer`. The demo platform (and any app server that
  connects to its database at boot) crashed on fresh machines — CI runners
  included — because the web server spawned while Postgres was still
  nonexistent; teardown now stops the web server before services.
- Studio launched from the Dock/Finder (minimal GUI `$PATH`) could not see Go
  tools: `~/go/bin` and `/usr/local/go/bin` are now part of the augmented PATH
  every spawned command inherits, so `cairn doctor` inside Studio reports
  `codemap` (and friends) instead of failing the check. The extra dirs are
  computed per call and covered by a regression test with a fake `$HOME`.

## [2.12.0] - 2026-09-28

### Added

- **Cairntrace Studio** (`desktop/`), an Electron desktop console over the CLI
  and its artifacts: run history with status/spec/text filters; per-run
  evidence (step timeline with resolved locators and artifacts, outcome
  markdown, screenshots, console/network captures, `agent_context.md`,
  `report.html`, and `cairn diff` against any other run); a spec editor whose
  save runs `cairn spec verify` and surfaces its findings (including
  contract-hash refusals and the cold-start contract status); live step
  progress tailed from the run's own `events.ndjson` with cancel and re-run;
  `cairn stats --group-by` cohorts with baseline deltas; and the step/verifier
  reference read live from `cairn docs` / `cairn explain`. Studio spawns the
  same `cairn` binary an agent would use, keeps the renderer sandboxed behind a
  channel-allowlist preload, and kills spawned children as a process group so
  cancels and deadlines cannot orphan browsers or docker. Ships with a
  node:test suite, `tsc --checkJs` over the main-process surface, and a
  `--smoke` boot harness (`bun run desktop:smoke`); CI runs the tests and
  typecheck. See `desktop/README.md`.
- Root scripts `desktop:install|start|smoke|test|typecheck|dist`, and a CI job
  that tests and typechecks the desktop core without downloading Electron.

### Fixed

- Playwright `wait: { text }` / `wait: { notText }` now poll rendered body text
  from the host instead of `page.waitForFunction`, whose in-page re-evaluation
  a strict Content-Security-Policy can refuse on later animation frames; waits
  on `script-src 'none'` pages no longer die mid-poll. Generated Playwright
  suites inherit the fix via `expect.poll(...)`, and a hard deadline now closes
  the browser even when no process-based watchdog was available.
- Studio's `--smoke` boot harness reads flags from `argv[1..]`, so packaged
  builds (whose argv lacks the dev-mode `electron .` prefix) boot-test instead
  of opening a window and idling.
- `upload` steps now resolve bare relative `path:` values against the spec's
  directory (matching `transform.file` / `eval.file` / script-verifier
  `file:`), so uploading a repo fixture no longer depends on the process cwd.
  Absolute paths and `${artifacts.*}` placeholders are unchanged.
- The `file` verifier resolves `${artifacts.<name>.path}` placeholders the
  same way the `xlsx` verifier does, so a downloaded artifact can be polled
  by reference instead of a spec-relative glob.

### Changed

- The examples suite is now a real demo platform backed by Postgres:
  `examples/docker-compose.yaml` (db on :5433), Drizzle schema + journal
  migrations + deterministic seed (`examples/demo-app/db/`), login/documents/
  products/exports pages and JSON APIs on the same :8787 server, and sample
  fixtures (PDFs, generated product photos) under `examples/fixtures/`.
  `examples/cairntrace.config.yml` now drives the whole lifecycle through
  `webServer` + `services.docker` + `services.seed` (data-level freshness
  check), so a plain `cairn run examples/flows` brings up and seeds the
  platform itself.
- New platform spec suite `examples/flows/platform/` (login journey, catalog
  + filters, form create, duplicate-SKU rejection, PDF upload/download with
  a Node magic-byte verifier, image upload with preview, CSV/XLSX export
  downloads, API login + session via `request`/`httpJson`, focus combobox +
  Enter-committed search, guest redirect), with reusable
  `login_demo_app` / `create_product` actions.
- The intentional-failure demos moved to `examples/flows/demos/` with `_`
  prefixes so a directory run of `examples/flows` is green; run them by
  explicit path for the failure/heal walkthroughs.

## [2.11.1] - 2026-08-14

### Fixed

- MCP / GUI-launched `cairn mcp` now points TinyVault at
  `~/.config/secrets/env` (`TVAULT_PASSPHRASE_FILE`) when the process
  inherited no unlock credentials. Accompany and `cairn_run` against
  `secrets.provider: tvault` no longer fail locked after the local agent
  idle-exits.

## [2.11.0] - 2026-08-14

### Added

- `cairn export brief` (MCP `cairn_export_brief`) compiles a spec into an
  agent-neutral journey brief (`urn:cairntrace.dev:brief:v1`): operator
  goals, locator approximations, setup/cold-start, and redacted secrets.
  `--from-run latest` attaches `StepResult.resolved` from the last passed
  run of that spec.
- MCP `cairn_accompany_open` / `_choose` / `_status` / `_list` / `_close`
  run a spec with try-then-ask: authored locators first; on miss the
  harness picks WHERE and Cairntrace retries the authored value.
- Locator-miss `cairn run` failures attach `failure.brief` and suggest
  `cairn export brief`. `agent_context.md` renders the parked step.
- Docs topic `brief` and site page [Journey briefs](https://cairntrace.dev/brief).

## [2.10.1] - 2026-08-14

### Added

- Tag pushes bump `Formula/cairntrace.rb` in `abdul-hamid-achik/homebrew-tap`
  (`.github/workflows/homebrew-tap.yml`). Install with
  `brew install abdul-hamid-achik/tap/cairntrace` or
  `npm install -g @thelacanians/cairntrace`.

## [2.10.0] - 2026-08-14

### Added

- Playwright `--project` export emits parameterized action helpers
  (`fn(page, vars?)`) for declared `action.vars`, and extracts shared
  runtime into `lib/` (network evidence, fill/type retry, `click.until`,
  verifier loader). Call-site `use: { action, vars }` is a function call,
  not an inlined expansion.
- `cairn export playwright --into <dir>` writes actions/lib/tests/verifiers
  into an existing Playwright tree without overwriting host config.
  MCP `cairn_export_playwright` now accepts `project`, `into`, `config`,
  `env`, and `var`.
- Project tests keep source folders, wrap steps/outcomes in `test.step`,
  honor `metadata.feature` / `metadata.tags`, skip `echo` preconditions,
  relocate precondition cwd via `CAIRN_PROJECT_ROOT`, and stamp
  `viewport` / `testIdAttribute` / screenshot / trace from config+specs.
- `eval.file` is copied into `evals/` and embedded; `when:` object form
  (`selector`/`hasText`/`notSelector`) and locator `visible` export;
  skipped real interactions mark the generated test `test.fixme`.
- `type.delayMs` now maps to agent-browser `type --delay` (both backends).
- `cairn run` starts agent-browser sessions with `--idle-timeout 0` so a
  long script outcome cannot idle-kill the daemon.
- `cairn doctor` fails `agent-browser` when the CLI is older than 0.34.0.
- `use:` object form `{ action, vars }` so one reusable action can be
  invoked twice with different values. String `use: login_admin` is
  unchanged. Precedence: action defaults < config < spec < CLI < use-site.
- `when:` object form, including `selector` + `hasText` (same visible-node
  predicate as `wait.selector`).
- Locator `visible: false` opt-out. `role: option` (and `visible: true`)
  drop hidden a11y-tree matches via `is visible`.
- `postcondition.network.assign` captures the matched request as
  `${requests.<name>.…}` / `requests/<name>.json`.

### Fixed

- Console outcomes reuse the pre-outcome `getErrors()` snapshot. A second
  daemon read after a long script verifier no longer hangs, and a wedged
  backend no longer greens `console.errorsMax: 0`.
- `cairn spec verify --stamp` rewrites only the `contractHash` line, so
  quoted `#element_…` selectors and `"${vars.X}"` stay quoted.

## [2.9.0] - 2026-08-13

### Added

- `eval` args `filePath` / `fixtureFiles` — host files are read and
  injected as `bytesBase64` / `fixtureBytes` so a page can build a
  readable `File` without copying into the app `public/` directory.
- `when: selector:<css>` / `when: notSelector:<css>` — skip a step based
  on a live `querySelector`, not body text (invite card concat made
  `when: text:Connect as Supplier` fire with no `<button>`).
- `wait.selector` + `hasText` — poll until a visible node matching the
  selector contains that text. Prefer this over `wait.text` when the same
  copy also lives in a card accessible-name concat or invite header before
  the actual `<button>` exists.
- Locator `nth` on `by: selector` (0-based `querySelectorAll` document
  order). Semantic locators already had it; CSS cannot express "the second
  `[data-testid^=…]`" without this.
- Locator `hasText` — keep only matches whose visible text contains the
  string. On selector locators the agent-browser adapter also drops hidden
  nodes, so a Vue radio / vue-multiselect option can be authored without
  eval.
- `press.target` — focus a locator before sending the key so SPA
  `@keyup.enter` on an input fires. `press.until` already retries the key.
- `wait.ms` — pause with no predicate (e.g. wait for a search index after
  create) so a later type+Enter search is not forced to cheat via API.

### Fixed

- agent-browser `by: selector` + `hasText`/`nth` pin now polls until
  `locatorTimeoutMs` instead of failing on the first empty frame (invite
  fade / drawer slide).

### Security

- Pin the production `nanoid` override to `3.3.18` (GHSA-2v37-7h3g-55p8).

## [2.8.1] - 2026-08-12

### Fixed

- agent-browser `wait.selector` `state: hidden|detached` now polls a `--fn`
  DOM predicate. agent-browser 0.34 treats `--state` as an auth-state file
  path, so `--state hidden` failed with `Failed to read state from hidden`.
- agent-browser `click: { by: text }` and locators with `near:` read the
  full accessibility snapshot (not `-i`, which drops `StaticText`). A
  text match with no `@ref` is promoted to the nearest ancestor that has
  one, so a task-row title and a dialog "Delete" next to confirm copy
  resolve.
- Semantic names accept a trailing count badge (`Tasks` matches
  `Tasks 11`) on both backends. This is not substring matching: `Pay`
  still does not match `Pay for plan`.

## [2.8.0] - 2026-08-12

Authoring primitives for user-like flows, plus the unpublished work already on
`main` since 2.7.1 (Ink TUI, portable Playwright export, network
postconditions, service process profiles, npm Trusted Publisher).

### Added

- `wait.url` — poll the current page URL with exactly one of `includes`,
  `equals`, or `pattern` (JS regex). Cross-backend, same as `wait.value`.
  Use this after a click that navigates instead of an `eval` on
  `location.pathname`.
- `by: testid` — first-class locator. `browser.testIdAttribute` (default
  `data-testid`) is the attribute Playwright `getByTestId` and agent-browser
  selectors read. Inventory emits `{ by: testid, testid: … }`.
- Locator `near: <text>` — keep the control nearest that visible copy (the
  Open button in the Acme Corp card, not the other Opens on the page).
  Snapshot backends score shared ancestors; Playwright scopes to the
  innermost ancestor of the text that still contains the target.
- Reusable action `vars:` defaults for `${vars.X}`. Precedence: action
  defaults < config env vars < spec `vars:` < CLI `--var`.
- Ink TUI for run / services / batch narration.
- Portable Playwright export and typed `postcondition.network` on browser
  mutations.
- Process profiles captured from declared services.

### Changed

- TUI/output polish: live elapsed, phase durations, seed heartbeats, stash
  narration, failure-cleanup rows.

### Fixed

- Node verifiers and transforms no longer pass
  `--experimental-transform-types` on Node 26+, where the flag was removed
  (type stripping is the default). Node 22.6–25 still get the flag.
- npm Trusted Publisher publish uses Node 24 (npm 11+) and no longer injects
  an empty `NODE_AUTH_TOKEN`. `package.json` now has a `repository` URL so
  OIDC can match the GitHub repo.

### Security

- Pin `fast-uri` 3.1.5, `hono` 4.12.34, `ip-address` 10.3.1, and `nanoid`
  3.3.17 so `bun audit --production` is clean on the release tag.

## [2.7.1] - 2026-07-31

### Changed

- Seed command output moved from the live stream to the detail channel
  (DEBUG, shown with `--verbose`). Default runs show only the seed milestones
  and the elapsed ticker; `--verbose` shows the redacted stream (dim in the
  tty narrator). The full output stays in the run's service-log artifact, and
  a failing seed still surfaces its tail through the error. Docker live
  streaming is unchanged.

## [2.7.0] - 2026-07-31

### Added

- `cairn spec verify` audits placeholder references statically: an
  `${env.X}` without a `:-default` that no source supplies (process env,
  config `secrets.required`, or the `CAIRN_*` namespace), or a `${secrets.X}`
  missing from `secrets.required`, fails verify with exit 4 instead of
  substituting an empty string mid-run. Imported actions are audited too.
- Interactive services lifecycle narration under `--format md --progress
  tty`: docker/seed/tmux/teardown milestones render as clack marks with a live
  ticker, raw subprocess output streams untouched, and every non-TTY mode
  keeps the leveled logger narration.

### Changed

- The docker phase's `compose up` status lines (Creating/Created/Starting/
  Started) are collapsed in interactive narration: buffered while the command
  runs and cleared when the phase settles (ready/reused/failed). A failing
  phase still surfaces its output tail through the error, the full output
  stays in the run's service-log artifact, and the elapsed ticker keeps
  running during slow pulls. Non-TTY modes stream as before.

### Security

- The artifact redactor scrubs URI userinfo (`scheme://user:pass@host`) by
  pattern, closing a leak where seed child output embedded connection URIs
  whose credentials were not registered literals.

## [2.6.2] - 2026-07-31

### Changed

- `cairn run` TTY narration now renders through `@clack/prompts`: docker-style
  flat marks (◆/■/▲/◇) for steps, preconditions, and outcomes, guide bars
  around the run header, and the closing summary box (`└  PASSED n/m …`).
  Output stays pinned to stderr (clack defaults to stdout) so the structured
  `--format` document is untouched; the in-flight animation remains a local
  ticker because clack's `spinner()` grabs stdin (readline + raw mode) and
  intercepts keys (Esc → `process.exit(0)`, Ctrl+C swallowed) — that would
  break signal-time cleanup and interruptibility. Symbols are colored through
  the project palette because Bun's `util.styleText` ignores NO_COLOR, so
  `--no-color` still means zero ANSI. `--progress auto` now follows the
  stderr sink (like docker --progress) instead of stdout, so piping stdout
  to a file keeps the live narration and `2>log` no longer writes cursor
  redraws into the file. `@clack/prompts` is now actually used — removed from
  knip's `ignoreDependencies`.

- The batch narration (`cairn run` with `--parallel > 1`) now uses the same
  clack glyph family (◆/■/▲) for completion lines, so single and batch runs
  speak one visual language.

- Logger/ticker coordination: while the tty renderer's live marker line is in
  flight, every logger write clears the marker line first (`\r` + clear-EOL)
  so `--verbose` or any future mid-step logging lands clean instead of being
  overwritten by the next spinner redraw (the marker redraws below it on the
  next tick).

- `cairn login`'s capture gate is now a clack `confirm` prompt (Enter =
  capture, Esc/Ctrl+C cancels) instead of a bare readline; its narration
  moved from stdout to stderr and renders with the same clack marks as the
  run renderer (ℹ/◆/│), so stdout no longer carries narrative text.

- `cairn spec heal` (and `heal --verify`) now narrate the underlying run(s)
  with the same progress renderer as `cairn run` (auto/CAIRN_PROGRESS, all
  output to stderr) instead of running in silence; the markdown heal report
  stays the only thing on stdout. The stale stdout "Healing …" header is
  gone.

- The tty ticker's spinner frames fall back to ASCII (`| / - \\`) on
  non-unicode terminals (TERM=linux) instead of rendering braille boxes;
  the same `unicode` detection clack uses.

## [2.6.1] - 2026-07-31

The tag's single commit is titled as a logger color migration, but the release
carried a large batch of services, runner, exporter and redaction work. The
entries below are reconstructed from that diff.

### Added

- `services.artifacts`: bounded, redacted service evidence attached to each
  run under `<runDir>/services/` while the services are still alive —
  lifecycle NDJSON, docker/provisioner command transcripts, tmux pane tails
  (reused sessions included), run-window Docker Compose logs, and
  seed/post-command output — described by `services/manifest.json`
  (`run.json` `artifacts.services`). Defaults: `when: on-failure` (`always` |
  `never`), all four sources, 2,000 lines and 512 KiB per source, 8 MiB per
  run. Capture errors are recorded in the manifest and never change the
  verdict. `cairn logs [ref] --services` / `--service <window>` read the
  run-local pack first and fall back to the legacy pane logs under
  `~/.cairntrace/services`.
- `cairn run --hook-timeout-ms <ms>` bounds each `--before`/`--after` hook
  (default 600000, max 7200000); a timeout kills the hook's process tree.
- `eval.retryOnNavigation: true` retries an `eval` step once, inside its
  remaining `timeoutMs`, when a page navigation destroys its execution context.
- `services.tmux.waitForReadyBeforeNext: true` boots windows in declaration
  order and waits for each `readyOn` before starting the next; all windows
  share one `readyTimeoutMs` deadline and a dead pane fails immediately.
- `run.json` `failure` gains `phase`, `name`, `durationMs`, `timedOut` and
  `signal` (e.g. a named precondition that hit its deadline), and a failed
  precondition gets its own `nextActions` entry.
- Playwright network evidence records a numeric epoch `timestamp`, sanitized
  `postData` for valid JSON bodies up to 64 KiB, and `responseTimestamp` /
  `durationMs` only once the request is terminal. agent-browser entries with a
  terminal status but no timing get a network-snapshot upper bound marked
  `responseTimingSource: "network-snapshot-upper-bound"`.

### Changed

- Playwright export derives each generated test's timeout from the spec's
  sequential step and outcome budgets: node verifier `script.timeoutMs` values
  add up, operations without a limit reserve 30 seconds, preconditions reserve
  their `timeoutMs` (or 120 seconds), plus 10% headroom (at least one minute),
  with a 30-minute floor and a four-hour ceiling. `--project` mode sizes
  `playwright.config.*` to the largest budget and narrows each test with
  `test.setTimeout(...)`; exported preconditions keep their spec-relative
  `cwd`, `timeoutMs` and `env`, run with publisher/TinyVault control
  credentials stripped, and are killed with their descendants at the deadline.
- Preconditions are bounded by `timeoutMs` (120 seconds by default); a timeout
  hard-kills the command and its descendant process tree.
- `--services-dry-run` prints the plan and exits before the web server, hooks,
  browser, preconditions or specs; interpolated env and selected vault values
  print as `[redacted]`.
- Logger colors use picocolors, so the logger's own color flag controls output
  independently of TTY detection; `@clack/prompts` was added for the output
  work that followed in 2.6.2.

### Security

- Redaction: more built-in sensitive keys (`code_verifier`, `otp`,
  `credential`, …) and credential-bearing query parameters; spec
  `redaction.headers` / `queryParams` / `storageKeys` now match
  case-insensitively and augment the built-in heuristics; network `postData`
  is re-parsed and redacted again before it is written; headers and opaque,
  invalid or oversized bodies are never persisted.

## [2.6.0] - 2026-07-28

### Changed

- Startup narration defaults to milestones: the services phase's
  play-by-play (readiness and healthcheck command echoes, per-window tmux
  scaffolding, seed command dumps) moved to debug (`--verbose`). Info keeps
  per-service ready/skipped milestones, pre-command build notices, heartbeats,
  and every warning, error and timeout; `events.ndjson` still records
  everything. The opening line prints a spec count and the shared directory
  instead of every absolute spec path.

### Fixed

- Each spec in a batch gets its own agent-browser session (the session id
  carries the spec index as well as the worker index), so a daemon that wedges
  during one spec no longer poisons the rest of the batch with cascading eval
  timeouts.
- The run header shows the environment the run resolved to (`--env` or the
  config default) instead of the spec's own unresolved `environment:` value.
- A skipped step names the `when:` condition that skipped it
  (`skipped — when "notText:…" not met`) instead of `(skipped by when:)`.

## [2.5.0] - 2026-07-28

### Added

- `cairn logs [ref]` — discovery and replay for the files of record a run
  leaves behind (à la `docker buildx history logs`). Bare `cairn logs`
  lists recent runs newest-first with their verdict (or "in progress /
  interrupted" when run.json has not landed — a live run is visible, not
  invisible). `cairn logs <ref>` shows one run's files with sizes;
  `--events` replays events.ndjson verbatim to stdout, tee-able;
  `--services` lists the captured tmux pane logs and `--service <window>`
  streams one, matched by the tmux window name the operator actually
  knows. `ref` accepts a run name, absolute path, `latest`, or `previous`
  — the same grammar stash and investigate use.

## [2.4.0] - 2026-07-28

Output architecture release: the terminal is a view, files are the record.
Informed by a cross-tool study (BuildKit, Buck2, Turborepo, GitHub Actions,
Playwright, Cargo) and a DX review of a real 6-spec, multi-hour run.

### Added

- `--progress <auto|tty|plain>` on `cairn run` (also `CAIRN_PROGRESS`).
  `tty` is the cursor renderer — spinner frames with elapsed time on every
  in-flight step, precondition, and verifier poll. `plain` is a DESIGNED
  sequential renderer — timestamped milestone lines, zero control codes,
  safe to pipe, tee, and diff — not "tty minus colors". `auto` (default)
  picks by stdout TTY-ness, exactly like docker --progress. The old
  `CAIRN_FORCE_TTY=1` escape hatch still works as a tty vote.

- Batch runs now narrate. The per-spec progress listener was only ever
  wired in single-spec mode: a 6-spec batch showed one banner and then
  total silence until each spec finished, minutes or hours later. With
  `parallel: 1` each spec now gets a bold `[n/N] name — starting…` banner
  and the full live narration; higher parallelism keeps completion lines
  only (interleaved cursor redraws would corrupt each other).

- Preconditions and per-outcome verifier polls announce themselves
  (`precondition quiesce started (budget 30m)`, `outcome X verifying…`)
  and report on completion, in both renderers, with `precondition.started`
  emitted to events.ndjson. A many-minute gate reads as "working, bounded"
  instead of a dead terminal.

- tmux pane output became a log of record: deltas stream incrementally to
  `~/.cairntrace/services/<project>-<window>.pane.log` while the terminal
  gets a ~15s heartbeat. Raw pane streaming used to bury entire runs under
  service stack traces. The ready-timeout error now carries the last pane
  lines — it used to throw with zero diagnostic content.

- Narration raises the logger's DEFAULT level floor to info, so services
  milestones survive a pipe without `CAIRN_LOG_LEVEL` hand-tuning. Flags,
  env, and config still win.

### Fixed

- Verify scripts receive `ctx.run` (`failedStep`, `lastSuccessfulStep`) and
  accept `script.timeoutMs` (see 2.3.0 entries); services log lines no
  longer double their `services:` prefix under the scoped logger.

## [2.3.0] - 2026-07-28

### Added

- Verify scripts (`script.runtime: node` and `browser`) now receive the run's
  step state as `ctx.run` / `run`: `{ failedStep, lastSuccessfulStep }`.
  Outcomes still always evaluate — that is the contract — but a verifier that
  polls for a side effect of a step that never ran can now bail in
  milliseconds instead of spending its whole completion window waiting for an
  event nothing will ever emit. A real suite burned 3×20 minutes exactly this
  way before this existed.

- `script.timeoutMs` on the script verifier. `runtime: node` scripts ran with
  NO bound at all — nothing above them could cap a buggy or over-patient
  poll. When set, the child is killed past the budget and the outcome fails
  with an explicit timeout message. Browser scripts were already bounded by
  the backend's evaluate timeout; the field is ignored there.

- `precondition.started` event in `events.ndjson`, emitted before each
  precondition command runs (with its `timeoutMs`). `precondition.run` is a
  post-mortem record of a blocking call: a 25-minute quiesce poll used to
  leave the event stream silent for its whole budget, indistinguishable from
  a dead run. The started twin bounds the mystery to one named command.

## [2.2.0] - 2026-07-26

### Fixed

- `wait` conditions using `text` or `notText`, and both `open.waitUntil`
  readiness waits, were no-ops against the agent-browser backend. The
  predicate was passed to `agent-browser wait --fn` wrapped in `() => …`,
  but `--fn` takes an EXPRESSION and tests its result for truthiness — a
  function object is always truthy, so the wait resolved on its first poll
  and could never fail or actually wait. A wait for text that appeared
  nowhere on the page returned "passed" in ~13ms. The predicates are now
  emitted as bare expressions.

  **This changes behaviour.** Specs that leaned on these waits for
  synchronisation were getting none, and suites may have been passing on
  timing alone; a spec that races ahead of the UI will now fail at the
  wait instead of somewhere further down. Steps that were silently
  succeeding can also legitimately start failing. Both are the point.

  The Playwright exporter was unaffected — `page.evaluate()` genuinely
  takes a function.

## [2.1.0] - 2026-07-24

### Added

- `retention.publish` can publish a verified, redacted run package to a
  private file.cheap destination with explicit producer and native-artifact
  metadata.
- TinyVault-backed runs now support an explicit selected-key scope and
  group/environment inheritance, including values referenced by imported
  actions.

### Changed

- The file.cheap publisher targets its v0.31 contract and validates both the
  returned artifact reference and the publication receipt before reporting
  success.
- Configuration, service, artifact, and secrets documentation now describes
  private publication, scoped secret injection, and the resulting run
  artifacts in English.

### Security

- Long-lived service and tmux processes receive a filtered environment, so the
  file.cheap ingest token cannot leak into a service pane.
- Secret values are buffered and redacted before run output or persisted
  artifacts are written.

### Fixed

- CI runs the browser-heavy verification suite with one worker so its test
  timeouts reflect product behavior rather than shared-runner contention.

## [2.0.0] - 2026-07-24

### Breaking

- The report-theme catalog now uses the neutral `slate` wire value. Consumers
  that depended on the removed legacy theme key must migrate to `slate`; the
  release is therefore versioned as `v2.0.0`.
- Structured `stash list`, `stash info`, and `stash search` output now
  normalizes file.cheap's snake_case wire fields to Cairntrace camelCase
  fields such as `fileCount`, `sizeBytes`, `createdAt`, and `stashId`.
- `cairn clean` structured output now always includes the required
  `archiveFailures` array. Consumers must handle it; any entry means the source
  run was retained and the command exited with code 2.

### Added

- CLI and MCP doctor reports now distinguish a loadable Playwright package from
  its matching installed Chromium executable and provide the exact Bun repair
  command for either failure.
- Investigate and audit results now have strict executable Zod v1 contracts,
  publish those contracts as MCP `outputSchema`, and validate the same wire
  value before CLI or MCP emission.
- MCP now mirrors `stash info` and `stash restore` with strict file.cheap v0.30
  output contracts, safe stash identifiers, actionable structured errors, and
  preserved integrity-mismatch receipts.

### Changed

- Stash documentation now describes file.cheap accurately as a local,
  non-replicating vault. Sharing artifacts between machines requires an
  explicit transfer.
- Investigate and audit now share one structured pipeline across the CLI and
  MCP server. `investigate.codebaseDir`, `mode`, `limit`, `index`, and
  `autoInvestigate` are active runtime settings. Explicit CLI codebase paths
  resolve from the current working directory; configured paths resolve from
  the config file.
- `cairn audit` records Playwright video even when the spec's normal capture
  policy is `never`, starts configured web/server services and TinyVault
  injection like `cairn run`, supports recording speed and slow-motion
  overrides, and keeps optional vidtrace failures visible as warnings.
- `--index` and `investigate.index` build or refresh the vecgrep index before a
  requested investigate/audit connection. Without an index, the error points
  to this opt-in instead of silently returning no matches.
- The repository is Bun-only again: the obsolete npm lockfile is gone and the
  remaining Playwright troubleshooting command uses `bunx`.

### Fixed

- Cairntrace now validates and normalizes the real file.cheap v0.30 JSON
  contracts for `save`, `list`, `info`, `search`, `connect`, and `restore`
  across the CLI, MCP tools, investigate, audit, auto-stash, and service
  capture paths.
- Archive receipts fail closed. A successful file.cheap process with malformed
  JSON or no usable stash identifier is treated as a failed archive, so
  retention cleanup cannot delete the source after an unverified save.
- Restore verification failures preserve the structured file.cheap receipt
  while returning exit code 2, including the restore target and mismatch
  details.
- Investigate and audit failures now return structured errors and exit code 2.
  File.cheap connect matches without a file path are rejected instead of being
  surfaced as unknown locations.
- `cairn audit` no longer stashes an unconnected failed run unless project
  config explicitly enables failed-run auto-stash. File.cheap and vecgrep are
  optional when the audit does not request either stage.
- Audit keeps vidtrace bundles under the run's `videos/vidtrace/`, supplies a
  disposable silent-audio copy when Whisper receives Playwright's video-only
  WebM, and removes the copy afterward. Extracted text formats pass through the
  redactor; frames/images remain uninspected.
- Failed-run automation consumes the documented stash and investigate config,
  and reuses a validated auto-stash receipt instead of archiving the same run
  twice.
- Retention archive failures are reported, count as retained runs, and make
  `cairn clean` exit non-zero without deleting the source artifacts.
- MCP stash results now report the resolved run identifier consistently for
  `latest` and `previous`.
- Partial file.cheap save receipts preserve the valid stash identifier and
  stage failures while returning exit code 2, preventing duplicate saves and
  lost recovery handles.
- `agent_context.md` refreshes its generated Code Matches section after
  investigation but omits raw source snippets; detailed redacted matches
  remain in `investigate.json`.
- Public config examples for stash, investigate, annotate, and TinyVault now
  validate against the strict v1 schema.
- Agent-browser no longer adds an implicit network-idle wait after every
  click. Same-tab links retain delivery confirmation and safe retry behavior;
  positive click/spec `settleMs` or `browser.postClickSettleMs` explicitly
  opts into network-idle settling.
- Successful automatic stashes add a path-free `stash-receipt.json`, an
  `artifact.stash` event, and a refreshed manifest without mutating the
  finalized run verdict. Receipt creation fails closed if redaction would
  corrupt its recovery identifier.
- Browser-evidence documentation now matches the artifacts Cairntrace actually
  writes. The unimplemented screenshot-video fallback proposal was replaced by
  backend-specific video and screenshot guidance.
- Doctor no longer treats an unrelated project from the codemap registry as
  proof that the current codebase is indexed.

### Security

- Production dependency auditing is part of `bun run verify` and CI. Pinned
  transitive overrides remove the known production advisories reported by Bun.
- The `@hono/node-server` `2.0.11` security override is outside the MCP SDK's
  declared `^1.19.9` range. Cairntrace tests and exposes stdio MCP only; this
  does not claim compatibility for an HTTP transport.
- Documentation now states the actual redaction boundary: Cairntrace-authored
  text/JSON and supported vidtrace text formats are scrubbed, while
  producer-owned screenshots, videos, downloads, transforms, trace archives,
  and extracted frames/images can still contain secrets or personal data.
- Public examples, fixtures, docs, report themes, and test data use neutral
  project and issue names.

## [1.49.0] - 2026-07-23

### Added

- Per-environment `waitScale` and `CAIRN_WAIT_SCALE` controls for high-latency
  browser waits, settles, and network-idle quiet windows.
- Bounded `click.until` retry conditions plus fill/type live-value verification
  that recovers when hydration wipes an interaction.

### Changed

- Pinned `@playwright/test` to the Playwright runtime version used by the
  project.

## [1.48.0] - 2026-07-22

### Added

- **Config-aware Playwright export**: `cairn export playwright` gains
  `--config <path>`, `--env <name>` and repeatable `--var key=value`, resolving
  `${vars.*}`/`baseUrl` from cairntrace.config.yml exactly like `spec verify` —
  specs that lean on config vars are now exportable.
- **`--project` mode** (`--out-dir` required): generates a STRUCTURED
  Playwright project instead of standalone spec files — `playwright.config.ts`
  (baseURL from config, serial workers, bypassCSP, globalSetup wired),
  `global-setup.ts` (deduped spec preconditions as a runnable scaffold,
  `SKIP_PRECONDITIONS=1` to opt out), `actions/<name>.ts` (each reusable action
  becomes one exported `async function(page)`; `use:` steps become imports +
  calls), `verifiers/` (node verifier files copied in — self-contained), and a
  README operating manual.
- **Node file verifiers export** (`runtime: node` + `file:`): the generated
  test dynamically imports the verifier (relative path when the out path is
  known, project-prefixed in `--project` mode) and calls `verify(ctx)` with
  resolved fixtures; ESM/CJS default-export interop handled.
- **Secrets and `${run.token}` are never inlined**: `${secrets.X}` and unset
  `${env.X}` (no `:-default`) emit as `process.env.X ?? ""` references (header
  comment lists required env vars); `${run.token}` emits a per-invocation
  `RUN_TOKEN` const so exported tests stay re-runnable. Batch exports also
  write a README.md documenting required env + per-spec preconditions.
- **Parser/loader `secretRef`/`envRef` hooks** powering the above
  (ParseOptions.secretRef, loadConfig/resolveSpecRuntimeContext envRef).
- **`cairn run` starting banner**: first output line before config/secrets/
  services resolution, so environment wedges (dead docker socket, locked
  secret agent, thrashing swap) are localizable instead of 0-byte-log hangs.
- **Precondition command `timeoutMs`** honored per command (spec schema +
  runner), and services `preCommands` accept `{run, skipIf}` probes.

### Changed

- **Exporter rebuilt on a statement IR** (`codegen.ts`) with structured
  template values (`templateValue.ts`): indentation/quoting/escaping are
  correct by construction; the old regex post-passes over generated source are
  gone. Golden-file tests + TypeScript parse AND type-check (against real
  `@playwright/test` types) validate every emission
  (`UPDATE_GOLDENS=1` to regenerate); an export→import round-trip floor test
  guards the importer contract.
- Semantic locators emit `.first()` (agent-browser acts on the first match;
  Playwright strict mode would fail on multiples).
- Evals containing `location.reload()` emit a try/catch retry — Playwright
  destroys the evaluate context on navigation; agent-browser does not.
- Generated tests stamp `CAIRN_RUN_START_FLOOR_MS` at test start so node
  verifiers scope causation to THIS run (kills a cross-run false-positive
  window observed when no cairn network capture exists).

### Known limitations

- Ambiguous semantic locators (e.g. two "Edit" buttons where one matches by
  visible text and another by aria-label) can resolve to DIFFERENT elements
  under agent-browser vs Playwright strict-mode `.first()`. Prefer unambiguous
  selectors in specs destined for export.

## [1.41.0] - 2026-07-17

### Added

- **`cairn run --tag <tag>`** (repeatable, AND, case-insensitive): run only
  specs whose `metadata.tags` includes every requested tag. Works with directory
  expansion, pairs with `--select-only` for a dry selection preview, and combines
  with `--since-codemap`. SelectionResult v1 gains optional `tags` (the filter)
  and per-selected `tags` (from the spec) for fancy JSON/markdown output.

  ```bash
  cairn run flows/ --tag checkout --select-only --json
  cairn run flows/ --tag checkout --headed --cold-start
  ```

## [1.40.3] - 2026-07-17

### Fixed

- **tmux main commands are re-sent if the pane stays idle.** direnv/zsh double
  load could swallow the first `send-keys` (`yarn serve` never ran; web-app
  sat at an empty prompt). Cairn now waits for a real shell (not empty
  `pane_current_command`), then retries the main command up to 3 times until
  the pane leaves the idle shell.
- **docker refresh no longer fires on cold-start against already-running
  containers.** `--cold-start` re-runs `compose up` but that is not a refresh
  when containers were already up — tmux is only recreated when containers
  were actually down before the up.

## [1.40.2] - 2026-07-17

### Fixed

- **Recreate tmux when docker was refreshed this run.** A leftover session with
  still-running `node`/`go` panes looked "live" after `docker compose up`
  recreated containers, but those processes held dead mongo/redis/postgres
  connections and spammed reconnect errors. If docker actually started (not
  reused) this run, cairn kills and recreates the tmux session so app services
  reconnect cleanly.

## [1.40.1] - 2026-07-17

### Fixed

- **tmux services boot no longer loses `send-keys` to direnv/zsh startup.**
  After creating a window, cairn waits for a stable interactive shell, clears
  residual pane history (so `readyOn` text cannot match stale "listening"
  lines), then sends pre-commands and the main command. Pre-commands wait for
  the shell to return before the next `send-keys`, so a long `yarn build` is
  not stomped by `yarn start`.
- **tmux session reuse heals dead/missing windows.** A leftover session no
  longer short-circuits startup: missing windows are created, idle shell panes
  (command never started or process died) are re-launched, and panes already
  running a non-shell process are left alone.
- **teardown no longer runs `docker compose down` while reusing tmux.** Live
  dev-server panes need mongo/redis/postgres; tearing docker down while
  leaving the session alive was orphaning Go/Node services against dead ports.
  With `tmux.reuseExisting: false`, full teardown (tmux kill + docker down)
  still runs.

## [1.40.0] - 2026-07-16

## [1.39.0] - 2026-07-16

## [1.38.0]

Read honesty: a backend that could not observe the page used to answer with a
value that satisfied the assertion. Every absence-shaped outcome — "no console
errors", "no failed requests", "this text is absent", "zero elements match" —
could therefore be certified against a page nobody successfully read, and
because outcomes are evaluated after the steps already passed, no step failure
flagged it. **This release turns some currently-green specs red. That is the
fix working**: those specs were passing on an unread page. There is no
deprecation window, because a deprecation window for "we stopped lying to you"
is just a longer lie.

Field-verified against a production SPA: `notText` and `noFailedRequests`
outcomes pass unchanged; the example suite is byte-identical before and
after, apart from two specs that were already red.

### Fixed

- **Failed reads no longer report a green verdict.** Every backend read that
  could not observe the page degraded to a falsy value — `""`, `0`, `[]` — and
  each of those satisfies an absence-shaped assertion. A wedged daemon made
  `console.errorsMax: 0` and `noFailedRequests` pass over a page whose console
  and network log were never read; because outcomes are evaluated after the
  steps already succeeded, no step failure flagged it and the green was the
  only thing the user saw. `getText`, `getCount`, `getConsole`, `getErrors` and
  `getNetworkRequests` now throw on a failed read. Verifiers already surfaced
  throws as failed outcomes (`OutcomeEvaluator`) and step failures
  (`Runner`'s `when:` guard), and the Runner's `console.ndjson` dump keeps its
  best-effort `safe()` wrapper — only the verdict paths changed.
- **Absence assertions see every match in a region, not just the first.**
  `region:` may legitimately match several elements — `notText`'s guard admits
  `count > 1` — but agent-browser's `get text` returned only match #1 while
  Playwright's `innerText()` threw a strict-mode violation on 2+. An absence
  assertion therefore reported "confirmed absent" for text sitting in match #2.
  Both backends now read every match and join it the way Playwright's
  `allInnerTexts()` does, so they hand the text verifiers an identical
  haystack. The Playwright path waits for the first match explicitly, since
  `allInnerTexts()` does not auto-wait the way `innerText()` did.
- **Unreadable agent-browser output is an error, not an empty result.**
  `parseEnvelope` returned `[]` on unparseable stdout, a missing key, or a
  non-array value, on the reasoning that "verifiers should never crash" — but
  every caller feeds an absence-shaped verifier, so `[]` was itself the crash,
  reported as a pass. A successful `--json` read always emits its key (an empty
  console is `{"data":{"messages":[]}}`, never blank stdout), so these shapes
  cannot occur on a read that happened. A genuinely empty result set still
  returns `[]`.
- **`examples/flows/02-row-count.yml` and `07-config-driven.yml` were red.**
  Both counted `role: row` unscoped and expected 3, but `role: row` expands to
  `[role=row], tr` and the demo table's `<thead>` row is a row by ARIA
  semantics too — the true count is 4. Both now scope to `in_region: tbody`,
  which is what "3 inventory rows" always meant.

## [1.37.0]

Production SPA hardening: silent framework click drops now recover or fail at
the authored interaction, text contracts tolerate rendered CSS casing,
aborted suites retain their completed evidence, and browser artifact capture
is bounded.

### Added

- **Per-click and per-spec `settleMs`.** Agent-browser post-click network-idle
  settling now resolves click override → spec override → project
  `browser.postClickSettleMs` → 5000ms; a resolved `0` skips the settle AND the
  link-delivery probe (the author is opting out of post-click waiting).
  Playwright and Playwright exports honor explicit click/spec values while
  retaining native waits when neither is set.
- **Intentional guest cold starts.** `coldStart: guest` acknowledges a public,
  sessionless spec while preserving the required `--cold-start` replay gate.
- **Interrupted-batch summaries.** SIGINT/SIGTERM writes a strict
  `run-batch-aborted:v1` summary at the artifact root before teardown, with
  completed `RunResult` objects in input order and pending counts.
- **Text matcher case control.** `caseSensitive` is available for text/notText
  equals/contains outcomes and text waits. Regex matchers remain raw and
  case-sensitive.

### Changed

- **Framework-safe batch clicks.** A batch remains one native invocation, but
  click sub-steps are paced by 100ms. Checkbox/radio/switch state is re-queried
  across framework rerenders (including mixed state) and verified in two stages:
  a ~500ms grace lets a slow async commit land before a single live-element
  recovery click, then a ~500ms settle confirms the result. A double-toggle
  (late authored commit plus the recovery both applying and flipping the
  control back) fails loudly instead of passing a flipped-back state, and the
  failure names the authored sub-step + phase. Missing or implicit batch
  command results are failures, never silent success.
- **Rendered text defaults.** Human-facing text waits and equals/contains
  outcomes now collapse whitespace and compare
  case-insensitively by default across both backends and Playwright exports.
- **Link delivery verification.** Link clicks are classified first: only a
  same-tab http(s)/relative nav link briefly watches for a URL or DOM mutation,
  and a still-present enabled one gets a single low-level mouse retry at its
  live center. External-effect links (`target="_blank"`, a `download`
  attribute, or a `mailto:`/`tel:`/`javascript:` scheme) never mutate the
  current document, so they are clicked exactly once and pass with a diagnostic
  note — no double-fired retry, no false failure. Ordinary buttons are never
  retried this way.
- **Retention counts interrupted runs.** Failed/errored runs keep their
  `keepFailedRuns` carve-out, but interrupted runs (missing/corrupt/statusless
  `run.json` left by a signal) now count toward the `keepRuns` window instead
  of being retained forever — the newest interrupted run is preserved up to the
  cap and older ones age out. `pruneRuns`/`cairn clean` also sweep stale
  `aborted-<ts>-<pid>.json` batch summaries under the same cap; `cairn clean
--all` remains authoritative.
- **Documentation site refresh.** The landing page, navigation, metadata,
  social preview, manifest, and responsive theme were overhauled.

### Fixed

- Screenshot capture now has a 15-second hard deadline on agent-browser and
  Playwright, reports the likely missing-rendering-surface/display cause, and
  never publishes a partial PNG. A capture timeout is best-effort — it records a
  warning + missing-artifact note but does not fail the step, spec, or
  outcomes; it only marks the backend wedged so the remaining optional captures
  (console/network/trace/video) are skipped while outcome verifiers still run.
- `cairn run` now returns its documented shell exit status after lifecycle
  teardown. Contract mismatches are actionable and return 6 in single, batch,
  and heal paths; ordinary parse/runtime errors remain 2.
- JSON run output stays pure JSON; web-server diagnostics and tails remain on
  stderr even when scoped loggers were created before final logger config.
- Batch semantic-locator schema mistakes name the offending sub-step, and
  ambiguity diagnostics retain only the first three accessible candidates plus
  an omitted count.
- TinyVault key listing no longer requires unlocking secret values; CLI and MCP
  status paths expose key names only.

## [1.36.0]

Hardening from the 2026-07-12 empty-`<main>` incident: an agent-browser text wait
timed out on a streamed-SSR dashboard whose Suspense content never committed
(stream abort under machine-wide contention), and the failing run's artifacts were
destroyed by routine pruning before anyone could read them. The failure never
reproduced. Verdict: both live observers (in-page `wait --text` predicate and the
post-failure a11y snapshot) were correct — the page genuinely showed the fallback.
This release makes the next such incident survivable and self-diagnosing.

### Added

- **Sliced live-document waits (agent-browser).** Budgeted `text` / `notText` /
  `selector` waits are re-issued as fresh ≤5s subprocess slices until the spec
  budget is spent, instead of one daemon-side wait holding the whole budget. Each
  slice re-queries the live document, so no daemon-side wait state can go stale
  across a navigation or streaming-SSR commit for more than one slice, and a
  wedged child burns one slice (+grace) instead of `timeoutMs`+5s. Happy path
  unchanged: the first slice returns as soon as the condition holds. Load-state
  waits and waits without a spec budget keep the single invocation (`--load`
  observes only future transitions; re-arming per slice would miss the one it
  needs). Exhaustion stderr records the true total: `wait exhausted its <N>ms
budget across <k> fresh live-document polls`.
- **`retention.keepFailedRuns` (default 10).** The newest N `failed`/`errored`
  runs per spec now survive pruning on their own quota, beyond `keepRuns` —
  routine pruning can no longer destroy the only evidence of a failure that has
  stopped reproducing. Failed runs already inside the `keepRuns` window count
  against the quota; statusless/corrupt `run.json` stays prunable. `cairn clean`
  honors it; `--all` still removes everything. The clean report gains
  `keepFailedRuns`.
- **Streaming-SSR forensics in failure diagnostics.** `captureDiagnostics` now
  records `readyState`, `suspenseBoundaries` (React streaming comment markers:
  `$?` pending server flush, `$!` errored → client-rendered fallback), and
  `landmarks` (header/main/footer presence, child count, visible text length).
  A wait timeout on a streamed page now distinguishes "stream still pending" /
  "stream aborted" / "committed but empty" from one JSON artifact.

### Changed

- The agent-browser adapter header documents the verified CLI version (0.31.1)
  and that the binary is resolved from `$PATH` unpinned — first thing to check
  when wait/snapshot behavior changes after an update.

## [1.33.0]

### Added

- **`cairn spec heal --verify` — verified transactional heal (SPEC §7.2).**
  Proposes selector-drift ops, applies them to the owning file, cold-start reruns
  the spec, and accepts only if the rerun passes (all outcomes pass). On failure
  the owning file is restored (rollback). Returns a `HealVerifyResult` with
  `verified`, `confidence` (high|low), `beforeRun`/`afterRun` run IDs,
  retained `evidence` (the after run dir), and the exact `replay` command.
  Mirrors glyphrun's `glyph repair --verify`. New `healVerify` +
  `HealVerifyResult` in Healer.ts; `HealOutput` gains `owningFile` (always
  populated when ops > 0); CLI `--verify` flag on `cairn spec heal`.

## [1.32.0]

### Added

- **`replay.json` exact-replay manifest (SPEC §7.3).** Every run now writes
  `replay.json` alongside `run.json`: the exact `cairn run <spec> --json`
  command, backend, environment, base URL, viewport, resolved capture policy,
  the redacted env/var KEY NAMES (never values), the cairn version, and the run
  id. An agent can reproduce a run bit-for-bit without re-reading the resolved
  spec; §7.2's "exact replay action" return can cite it directly. Mirrors
  glyphrun's `replay.json`. New `src/core/schema/replay.v1.ts`; `RunArtifactsSchema`
  gains an additive `replay` field; `ArtifactWriter.writeReplay`; wired into
  the runner (best-effort — a write failure never fails the run). Test asserts
  the manifest is written, parses against the replay.v1 schema, carries the
  replay command + backend + cairn version.

## [1.31.0]

### Added

- **`nextActions` on non-passing RunResults** (SPEC §7.1 verification contracts).
  The `cairn run` / `cairn_run` MCP result now carries an additive `nextActions`
  array on failed/errored runs — one actionable next step (command + reason +
  `safeToAutoRun`, always false) derived from the run's failure, mirroring
  glyphrun's convention so an agent gets a concrete `cairn run <spec> --json`
  rerun command instead of an ambiguous error. Passed runs omit it (byte-identical).

### Changed

- **MCP `structuredContent` is now Zod-validated before sending (SPEC §7.1).**
  Every tool result that was cast through `as unknown as Record<string, unknown>`
  now routes through its declared Zod schema's `.parse()` first, so wire-shape
  drift is caught at the boundary instead of silently sent. `cairn_spec_heal`
  now routes through the same `toHealResult` converter the CLI uses
  (`HealResultSchema.parse(toHealResult(out))`) — it was previously sending the
  raw `HealOutput`. New permissive `mcp.v1` schemas cover the discovery /
  config / services surfaces that had no declared schema. `BackendSchema` gains
  `mock` (the mock backend is a real `cairn run --mock` option the schema omitted).

## [1.29.1]

### Fixed

- **Off-viewport click guard double-subtracted the page scroll.** `get box`
  returns viewport-relative coordinates (verified against
  `getBoundingClientRect` on agent-browser 0.31.1), but 1.28.x's
  post-scrollIntoView confirmation subtracted `window.scrollY` from the box
  center anyway — flagging every legitimately-scrolled click as
  "stayed off-viewport" (deterministic, not flaky: a checkout grid sat below
  the fold, so the in-view button at viewport y≈460 with scrollY≈875 computed
  to center y=-415). Clicks near
  the page top ran at scrollY=0 where subtracting zero is harmless, which
  is why the bug hid in otherwise-green suites. The check now compares the
  viewport-relative center directly against innerWidth/innerHeight.
- **The confirmation is now a short poll with re-scroll, not a one-shot
  read.** CSS `scroll-behavior: smooth` animates scrollIntoView over
  several hundred ms, and async sections above the target can collapse
  when their data lands, yanking a centered target back out of view. The
  guard re-reads (and re-issues scrollIntoView) every 250ms for up to
  1.5s; the happy path still returns on the first read, and genuinely
  unreachable position:fixed targets fail after the budget as before.

## [1.29.0]

### Added

- **Config `browser:` block — project-level tuning for the verify-after-click
  guard.** 1.28.1's `verifyAfterClick` (5s networkidle settle folded into every
  click) shipped adapter-only with no way to configure it from a project:
  `AgentBrowserOptions.verifyAfterClick` existed but nothing plumbed it through
  `createBackend`. Dev servers that compile modules on demand (Nuxt/Vite SPA
  routes) routinely need >5s to go network-quiet after a login click even
  though the page is fine, which failed most authenticated-page clicks in one
  production SPA suite while their outcomes passed.
  `cairntrace.config.yml` now accepts:

  ```yaml
  browser:
    verifyAfterClick: true # default: true
    postClickSettleMs: 20000 # default: 5000
  ```

  Resolved once per `cairn run` invocation (same scope as `webServer`/
  `services`) and applied to every backend the run constructs, including
  parallel batch workers. Prefer raising `postClickSettleMs` over disabling
  `verifyAfterClick` — the wedge protection stays.

## [1.25.1]

Two agent-browser reliability fixes that both manifested as silent no-ops.

### Fixed

- **`viewport:` was silently ignored under the agent-browser backend.**
  `AgentBrowserAdapter.setViewport` sent `agent-browser viewport <w> <h>`, but
  browser-settings mutators are namespaced under `set` — there is no bare
  top-level `viewport` command. The command exited 1 ("Unknown command:
  viewport"), `window.innerHeight` never changed, and because the Runner
  routed `setViewport` through its error-swallowing `safe()` helper, no error
  surfaced to the spec author — the `viewport.set` event was written
  unconditionally and looked identical to a success. The adapter now sends
  `set viewport <w> <h>`, and the Runner records `ok: true|false` (plus
  `error:` on failure) on the `viewport.set` event so a broken apply is
  visible in `events.ndjson` and diagnostics. The Playwright backend was
  never affected (it applies viewport directly via `page.setViewportSize`).
- **Off-viewport `click` silently no-op'd under agent-browser.** When a
  target sits inside a `position: fixed` container taller than the viewport
  (e.g. a modal footer button past `window.innerHeight`), `scrollintoview`
  cannot bring it into view (a fixed element's position doesn't change with
  document scroll), yet agent-browser's `scrollintoview`, `is visible`, and
  `click` all report success — the click never lands and
  `document.elementFromPoint` at the target returns `null`. `click` (only)
  now runs an independent post-scroll viewport-membership check via `get
box` + `eval`, and fails the step loudly with a diagnostic when the
  target's center is confirmed outside the live viewport, instead of
  silently passing. The check is best-effort: an inconclusive result (older
  agent-browser version, parse failure) never blocks the action. `hover` /
  `fill` / `type` / `upload` and `by: selector` locators are unchanged for
  now — extending the check there is straightforward if warranted.

## [1.23.7]

The three follow-ups deferred from the v1.23.6 review.

### Fixed

- **`notText` no longer passes vacuously over a missing region.** When a
  specific region was targeted (`notText: { contains, region: "#typo" }`) but
  the region didn't exist, `getText` returned `""` and the absence check passed
  silently, masking a broken assertion. It now confirms the region resolves to
  an element first and fails clearly if it doesn't. _A spec asserting absence
  over a missing region will now correctly fail._
- **`count: { role }` counts native semantic elements, not just explicit
  `[role]` attributes.** `role: row` now matches `<tr>` (and `button` → native
  `<button>`, `link` → `<a href>`, `heading` → `<h1>`–`<h6>`, etc.), so a count
  over a normal `<table>` works. This is a heuristic CSS expansion — for exact
  ARIA semantics use a `selector`. _Role counts that were silently returning 0
  on native markup will now return the real count._

### Added

- **Playwright importer round-trip coverage** for the steps the exporter
  already emits: `type` (`pressSequentially`, with `delay`), selector waits
  (`waitForSelector` → `wait: { selector, state, timeoutMs }`), and `.nth(N)` on
  role/label/text locators (previously silently dropped, which targeted the
  wrong element).

## [1.23.6]

A correctness pass over the healer and verifiers. Some fixes tighten checks, so
a spec that was passing on a _wrong_ result may now correctly fail — see notes.

### Fixed

- **`cairn spec heal --apply` could corrupt the spec file.** When the healer
  inserted a wait step, it used `addIn(["steps", N], …)`, which merged the new
  step _into_ `steps[N]` as a complex mapping key instead of splicing a sibling
  — producing an unparseable file. It now splices a proper sibling seq item.
- **`noFailedRequests` missed transport-level failures.** It only flagged
  requests with a 4xx/5xx status, so an aborted / blocked / DNS-failed /
  connection-refused request (which never gets a status) passed silently, and
  the evidence falsely read "returned <400". Failed requests are now marked by
  the Playwright adapter and counted; genuinely-pending/streaming requests are
  not flagged. _A spec that was silently ignoring a failed request may now
  fail._
- **`count: { text }` is rejected at parse time.** It was accepted but silently
  matched zero elements (an `atMost`/`equals: 0` always passed, an `atLeast`
  always failed). Counting by text needs the a11y tree; use the `text` verifier
  for presence or `script` for a real count. The Playwright importer now maps
  text-visibility assertions to a `text` verifier instead.
- **`httpJson` `equals`/`contains` are order-insensitive** for object keys (was
  a `JSON.stringify` compare that failed when the server emitted keys in a
  different order), and **`atLeast`/`atMost` reject non-numbers** instead of
  coercing them (`Number([])` was `0`, making a bound vacuously pass).
- **`script` verifier requires a boolean `ok`** on the browser path too (the
  node path already did) — a truthy non-boolean like the string `"false"` no
  longer counts as a pass.
- Playwright exporter flattens newlines in `step.id` / `when` / `use` comments
  so a crafted multi-line value can't inject lines into the generated test.
- Cleared the remaining `oxlint` warnings (`Array#sort` → `toSorted`, function
  scoping).

## [1.23.5]

### Fixed

- **Placeholder substitution no longer breaks when a resolved value contains
  YAML metacharacters.** Substitution previously rewrote the raw YAML _text_
  and re-parsed it, so a secret/env/var value containing `:`, `"`, `{`, `#`, or
  newlines could corrupt the document (e.g. a quoted `"${env.X}"` resolving to
  `a: b "c"` produced invalid YAML). Substitution now resolves into the parsed
  YAML **AST** — the YAML library owns serialization, so any resolved value is
  safe. Types are preserved via scalar style: an unquoted `${env.PORT}`
  re-infers its YAML type (number/bool/null) exactly as before, while a quoted
  `"${env.PORT}"` stays a string. Structural values (`a: b`, `[1,2]`) can no
  longer silently restructure a spec. Behavior is unchanged for existing specs.

## [1.23.4]

### Added

- **Warnings for clip/video misconfigurations that would silently produce
  nothing.** A run now emits an `artifact.video` warning event when
  `clipPoints` are configured but `artifacts.capture.video` is `never` (so no
  video is recorded and no clips can be cut), or when video is requested on a
  backend that can't record it (only the playwright backend does). The marquee
  "run → video → vidtrace clip" loop no longer fails silently.

### Changed

- **Config `${env.X:-default}` now falls back on an _empty_ env var, not just
  an unset one** — matching shell `:-` semantics and the spec parser, so
  `cairntrace.config.yml` and specs resolve the same placeholder identically.

### Internal

- Added GitHub Actions CI (`bun run verify` on push/PR + a real-Chromium
  end-to-end smoke); previously verification ran only via local git hooks.
- Added backend step-shape guards (opt-in strict `MockBrowserBackend`
  validation, a recorder→`StepSchema` contract test, and per-step
  `PlaywrightAdapter` coverage) so step-shape and adapter-no-op bugs can't ship
  green.

## [1.23.3]

### Fixed

- **MCP server now disposes its signal handlers on close.** `buildMcpServer`
  registered process-level `SIGINT`/`SIGTERM` handlers but never removed them,
  so building many servers in one process (e.g. across a test run) accumulated
  listeners past Node's `MaxListeners` default and emitted a warning.
  Production was unaffected (one server per `cairn mcp` process), but the noise
  masked any real listener leak. Handlers are now named and removed when the
  server closes, via the SDK's `Protocol.onclose` hook (chained so the SDK's
  own teardown is preserved).

## [1.23.2]

A review-and-fix pass over the v1.12–v1.23 DX/UX work. All fixes; no CLI/schema
surface changes.

### Fixed

- **Tvault secret values could leak unredacted into artifacts.** The artifact
  redactor only scrubbed env values whose _key_ matched a sensitive-name
  heuristic (`token`, `secret`, `password`, …). Vault secrets with ordinary
  key names — `MONGO_URI`, `DATABASE_URL`, `STRIPE_*`, `SMTP_URL` — were
  injected into the environment but never registered for redaction, so their
  plaintext could appear in `spec.resolved.yml`, `run.json`, `report.html`,
  `agent_context.md`, and `events.ndjson`. Every value pulled from the vault is
  now registered with the redactor regardless of key name.
- **`type` step was a silent no-op under the Playwright backend.** The
  `PlaywrightAdapter` had no `type` branch in `runStep` or the batch path, so a
  `type` step reported a green pass while typing nothing (and the Playwright
  exporter dropped it). It now uses `locator.pressSequentially(...)`, and an
  exhaustiveness guard makes any future unhandled step fail loudly instead of
  passing.
- **`--env` did not reach the seed/services phase as `CAIRN_TVAULT_ENV`.**
  Services (docker/seed/tmux) start before secret injection, so under
  `cairn run --env dev` they resolved `${env.CAIRN_TVAULT_ENV:-local}` to
  `local` and could seed/migrate against the wrong environment's database.
  `CAIRN_TVAULT_ENV` is now set from `--env` at the very top of `cairn run`.
- **`${env.X:-default}` defaults containing `/` (URLs/paths) were not
  substituted in specs**, and substituted values that themselves contained
  `${...}` were re-expanded (cross-secret splicing, or a crash on a
  value-borne `${vars.X}`). Both are fixed by a single balanced-brace scanner
  that resolves each placeholder once and never re-scans a resolved value.
- **Discovery recorded schema-invalid `scroll` steps.** The step recorder
  emitted `{ scroll: { down: N } }`, which the strict schema rejects — it threw
  on the agent-browser backend and produced unparseable exported specs. Now
  emits `{ scroll: { direction, px } }`.
- **Services orphaned docker/tmux/seed on a partial-startup failure.** A
  later-phase failure (e.g. a tmux window that never becomes ready) left earlier
  phases running with no teardown. `startServices` now tears down what it
  started before propagating. Readiness and seed-freshness checks are also
  time-bounded now (they previously ran with no timeout and could hang a run
  forever).
- **Discovery browsers were orphaned on SIGINT/SIGTERM.** Session backends were
  created inline and not tracked by the signal-teardown machinery; the shutdown
  hook only fired an un-awaited async close. It now calls `terminateSync()` on
  each session backend so the agent-browser daemon + Chrome are killed on
  Ctrl-C.
- **Reviewing a discovery session could reap it mid-export.** Read-only ops
  (`_suggest`, `_export`) didn't refresh the session TTL, so a long review pause
  let the idle sweep close the session and lose all recorded steps. These ops
  now refresh activity.
- **Failed discovery steps were exported as if they had succeeded.** Export now
  excludes steps that did not execute successfully and reports how many were
  dropped.
- **`cairn spec verify --stamp` stripped hand-authored quoting.** Stamping
  re-serialized the whole spec in PLAIN style, mangling `"${vars.X}"` /
  `"${secrets.X}"` quotes and comments. It now updates only the `contractHash`
  node via the YAML Document API, preserving the rest of the file.
- **Discovery hardening:** concurrent operations on one session are now
  serialized (no interleaving on the shared browser), open sessions are capped
  to bound process/FD usage, user-declared services `teardown` commands run on
  the signal path, and a requested clip that can't be cut because vidtrace is
  missing now records a diagnostic instead of being silently dropped.

## [1.23.1]

### Fixed

- **`--env` flag now propagates to `CAIRN_TVAULT_ENV`** — when `cairn run --env dev`
  is used with `secrets.provider: tvault` in group/env mode, the tvault env
  was resolved from `${env.CAIRN_TVAULT_ENV:-local}` in the config. Since
  `--env` only set the cairn env name (for baseUrl/vars), but not
  `CAIRN_TVAULT_ENV`, tvault always resolved to `local` regardless of the
  `--env` flag. This meant dev-pinned secrets (e.g. `MONGO_URI`) were never
  injected. Now `--env <name>` sets `CAIRN_TVAULT_ENV=<name>` automatically,
  unless the caller explicitly set `CAIRN_TVAULT_ENV` to decouple the two.

## [1.23.0]

### Added

- **Tvault secret shadowing warning** — when `secrets.provider: tvault` is
  configured, `cairn run` now warns if any tvault secret key is already set
  in the process environment with a _different_ value (e.g. from bun's
  automatic `.env` loading). Previously, stale `.env` credentials silently
  shadowed tvault values with no diagnostic, causing authentication failures
  that were hard to trace. The warning names the affected keys and suggests
  removing them from `.env` or unsetting them.

## [1.22.0]

### Added

- **`${env.X:-default}` fallback syntax** — spec placeholders now support
  shell-style default values when an env var is missing or empty:
  `${env.MISSING:-fallback}`. Defaults can themselves contain runtime
  placeholders like `${run.token}`. Empty-string env vars trigger the
  fallback, not just undefined ones.

## [1.21.0]

### Added

- **Discovery sessions** — interactive page exploration and spec authoring
  via `cairn discover open/navigate/interact/snapshot/export`. Create a
  stateful browser session, navigate, take accessibility snapshots, perform
  actions (click, fill, hover, type, scroll, press), and export recorded
  steps as a spec YAML file.

## [1.16.0]

### Added

- **`eval` step type** — a page-context JavaScript escape hatch that runs
  arbitrary JS in the browser via `backend.evaluate()` and optionally captures
  the JSON-serializable return value as `evals/<assign>.json`. Captured values
  are spliced into later steps via `${evals.<name>.value.<field>}`. Use it for
  state setup and internal-state assertions that no UI affordance can reach
  (seed a Vuex/Redux/Pinia store, read `localStorage`, assert on a computed
  property). Exactly one of `js` (inline) or `file` (path to a .js file) is
  required; optional `args` is passed as the single argument to the wrapped
  function; `assign: name` writes `{ value: <return> }` to `evals/<name>.json`
  (after redaction). Opaque to `heal` — there is no locator to repair. The
  backend primitive (`BrowserBackend.evaluate()`) already existed across all
  three adapters; this is a schema + runner + docs + tests effort.
- **`evals/` artifact directory** — eval step return values are written as
  `evals/<assign>.json` alongside `downloads/`, `transforms/`, `requests/`.
- **`${evals.<name>.value.<field>}` runtime placeholder** — mirrors
  `${requests.<name>.body.<field>}`; resolves into any string field of later
  steps. Unknown names/paths render as empty string.
- **`artifact.eval` event type** — emitted in `events.ndjson` when an eval
  step captures a value.
- **`ArtifactRef.kind: "eval"`** — eval artifacts appear in `RunArtifacts.evals`,
  evidence files, `agent_context.md`, and `report.html` artifact links.
- **`evals` in `VerifierContext`** — script verifiers can access captured eval
  values via `ctx.evals` / `${evals.*}` fixture interpolation.

### Changed

- **`healSpec` skips eval steps** — returns `no-heal-possible` with a clear
  "eval steps are not healable — escape hatch" message instead of attempting
  locator-based repair.
- **`collectUnresolvedRuntimeRefs`** now scans for `${evals.<name>...}` refs
  in addition to `${artifacts.*}` and `${requests.*}` — outcomes depending on
  a never-produced eval value are reported as blocked, not failed.
- **`resolveFixtureMap`** resolves `${evals.*}` placeholders in script verifier
  fixtures.

## [1.15.0]

### Added

- **Per-run codemap auto-annotation (pass + fail)** — `cairn run --auto-annotate on-run`
  emits one codemap annotation per run with run context: `{ specName, contractHash,
runId, status, outcomes, failedVerifier }`. The `contractHash` lets codemap
  consumers invalidate stale green badges when the spec's contract changes. This
  generalizes the existing `on-investigate` annotate seam from failure-only to
  bidirectional (pass + fail), closing the loop with future impact-driven spec
  selection.
- **`annotate.autoAnnotate: on-run`** config mode — the enum now accepts
  `on-run | on-investigate | never` (previously `on-investigate | never`).
- **`--auto-annotate <mode>`** CLI flag on `cairn run` — overrides config
  `annotate.autoAnnotate`; accepts `on-run` or `never`.
- **`maybeAutoAnnotateRun`** exported from `annotate.ts` — wired into both
  `runSingle` and `runBatch` paths, best-effort (silently skipped if codemap
  isn't installed).

## [1.14.1]

### Fixed

- **tvault availability checks** in `doctor`, `secrets`, and the MCP server used
  `tvault version` (a non-existent subcommand). tvault expects `tvault --version`.
  The old call always failed, so tvault was misreported as unavailable even when
  installed.

## [1.14.0]

### Added

- **Services lifecycle block** — `cairn run` can now own the full multi-service
  environment lifecycle via the `services:` config block:
  - **Docker**: `docker compose up -d` with `reuseExisting` detection,
    `readinessCheck` command, and `healthcheck` (command + startPeriod + interval
    - timeout + retries).
  - **Conditional seed**: runs once, then skips if fresh (three-layer check:
    fingerprint + TTL + optional `freshnessCheck`). State tracked at
    `~/.cairntrace/services/<project>.seed.json`.
  - **tmux session management**: creates sessions from scratch with session-level
    `options`, `env` (via `tmux set-environment`), `defaultShell`, per-window `env`,
    `preCommands`, `readyOn` (URL or text), and per-window `healthcheck`.
  - **Teardown**: reverse order (tmux kill → docker down).
  - **fcheap session stash**: optionally stash session artifacts (tmux panes, docker
    logs, seed output) to fcheap via `services.stash`.
  - **tvault integration**: `secrets.provider: tvault` injects vault secrets into
    the seed command's env (first time `getTvaultEnv()` is called from the run path).
  - **`--no-services`** CLI flag to skip the entire lifecycle.
- **`cairn config validate`** command — validates `cairntrace.config.yml` structure
  (zod schema) and cross-field rules (unique window names, readyOn constraints, tvault
  provider requires tvault block). Supports `--config`, `--format json|yaml|md`.
- **`cairn_config_validate` MCP tool** — mirrors the CLI command.
- **`services` doc topic** — `cairn docs services` returns full documentation for the
  services lifecycle, healthchecks, and fcheap session stash.
- **HealthcheckSchema** — Docker-style healthcheck semantics for docker and tmux
  windows (command, startPeriod, interval, timeout, retries).
- **`docker.readinessCheck`** — shell command run after `docker compose up` completes.
- **SeedStateStore** — seed freshness tracking at
  `~/.cairntrace/services/<project>.seed.json`.
- **lefthook** pre-commit hooks (typecheck, lint, format:check, knip, tests).
- **knip** configuration for unused exports/deps detection.
- **Coverage enforcement** — 80% minimum threshold in vitest config.
- **Shared helpers exported from `webServer.ts`** — `runShell`, `probeOnce`, `sleep`,
  `spawnProcess` for reuse by `services.ts`.

### Fixed

- **`script` verifier no longer rejects numeric/boolean `fixtures` values with a misleading error.**
  `verify.script.fixtures` previously required string values (`z.record(string, string)`). Spec
  authors routinely supply numbers/booleans — most often through `${var}` interpolation (e.g. an
  expected row count of `0`, which YAML parses as a number). Because `ScriptVerifierSchema` is one
  member of the **strict** `VerifierSchema` `z.union`, a single non-string fixture value made the
  whole `script` member fail to parse, and Zod then surfaced the _sibling_ members' rejection of
  the unmatched `script` key as:

  ```
  Unrecognized key(s) in object: 'script'
  ```

  i.e. a valid-looking spec read as _"the `script` verifier isn't supported."_ This was easy to
  misdiagnose as a parser/schema "cold-init" defect (it appeared intermittent because it depended
  on whether a given spec's fixture values happened to be strings or numbers).

  `fixtures` now accepts `string | number | boolean` and stringifies each value, so verifiers still
  receive `Record<string, string>`. Objects/arrays are still rejected as genuine errors, and the
  `exactly one of run | file` rule is unchanged.

  - Authors no longer need to defensively quote numeric interpolations
    (`expectedRowCount: "${vars.count}"`); `expectedRowCount: ${vars.count}` works.

### Investigation note

- An earlier hypothesis blamed a TDZ / circular-import in `src/core/schema/*` causing union members
  to be dropped at construction. This was **refuted**: the schema dependency graph is an acyclic
  DAG, `VerifierSchema`/`StepSchema` build with all members, and the defect did not reproduce
  against source. The true cause was the strict-union error masking a fixture type mismatch (above).

### Tests

- Added `src/core/schema/verifier.v1.test.ts` covering string/number/boolean fixtures, object/array
  rejection, and the `run`/`file` exclusivity rule.

## [1.12.0]

- Video capture (`artifacts.capture.video`), fcheap stash integration, `investigate`/`audit`,
  codemap + TinyVault integration, doctor checks. (See release notes.)
