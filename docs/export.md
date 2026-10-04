---
title: Export & import (Playwright)
description: Hand off Cairntrace specs to Playwright JS/TS, or import Playwright tests into reviewable YAML.
---

# Export & import (Playwright bridge)

Cairntrace stays the **agent source of truth**. Use Playwright export when CI or
a human-only suite needs a plain `@playwright/test` file.

## Journey brief (fragile environments)

When the spec already passes locally but locators will not replay, export an
agent-neutral brief instead of Playwright source. Full guide:
[Journey briefs](/brief).

```bash
cairn export brief flows/login.yml --from-run latest --stdout --format md
```

## Export

```bash
# TypeScript (default) + markdown coverage report
cairn export playwright flows/login.yml

# JavaScript
cairn export playwright flows/login.yml --lang js --out tests/login.spec.js

# Batch a directory
cairn export playwright flows/ --lang ts --out-dir playwright/tests --format json

# Source only (pipe)
cairn export playwright flows/login.yml --stdout > tests/login.spec.ts

# Portable project (package.json, tsconfig.json, config, tests, actions, verifiers)
cairn export playwright flows/ --project --out-dir playwright-export

# Into an existing Playwright suite (no package.json / playwright.config)
cairn export playwright flows/ --into e2e/suites/cairn --config cairntrace.config.yml --env local

# Adapt to an existing host Playwright tree (read statically, never executed)
cairn export playwright flows/ --into e2e/tests/cairn --host-config e2e/playwright.config.ts

# Bind cairn actions to the host's own fixtures and page objects (export map)
cairn export playwright flows/ --into e2e/tests/cairn --host-config e2e/playwright.config.ts --map e2e/export.map.yml

# A named profile from the config's export.targets, with an eval-ratio gate
cairn export playwright --target ui --max-eval-ratio 0.25

# Host commands: run them inline, once in global-setup, or hand them to the host
cairn export playwright flows/ --project --out-dir playwright-export --preconditions inline
cairn export playwright flows/ --project --out-dir playwright-export --preconditions global --verifiers gate --gate-env MONGO_URI
cairn export playwright flows/ --project --out-dir playwright-export --preconditions manifest

# Is a committed export still in sync with its specs? (exit 0 fresh, 1 stale, 2 error)
cairn export playwright --check playwright-export --format json
```

MCP: `cairn_export_playwright` with `path` (optional with a `target` that names an
input), optional `out` / `outDir`, `lang`,
`stdout`, `project`, `into`, `config`, `env`, `var`, `preconditions`,
`verifiers`, `gateEnv`, `hostConfig`, `mapFile`, `target`, `maxEvalRatio`,
`allowEvalWithoutBypass`, `strictLocators`. It runs the same code
path as the CLI: `project` / `into` exports copy upload fixtures and write
`.cairn-export.json`, batch `outDir` exports write the README and manifest,
and specs that fail to export are listed under `errors`.

## Coverage report

Every export reports, per spec, what was translated and what was not:

- `skips` — every construct that was not exported. A **hard** skip marks the
  generated test `test.fixme` so it can never pass by omission: unreadable
  `eval.file` / browser `script.file`, inline `runtime: node` scripts, the
  `process` verifier (it asserts on `cairn run --monitor` samples) and
  `mongo` / `temporal` verifiers under `--verifiers keep`, an `xlsx`
  verifier in a single file (the workbook reader is a file of its own: use
  `--project`), a data verifier whose datasource is not an `http`
  datasource of the export environment, unresolved `use:`, and runtime splices
  or typed references with no binding (below).
- `diagnosticSkips` — the soft subset that only loses diagnostics
  (`snapshot`, `monitor`; in single-file mode also preconditions, which a
  single file does not run). They never mark a test `fixme`.
- `semanticRisks` — constructs that export but may behave differently from
  `cairn run`: `envBaked` (`${env.X}` / `${env.X:-default}` resolved to a
  literal at export time), `absolutePath` (machine-local paths in generated
  code), `requiredInfra` (preconditions that need docker, mongosh, psql,
  tmux, …), `requiredSetup` (preconditions a single file does not run),
  `unresolvedSplice`, `literalSplice` (a runtime ref in an outcome field that
  is compared as literal text, see below), `evalRatio` (share of opaque
  in-page `eval` steps), `secretInBrowser` (a secret passed into
  page-evaluated source or args), `envPolicy` (the environment whose
  baseUrl the export baked in refuses the spec, so the test always skips),
  `verifierGated` / `verifierDropped` (`--verifiers`, below),
  `transformInProcess` (a `transform` step's node module runs inside the
  Playwright test process, with the whole environment, instead of a filtered
  child process; its `ctx.vars` is empty),
  `mappedOrdering` (an [export map](#export-map) fixture or storageState
  runs before the test body, but the `use:` it replaces came after other
  steps), `mappedStorageState` (the test starts from an API login's
  storageState but takes its page from a `providesPage` host fixture, which
  may build its own context),
  `globalPreconditions` (`--preconditions global` runs commands once for the
  whole suite), `pollApproximated` (a `poll.stableMs` window the export
  emulates) and `teardownBestEffort` (an exported teardown runs in a
  `finally` that a test timeout or a failed `beforeAll` can skip).
- `fixme` — `true` when a hard skip made the test `test.fixme`.
- `evalRatio` — `{ evalSteps, totalSteps, ratio }`, present when the spec has a
  page `eval` step (see [`--max-eval-ratio`](#eval-ratio)); the markdown report
  prints it as `eval 2/3 (67%)`.

Coverage from an imported action is propagated into **every** test that
calls it, so a skipped step inside `actions/login.ts` shows up on each spec
that uses `login`. Markdown output lists skip reasons and risks per spec; read
`coverage` in `--format json` before treating a handoff as complete.

`eval.file` is read at export time and embedded (and, in `--project`, also
copied to `evals/` for review). External browser `script.file` verifiers are
read and embedded too; TypeScript files are transpiled with Bun. A relative
`eval.file` or `upload.path` resolves like a run: against the file that
declares the step — the spec, or the imported action's own directory. A
single-file export keeps the run's deprecated fallback to the spec's
directory for action steps; a `--project` action module resolves against the
action's directory only.

A spec's `requires:` becomes a run-time `test.skip(...)` guard on
`process.env.CAIRN_ENV` (plus any opt-in variable). When the export bakes an
environment's baseUrl, the guard accepts only that environment, since the
test drives its URLs; where the environment policy refuses the spec in that
environment the test always skips and the export reports `envPolicy`.

## Late-bound values never become literals

`${secrets.X}` and `${env.X}` emit as `process.env.X ?? ""` **whether or not
the variable is set while exporting** — no environment value reaches
generated code or the manifest. `${env.X:-default}` emits
`(process.env.X || "default")`: it is read, and falls back, when the test
runs, and an unset **or empty** variable falls back exactly like `cairn run`.
It is listed as optional env (the file header, the README), not as required,
and the default may itself hold `${run.token}` or other late-bound parts.
This covers a spec's own strings and its `vars:` **and the whole
`cairntrace.config.yml`**: the export loads the config late-bound, so a config
var, the environment `baseUrl` (`baseURL: (process.env.APP_URL ||
"http://localhost:3000")` in a project's `playwright.config.ts`), the
`auth:` block of `use: login` (also behind an export map `apiLogin`) and the
datasources keep every `${env.X}` / `${secrets.X}` as a read at run time, and
`--check` does not depend on the values set while exporting. A typed config
field the export emits (a viewport width, an `expectStatus`, …) cannot hold a
late-bound reference (`${env.X:-default}` included): the export refuses it
naming the field instead of writing the value (write a literal there). So do
the `browser.testIdAttribute`, `fieldRoot`, `widgets` and `appHandle` settings
(strings, but written into generated code as literals: the project config's
`use.testIdAttribute`, test id selectors, widget code), and a
spec field typed the same way that receives a late-bound var fails with the
names of those vars (pass the value with `--var` to export it as a literal). A field the export does not emit (a
`webServer.url: ${env.APP_URL:-…}`, a services port) never blocks it.
`${run.token}` emits a per-invocation `RUN_TOKEN`; a
reusable action's `${vars.X}` becomes a function parameter. Text needles
(`wait.text` / `wait.notText`, `when: text:` / `notText:`) are normalized
(whitespace-collapsed, lowercased) at export time only when they are pure
literals; a needle with a late-bound part is normalized **at run time**, and
`when:` text predicates pass the needle to `page.evaluate` as an argument.
`eval.js` sources are assembled in Node with the run token / secrets spliced
in before they are sent to the page.

As a safety net, every generated file is scanned for an internal
`__CAIRN_…__` placeholder. A hit refuses the export (exit 2) with a message
naming the file, line, spec, and step — a test that would type or match the
placeholder text literally is never written.

## Runtime splices (`${requests.…}`, `${evals.…}`, `${artifacts.…}`)

A `request` / `eval` / `download` step with `assign:` (and a network
`postcondition` with `assign:`) captures its value into a local binding when a
later step or outcome references it, and the reference becomes a
`cairnSplice(binding, path)` call that renders the value the way the runner
does (objects as JSON, missing values as `""`).

Splices are exported only where `cairn run` performs them: in step fields,
in script verifier `fixtures`, and in `httpJson.url` (`requests` and
`artifacts` only). The runner compares every other outcome field — text, url,
count, and network needles, `httpJson` matchers — against the raw `${…}`
text, so the export keeps that text literal too and reports a `literalSplice`
risk. Such an outcome usually means the spec expected a splice it never gets. The runner's default names are honored
(`request_<step number>` for an unassigned request, the slugged `saveAs` for an
unassigned download). Downloads are saved under Playwright's per-test output
directory at `cairn-run/downloads/<name>`, the same run-dir layout node
verifiers receive.

`${runs.<name>…}` (a `run:` step's `assign`, with `--preconditions inline|global`),
`${captures.<name>…}` (`capture` steps) and `${fixtures.<name>.<key>…}` (a
`--preconditions global` export) bind and render the same way, and are
spliced only in step fields (the runner splices them nowhere else in an
export: an outcome compares them as literal text, reported as `literalSplice`).

In `--project` mode an action function **returns** the values it captured
(`{ requests, evals, artifacts, runs, captures }`) and the calling test merges
the ones it splices. A splice that cannot be bound — its producer is a skipped
`transform`, runs later, or lives in a scope the reference cannot see —
becomes a `cairnUnresolvedSplice(...)` call that throws, a hard skip
(`test.fixme`), and an `unresolvedSplice` risk. A splice the runner
performs is never emitted as a raw `${…}` placeholder.

`request` steps executed through `page.request` are also pushed into the
exported test's network evidence, so `network` / `noFailedRequests` outcomes
see them the way `cairn run` does.

## Timeouts

Generated tests set an explicit timeout derived from the spec's sequential
step and outcome budgets: operations without an explicit limit reserve 30
seconds, separate node verifier `script.timeoutMs` values are added rather than
collapsed, and the exporter adds 10% headroom (at least one minute) under a
four-hour safety ceiling. A step with `postcondition.network` reserves the
longer of its action budget and the postcondition's `timeoutMs` (30 seconds by
default), so a slow upload response is never cut off by the test timeout. The
30-minute floor applies **only** to tests that emit a durable node
verifier — it follows what the export emits, so `--verifiers drop` (or no node
file verifier) means no floor — and a UI-only spec gets its derived budget so a
stuck step fails in minutes. An exported `run:` step adds its own timeout
(120 seconds by default), a `capture` its wait (5 seconds), an exported
teardown its items (capped by the teardown's `timeoutMs`), and a polled
outcome its poll window. In `--project` mode each file's `beforeAll` sets its
own timeout from its executable preconditions' `timeoutMs` (or 120 seconds
each), with the 30-minute floor only when a precondition is long (5 minutes
or more) and runs there; `playwright.config.*` uses the largest test or hook budget and sets
`actionTimeout` / `navigationTimeout` to 30 seconds, matching Cairntrace's
per-step default.

Without `--preconditions`, preconditions run in each test file's `beforeAll`
(`SKIP_PRECONDITIONS=1` skips them) and `global-setup.*` is a one-time suite
hook that only logs; see [Host commands](#host-commands-preconditions) for the
modes.
Documentary preconditions never run: a single `echo …` with no shell control
or substitution outside single quotes. `echo "resetting" && psql …` is an
executable command (and a `requiredSetup` risk in single-file exports). Each precondition keeps its
spec-relative `cwd`, its own `timeoutMs`, and layers authored
`preconditions.env` over a filtered child environment; the generated runner
strips publisher/TinyVault control credentials and kills the owned shell plus
descendants at the hard deadline. Single-file exports do not run
preconditions; they are listed in a header comment and as risks.

## Host commands: `--preconditions` {#host-commands-preconditions}

Everything that runs outside the browser — spec preconditions, `run:` steps,
the spec `teardown:`, config `fixtures:` and `preconditions.wait` gates — is
exported according to `--preconditions`:

| Mode | Preconditions | `run:` steps and `teardown:` | Fixtures and gates |
|------|---------------|-------------------------------|--------------------|
| *(no flag)* | standalone file: listed (soft skip); `--project` / `--into`: each file's `beforeAll` | not exported (hard skip / soft skip) | not exported |
| `inline` | each file's `beforeAll`, through the bounded helper | test body (teardown in a `finally`) | not exported |
| `global` | once, in `global-setup` (`--project` / `--into` only) | test body | `global-setup`: `cairn wait`, `cairn fixtures ensure` |
| `skip` | nothing runs (`requiredSetup` risk) | not exported | not exported |
| `manifest` | nothing runs; listed in `.cairn-export.json` for the host | not exported | not exported |

**The bounded helper** (`cairnCommand`, inlined in a standalone file, written
to `preconditions.ts` in a project) mirrors `cairn run`: a filtered child
environment (publisher / TinyVault control credentials stripped), a hard
deadline that kills the whole owned process tree, `/bin/sh -c` with `run.args`
as `$1…$n` — and a command that needs no shell (plain words and quotes, no
pipe, redirection, expansion, assignment or builtin) is spawned as an
argument vector. The command text comes from the spec; `${env.X}` /
`${secrets.X}` inside it stay `process.env` reads resolved when the test
runs, never baked into the file, and a command whose words hold one runs
through the shell, because `cairn run` substitutes the value into the command
text (an empty value drops the word, spaces split it, a glob expands). Errors
carry the output tail, never the command text, with every secret scrubbed
before the tail is cut: sensitive-named env (`*TOKEN*`, `*PASSWORD*`, …) and
the values of the `${env.X}` / `${secrets.X}` the command read. The helper
settles once the command's output is drained (500 ms after the exit at most,
when a grandchild keeps the pipes open), so the last stdout line of an
`assign` is never lost. `cwd` and a `run.node` script resolve through
`cairnProjectPath` (`CAIRN_PROJECT_ROOT`) in a project and relative to the
running spec file in a standalone export.

**`run:` steps.** `assign` parses the last non-empty stdout line as JSON and
binds it for later `${runs.<name>.<path>}` splices (same rendering as the
runner: objects as JSON, a missing path as `""`). The child sees
`CAIRN_RUN_TOKEN`, `CAIRN_BASE_URL` (the Playwright `baseURL`) and
`CAIRN_RUN_DIR`, plus `CAIRN_RUN_STATUS` in a teardown.

**`teardown:`** runs after the outcomes on every exit path of the test body,
each item in its own try/catch, within the teardown's `timeoutMs`. A failed
item is reported (a `teardown-failed` annotation and a warning) and keeps the
test's verdict, unless `failRun: true`, which fails a passing test after the
whole teardown ran. `CAIRN_RUN_STATUS` is `passed` or `failed`. A test
timeout, or a `beforeAll` precondition that fails (the test never starts),
can still skip it — cairn's early-stop and SIGINT teardown paths have no
Playwright equivalent.

**`global`** runs, once before the suite and in cairn's order: gates
(`cairn wait <gate>`), the preconditions, then each fixture the specs list
(`cairn fixtures ensure <name> --json`, with the spec's `with:`, then
`cairn fixtures reset` for `name.reset`). Fixture outputs go to a private
temp file named by `CAIRN_FIXTURES_FILE`; tests read them through
`cairnFixtureOutputs`, so `${fixtures.<name>.<key>}` becomes a splice and a
missing fixture or key throws (secret outputs are never in the file).
Run-scoped fixtures are torn down, and the file removed, when the suite ends
or the setup fails. This needs the `cairn` CLI (`CAIRN_BIN`, default `cairn`
on PATH) and the source project (`CAIRN_PROJECT_ROOT`). It runs the commands
once for the whole suite, not before each spec — a fixture stays live for
every spec, so another spec can see its data; each affected test carries a
`globalPreconditions` risk. `--into` writes `global-setup` too: register it in
the host config's `globalSetup`.

**`manifest`** lists the commands in `.cairn-export.json`, and `--check` flags a
changed command as stale:

```json
{
  "source": { "preconditions": "manifest", "projectRoot": "../flows" },
  "preconditions": [
    {
      "spec": "../flows/login.yml",
      "name": "reset",
      "run": "deploy --token ${env.API_TOKEN} | cat",
      "cwd": ".",
      "timeoutMs": 120000,
      "envKeys": ["TOKEN"]
    }
  ]
}
```

`run` is the authored text with `${env.X}` placeholders (never values), run
through `/bin/sh -c` from `cwd` (relative to `source.projectRoot`).
`--stdout` and a single `--out` file cannot carry a manifest, and `global`
needs a project: both exit 2.

## Node and datasource verifiers: `--verifiers`

| Mode | Node file verifier, `http` | `mongo` / `temporal` and inline node scripts |
|------|-----------------------------|-----------------------------------------------|
| `keep` (default) | runs (an `http` datasource whose env is missing at run time fails with a clear message) | hard skip (`test.fixme`) |
| `gate` | runs only when its required env is set | recorded as skipped at run time |
| `drop` | omitted | omitted |

`gate` never lets a missing dependency pass: the required env is the env the
verifier's `fixtures:` read (`${secrets.X}`, `${env.X}`), the env its config
datasource references, plus every `--gate-env NAME[,NAME]`. When it is missing
the verifier is recorded and the test ends with
`test.skip(cairnSkipped.length > 0, …)` — **after** every other assertion held
and after the teardown, so a real failure still fails and a test that could
not verify everything is reported skipped, never passed. A verifier that
cannot run in an export at all (`mongo` / `temporal` datasources, inline node
scripts) is always recorded as skipped, instead of marking the whole test `test.fixme`.
A node verifier whose env is unknown runs unconditionally; name its env with
`--gate-env`. `drop` omits them with a `verifierDropped` risk: the test can
pass without them.

## Captures, tables and polling

`capture` steps (`text`, `value`, `attribute`, `table`) export as
`cairnCapture`: the same in-page probe `cairn run` reads (locators with
late-bound parts travel as run-time data), retried every 250 ms for the
step's `timeoutMs` (default 5 seconds), with the same single-target rule and
table shaping, binding `${captures.<assign>…}` for later steps
(`lib/probe` in `--project`). A verifier `poll: { timeoutMs, everyMs }` exports
as `expect(async () => { … }).toPass({ timeout, intervals: [everyMs] })`; with
`stableMs` it exports as `cairnPoll` (green must hold for the window over at
least two samples; a red sample restarts it, like the runner) and is flagged
`pollApproximated`. Each sample checks once, like the runner's: the
assertions inside it go through `expect.configure({ timeout: 1 })`, because a
web-first assertion would wait a red sample out and report a flapping state
as stable. The `table` verifier reads the rendered table through the
same probe (`cairnReadTable`, waiting up to its `timeoutMs`) and runs the
runner's row-count, blank-row, header and required-row checks
(`cairnJudgeTable`). Outcome-level `network.assign` is exported with the
`network` verifier's body / count support (below), so later `value` / `http`
outcomes can read `${network.<assign>…}`.

## Data verifiers: `value`, `http`, `network` body / count, `file`, `xlsx`, `expect.request`

These judge data rather than the page, and they export with the runner's own
code rather than a re-implementation:

- **The judging modules are the runner's source.** `matchers` (every
  matcher: `equals`, `contains`, `matches`, `oneOf`, `atLeast`, `atMost`,
  `exists`, `empty`, `each` / `all`, `ignoreCase`, JSONPath-style paths with
  wildcards and filters), `refs` (the `${…}` resolver), `networkJudge`,
  `responseJudge`, `httpWire` (URL joining, credentials, reply shaping and the
  redirect policy), `httpJsonMatch`, `fileWait` and `xlsxJudge` are
  emitted from `src/core/runner/verifiers/*` and `src/core/datasources/*`: a
  project writes them as `lib/runtime/<name>.ts|js`, a single file inlines the
  ones it calls. The checked-in copy (`runtimeSources.generated.ts`) is regenerated
  by a test (`CAIRN_UPDATE_GENERATED=1 bun run test
  src/core/exporters/runtimeSources.test.ts`) that fails when a runner module
  changes without it, and
  `playwrightRuntimeData*.test.ts` runs the generated JavaScript against the
  runner (matcher by matcher, reference by reference, and every exported
  verifier over real servers and workbooks).
- **Typed references.** `value`, `http`, `network.body.json`, `xlsx`
  checks and `expect.request` resolve `${requests|evals|captures|network|fixtures|runs|artifacts.…}`
  the way the runner does: a whole reference keeps its type, an unresolved one
  fails the check (`value actual: unresolved ${captures.x}`). The bindings are
  the ones the exported steps produced; one with no producer in the export is
  an `unresolvedSplice` hard skip naming it, and `${run.startedAt}` has no
  export. These operands are resolved, not "compared as literal text", so they
  do not raise `literalSplice`.
- **`value`** → `cairnRefs` + `cairnAssertValue` (`file:` sources read the JSON or
  text file; artifact paths resolve against the run directory like the runner).
- **`http`** → Playwright's `APIRequestContext` (no browser cookies, like the
  runner's Node-side client), with the runner's header, body, content-type,
  redirect (same origin keeps headers; cross origin drops them and never
  re-sends a body), size and error rules, and `assign` →
  `${captures.<assign>.status|body}`. A `source:` datasource
  (`kind: http`) is baked as its `baseUrl` / header names and **`${secrets.X}`
  / `${env.X}` as `process.env` reads when the test runs** (never a value, and
  unlike the rest of the config a set `${env.X}` in a datasource is not baked
  while exporting; a `:-default` is honored at run time; a
  missing one fails with `datasource <name>: ${secrets.X} is not set`, or the
  test is reported skipped under `--verifiers gate`, whose required env is the
  datasource's). An inline URL needs an absolute URL or Playwright's `baseURL`.
  Transport errors are scrubbed of the datasource's credentials.
- **`httpJson`** keeps the browser-session fetch; its verdict (`equals`,
  `contains`, `matches`, `atLeast`, `atMost`, `exists`) is now the runner's own.
- **`network` with `body` / `count` / `assign`** judges a richer request log
  (`cairnTrackRequests`: every request with its body, kept in memory only, plus
  the status and start time), including `request` steps' calls with their bodies,
  through the runner's `judgeNetwork`. A plain `network` outcome keeps the
  response log.
- **`noFailedRequests`** is judged by the runner's own `judgeNoFailedRequests`
  over the same request log, which records network-level failures too
  (`requestfailed`: aborted, blocked, DNS, connection refused; a request that
  finished without a response): a 4xx/5xx status **or** such an error fails it,
  exactly like `cairn run`. A spec with one judges every `network` outcome
  through `judgeNetwork` as well. A judged request that has neither a status
  nor an error yet is waited for (at most 2 s), like the runner's end-of-steps
  snapshot.
- **`file`** waits for the glob like the runner (filename wildcards only);
  **`xlsx`** reads the workbook with the SDK's own reader (`lib/runtime/workbook.js`,
  plus its `.d.ts` for TypeScript) and runs every check; it needs `--project`.
- **`expect.request`** sends the call through `page.request` (the browser
  session's cookies) and checks status / JSON paths; a GET / HEAD is retried every
  250 ms for the step's `timeoutMs`, a write never is.
- **`transform`** copies the step's node module next to the project (like a node
  verifier) and runs its `transform(ctx)` (named export or default) in the test
  process with the runner's `ctx`; the file it writes is bound as
  `${artifacts.<assign>…}` and the call is flagged `transformInProcess`.

An action with `postcondition.network` exports as a
`page.waitForResponse(...)` promise created before the action, followed by the
single mutation and `await` of that response. This ordering also covers
`setInputFiles`, so fast upload responses cannot be missed and a timeout never
repeats the upload.

## `--project` mode

`--project` actions are parameterized: declared `vars:` on a reusable
action become `fn(page, vars?)` arguments, and `use: { action, vars }`
emits a call instead of inlining the expanded steps. Shared runtime
(`lib/hydration.ts`, `lib/clickUntil.ts`, `lib/verifier.ts`,
`lib/networkEvidence.ts`, `lib/splice.ts`, `lib/fixtures.ts`,
`lib/projectRoot.ts`) is imported once instead of being copied into every
spec, and each file imports only the helpers it uses. Request v2 steps and
`use: login` import from `lib/request.ts`; `use: login` also imports
`CAIRN_AUTH` from `lib/auth.ts` (the export environment's `auth:` block with
every `${secrets.X}` as a `process.env` read).

To sign in once per run instead of once per test, save the same login as a
Playwright `storageState` from `globalSetup` (or a setup project) and point
`use.storageState` at it — the request context never sees a page, so the
credentials never reach `page.evaluate` (`hydrate` needs a page and runs only
in `cairnLogin`):

```ts
// auth-state.ts — call it from your globalSetup
import { cairnLoginState } from "./lib/request";
import { CAIRN_AUTH } from "./lib/auth";

export async function saveLoginState(): Promise<void> {
  await cairnLoginState(CAIRN_AUTH, {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    path: ".auth/state.json",
  });
}
```

Structured TypeScript projects are directly installable and typecheckable:

```bash
cd playwright-export
npm install
npx playwright install chromium
npm run typecheck
npm test
```

The generated `tsconfig.json` keeps strict checking enabled, includes DOM and
Node types, and permits explicit `.ts` imports used by portable verifier
modules; the exporter's own CI also compiles generated projects with
`noUnusedLocals`. Inline page evals remain JavaScript inputs at runtime instead
of being misinterpreted as generated TypeScript. Node verifier modules are
copied with their bounded static relative dependency closure; imports that
escape the verifier directory, symlinks, unsupported extensions, oversized
graphs, and destination collisions fail export.

### Relocatable exports

- Upload files referenced by a relative (spec- or action-relative) or absolute `upload.path` are
  copied into `fixtures/` and read through `cairnFixturePath(name)`, so the
  export does not depend on the source tree's layout. Copies are bounded like
  verifier copies: only a regular file (not a symlink) inside the project
  root, at most 10 MiB. Anything else keeps its absolute path and is reported
  as an `absolutePath` risk that says why it was not copied.
- The project root is the directory of `cairntrace.config.yml`, or the export
  input directory when there is no config.
- Precondition `cwd` and the `specDir` handed to node verifiers resolve
  through `lib/projectRoot`, relative to the **export root** (computed on real
  paths at export time) — never a baked absolute path.
  `CAIRN_PROJECT_ROOT` overrides it after a move. When the resolved root (or a
  precondition `cwd`) does not exist, the hook fails fast with a message that
  says to set `CAIRN_PROJECT_ROOT`, instead of a confusing
  `spawn /bin/bash ENOENT`.

### Manifest

`--project`, `--into`, and batch `--out-dir` CLI exports write
`.cairn-export.json` in the export root:

```json
{
  "version": 1,
  "exporterVersion": "x.y.z",
  "generatedAt": "2026-10-01T12:00:00.000Z",
  "mode": "project",
  "lang": "ts",
  "source": { "input": "../flows", "varKeys": [] },
  "specs": [
    {
      "spec": "../flows/login.yml",
      "contractHash": "sha256:…",
      "testFile": "tests/login.spec.ts",
      "sourceDigest": "sha256:…"
    }
  ],
  "files": [{ "path": "tests/login.spec.ts", "sha256": "…" }]
}
```

`source` also records what `--check` and `--verify` need to regenerate the same
export: `preconditions`, `verifiers`, `gateEnv`, `hostConfig` (the host
Playwright config, relative to the export root), `target`, `maxEvalRatio`,
`allowEvalWithoutBypass`, `strictLocators` and `verifyProject` (the host project `--verify` runs
under), each only when it was used. `map` is the
[export map](#export-map) (`{ file, digest }`: its path relative to the export
root and a digest of its parsed content, so comments and key order do not move
it).

Paths are relative to the export root, and `sourceDigest` hashes the content
of the spec and of every imported action (by action name, never by absolute
path), so the manifest is identical in a fresh clone or after moving the tree.
`--var` values are never recorded — only their names and a digest.
`generatedAt` is kept when a re-export changes nothing else, so re-exporting
unchanged sources leaves a committed manifest byte-identical.

### `--check`

```bash
cairn export playwright --check playwright-export --format json
cairn export playwright flows/ --check playwright-export   # override the recorded input
```

`--check <exportDir>` reads the manifest, regenerates the export **in memory**
from the current sources (the recorded `source.input`, `config` and `env`
unless you pass a spec/dir, `--config` or `--env`), and compares it with the
files on disk. It writes nothing. The report lists `stale` (content differs
from a fresh export), `missing`, `orphaned` (recorded but no longer
generated) and `modified` (hand-edited since the export) files, plus a status
per spec (`fresh`, `changed`, `new`, `removed`). A spec whose YAML changed
only in comments stays fresh. Pass the same `--var` values the export used;
the check warns when they differ.

Exit codes: `0` fresh, `1` stale, `2` error (no or unreadable manifest, or
regeneration failed). Use it in CI to fail a pull request whose committed
export was not regenerated.

### `--verify` {#verify}

`--check` says the export matches its specs. `--verify` says it is also
**faithful**: it compiles, it is listed, and it judges the app the way
`cairn run` does.

```bash
cairn export playwright --verify playwright-export            # static gates
cairn export playwright --verify playwright-export --differential --mutate
cairn export playwright flows/ --project --out-dir playwright-export --verify
```

`--verify <dir>` verifies a directory. A bare `--verify` verifies the export
the same command just wrote; that export's own report goes to stderr, so stdout
carries the verify report alone. `--verify=differential` is the same as
`--differential`.

**Static gates** need no browser. Each is `passed`, `failed` or `skipped`
with a reason, and a skipped gate is never counted as a pass.

| Gate | Passes when | Skipped when |
|------|-------------|--------------|
| `sentinels` | no `__CAIRN_*__` placeholder is left in any exported file | never |
| `freshness` | regenerating from the sources reproduces every file (`--check`) | the sources cannot be read |
| `typecheck` | `tsc` with the target's own tsconfig finds no error in export files. A generated project is also held to `noUnusedLocals`; a host tsconfig (the one the host profile names, else the nearest) is used as is, export files it does not include are compiled with a strict fallback, and errors in host files are not the export's | `--lang js`, no local `tsc`, or that `tsc` rejects the tsconfig itself (an option error such as `TS5095` makes tsc skip the type check, which would otherwise read as a pass) |
| `lint` | the host's eslint reports no error for export files (warnings do not fail). The vendored runtime (`lib/` except `lib/pages/`, the command helper, the global setup: copies of the runner's modules with an `eslint-disable` banner) is not handed to eslint; the summary counts it | no eslint config above the export, no local `eslint`, or eslint printed no JSON |
| `list` | `playwright test --list` (with the host config the manifest names, when there is one; on a multi-project config with `--project <the verify project>`) shows exactly one test per exported spec; `test.fixme` skips are counted and reported | a standalone `--out-dir` export, no Playwright config, or no local `playwright` |

The tools are the target's own local binaries, found by walking up from the
export (`node_modules/.bin`). Verify never installs anything.

**Multi-project hosts.** A config with several `projects` — the
`npm init playwright` chromium / firefox / webkit trio, devices with a setup
project and `dependencies` — lists every test once per project that
discovers it, and an unfiltered run would run every browser. Every Playwright
run of the verify (the list gate, the differential, the mutants) uses one
project, passed as `--project`; Playwright still runs that project's
`dependencies` (a setup project included), and a dependency that fails makes
the spec an `error` naming it. The project is `--verify-project <name>` (MCP
`verifyProject`), else the one the manifest recorded at export time
(`--verify-project` given then, or the target's `verifyProject`), else the
first project in config order, among those that discover the most exported
tests, that runs Chromium (`use.browserName` / a device's browser, read
statically), else whose name says Chromium, else the first. The report's
`playwrightProject` has the name, its source (`flag` | `manifest` |
`auto`), why, every project and the ones that discover the tests. A name the
config does not have is exit 2.

```bash
cairn export playwright --verify e2e/tests/cairn --verify-project firefox
```

**`--differential`** needs the app running (it is checked at the export's
`baseURL`). For each exported spec it runs `cairn run --backend playwright`
and then the exported test with the **same** `CAIRN_RUN_TOKEN` (pinned on
the runner side with `cairn run --run-token <token>`, MCP `runToken`: 1-64 of
letters, digits, `_`, `.`, `-`, so `${run.token}` writes the same unique values
on both sides) and the same `--env`, `--config`, `--var`, one after the other
and one browser at a time, and compares:

- the verdict of each outcome and of each step with a unique id (an exported
  step is its `test.step` title, which is the spec's step id; steps that come
  from an imported action repeat ids and are not compared);
- the requests each `network` / `noFailedRequests` outcome matched. Zero on
  one side only is a mismatch; both matching with different counts is a
  warning;
- the duration (`--duration-ratio`, default 3). It warns only when the gap is
  at least two seconds, so browser start-up is not a finding.

A spec whose `cairn run` baseline did not pass is `inconclusive` when the
export agrees with it (both failed: the app or the spec is unhealthy, which
proves nothing), never a match; a disagreement is a `mismatch`. `test.fixme`
and gated exports are `skipped`. A gated export runs everything else before it
ends skipped, so the steps and outcomes it did judge are compared first: one
that disagrees with `cairn run` (the runner failed an outcome the export
passed, or the reverse) is a `mismatch`, never hidden behind the skip. If
nothing disagrees and `cairn run` failed, the spec is `inconclusive` with a
warning, since the skipped export would not report that failure.

Both sides run, so a spec
that changes shared state has to be idempotent, or reset by its preconditions
and `teardown:`; the export side runs whatever `--preconditions` exported.
With `skip` or `manifest` it runs none, and only the `cairn run` side's own
preconditions prepared the app. `--verify-only <text>` limits the runs to the
specs whose path or test file contains the text.

**`--mutate`** inverts one assertion of one outcome per spec
(`--mutate=all`: every outcome) in a temporary copy next to the exported test
and runs the copy. It must fail at that outcome (`killed`). A copy that still
passes (`survived`) is an *assertion not effective* finding: the check is not
awaited, swallowed, or never reached. An outcome judged by a helper that throws
has no matcher to invert and is `not-applicable`. The outcome steps are read
from the test's TypeScript syntax tree and matched to the source spec's
outcome ids, so a host's prettier (single quotes, a call broken over lines)
changes nothing. Every verify first removes a mutant copy an interrupted
`--mutate` left behind (and says so in `warnings`), so it is never listed or
run as part of the suite.

The report is `urn:cairntrace.dev:export-verify:v1` (JSON, YAML or Markdown on
stdout). It is also written to `.cairn-export-verify.json` and `.md` in the
export, and `.cairn-export.json` gets a `verify` summary. A re-export keeps the
summary only while the exported files are identical. MCP: `cairn_export_verify`.

Exit codes: `0` every requested gate, differential and mutation passed, `1` a
gate, a differential spec or a mutant failed, `2` usage or environment error
(no manifest, the app is unreachable, no local Playwright for a differential, an
unknown `--verify-project`, a side could not run), `3` **inconclusive**: what was requested proved nothing —
neither the typecheck nor the `playwright test --list` gate ran (no local
`tsc` / Playwright next to the export), the differential matched no spec, or
no mutant was killed or survived. The report's `status` is then
`inconclusive`, never `passed`. `--verify-strict` makes anything skipped or
inconclusive a `1`. A file the host's eslint config ignores (or that no config
entry matches) was not linted: the lint gate is then `skipped`, listing the
files, never a clean pass. A `tsc` that crashed (a non-zero exit without a
single diagnostic), timed out or rejected its options checked nothing: the
typecheck gate is `skipped`. When the export itself exited non-zero (a spec
refused by `--max-eval-ratio`), the more severe code wins: `2` over `1` over
`3` over `0`.

## Host profiles: `--into <dir> --host-config <playwright.config>` {#host-profiles}

`--into` writes into a tree you already own. `--host-config` makes the
generated code fit that tree instead of the other way round. The host's
`playwright.config`, its `tsconfig` (with its `extends` chain) and its
nearest `package.json` are **read, never executed**: the config is parsed to a
syntax tree and only literal-shaped values are evaluated (strings, numbers,
booleans, regexes, objects, arrays, `const`s, relative imports of other config
modules such as a shared `playwright.base.ts`, `__dirname` /
`import.meta.dirname`, `path.join` / `path.resolve` / `path.dirname`,
template strings, arithmetic such as `30 * 1000`, `process.env.X ||
"fallback"`, `a ?? b` / `a || b` with JavaScript truthiness, `defineConfig(a,
b)` merged the way Playwright merges it, `module.exports =`). A device —
spread (`...devices["Desktop Chrome"]`) or bare (`use: devices["Pixel 5"]`) —
is known to set none of the options read here; only its browser is read
(from the host's playwright-core, else the device name), for `--verify` to
prefer a Chromium project.

Options resolve **the way Playwright resolves them**: a project's own value wins
over the top level (`timeout`, `testDir`, `testMatch`, `testIgnore`;
`use` merged key by key; `expect` taken whole from the project when it has
one), and only the projects whose `testDir` / `testMatch` / `testIgnore`
discover the generated tests count (a `setup` project that matches
`/setup\.ts/` does not). `testMatch` is matched like Playwright's own file
matcher: a regex against the absolute file path, a glob prefixed with `**/`
(Playwright's bundled minimatch, the host's when it has one).

Anything the export cannot read — a computed value (`process.env.CI ? 90_000 :
30_000`), a spread or a `defineConfig` argument it cannot follow (a package
import, a call), an option the running projects disagree on — is **named**:
the report's `host.unread` lists the options and `host.notes` says which
expression and what the export did instead. It never falls back to a default
as if the host had said so; the conservative path per option is in the table.
The `typescript` package is the host's own when it exposes the JavaScript API
(`createSourceFile`), else cairntrace's own (a runtime dependency); a
TypeScript without the API (the native TypeScript 7 compiler) is skipped and
named when nothing else is left.

| The host says | The export does |
|---------------|-----------------|
| module system: `"type": "module"` (nearest `package.json`) or not | CommonJS: generated modules find their directory with `__dirname`. ESM: `import.meta.url`. This also fixes `lib/projectRoot` and `lib/fixtures` in a CommonJS host. Under `moduleResolution: node16 / nodenext` in an ES module package, relative imports end in `.js` |
| `timeout` (default 30s) | a test only calls `test.setTimeout(...)` when its derived budget is higher than the host's, with a comment saying so; when the host's covers it, nothing is emitted. The same rule applies to a precondition hook. **Not readable** (or the running projects disagree): every test sets its own derived budget, as without a host |
| `use.testIdAttribute` | `testid` locators use `getByTestId` when the host reads the attribute the spec means (the config's `browser.testIdAttribute`, default `data-testid`); when it reads another one they are emitted as explicit attribute selectors (`[data-qa="x"]`, a run-time value CSS-escaped), so they keep matching. `process.env.X ?? "data-qa"` uses the literal fallback and says so. **Not readable**: every `testid` locator is an explicit attribute selector |
| `use.bypassCSP` | the export contains page evals (`eval` steps, `wait: { app }` checks, browser `script` outcomes, inside actions and teardown too: each string-evaluates in the page) and the projects that run the tests do not all set `bypassCSP: true`: the export is **refused** (exit 2) naming them, unless `--allow-eval-without-bypass`. **Not readable** or disagreeing counts as not set, and the message says so. An exported `wait: { app }` blocked by a CSP at run time fails at once naming the CSP instead of polling to a timeout |
| `testDir`, `testMatch`, `testIgnore` | tests are placed so the host discovers them: flat in the `--into` folder when it is inside a project's `testDir`, in the `testDir` subfolder when `testDir` is inside `--into`; an `--into` the host would never discover is an error. Files are named `<name>.spec.ts`, or `.test` / `.e2e` when only that matches `testMatch`. **Not readable** (or `projects` not readable): the export is **refused** (exit 2) — discovery cannot be checked; write it statically or export without `--host-config` |
| `use.storageState` | the projects that run the tests start signed in: a `coldStart: guest` spec gets `test.use({ storageState: { cookies: [], origins: [] } })` so it starts signed out (also when the value is not readable) |
| tsconfig `paths` | generated modules import each other through a wildcard alias that covers the export folder (`@e2e/tests/cairn/lib/probe`) instead of `../../lib/probe` |
| prettier config + a local `node_modules/.bin/prettier` | every text file the export writes (the verifier / eval copies too) goes through `prettier --stdin-filepath <final path>`, run until stable, so the host's `prettier --check` passes and `--check` / `--verify` regenerate the same text. Without a local binary files stay as generated, with a note: cairn never installs a formatter |
| tsconfig `module: nodenext` / `node16` without `moduleResolution` | the resolution TypeScript implies (`nodenext` / `node16`) counts, so relative imports in an ES module package still end in `.js` |
| an eslint config | vendored runtime files (`lib/`, `preconditions.*`, `global-setup.*`) start with an `eslint-disable` banner (they are the runner's own modules); tests and actions are not exempted: braces on every `if`, only used imports, ordered imports (packages first, then relative paths, each alphabetical), camelCase identifiers with an alias suffix when two names collapse to the same one |

```bash
cairn export playwright flows/ --into e2e/tests/cairn \
  --host-config e2e/playwright.config.ts --verify
```

**What runs on your machine.** The host's config is never executed, but
`--host-config` (and `--check` / `--verify` on an export made with it) **runs
the host's own local tools**: its `node_modules/.bin/prettier` with its config
— which loads a JavaScript prettier config and its plugins — and, under
`--verify`, its local `eslint` (a JavaScript `eslint.config.*` and its plugins),
`tsc` and `playwright test --list` (which loads the host's Playwright config
and fixtures). Configs and binaries are looked up from the export folder upward
only to the host's boundary — the nearest folder with `.git`, else the
outermost package root below your home directory — so a stray `~/.prettierrc`
or a binary above the host is never picked up. Only export into trees whose
tooling you would run yourself.

The report (and `--format json`) carries a `host` object: the config
(relative to the export), module system and why, the test timeout and test id
attribute of the projects that run the tests (absent when not readable), those
`projects`, the options that could not be read (`unread`), where tests live,
whether `bypassCSP` is set, the alias, files prettier rewrote or left, the
`baseURL` the host resolves to, and notes (projects that disagree, a tsconfig
that does not match `package.json`, each option that was not readable and what
the export did instead). The manifest records `source.hostConfig`
(relative to the export), so `--check` and `--verify` regenerate with the same
profile; `--verify` then type-checks with the tsconfig the profile names, lints
with the host's eslint and lists with `playwright test --list --config <host
config>`. A host that changes (a new prettier, another timeout) shows up as
stale files, not as silently different ones.

Add `.cairn-export.json` and `.cairn-export-verify.*` to the host's
`.prettierignore` (and the verify report to `.gitignore`) when it checks the
whole tree.

## Export map: `--map export.map.yml` {#export-map}

An exported test inlines every action it `use:`s. A host suite usually has its
own way to do the same: a login **fixture** (`test.extend({ memberSession })`),
**page objects** over a base page. `--map` (profile: `mapFile`, MCP:
`mapFile`) binds cairn actions to those constructs, so the exported test is the
test the host's team would have written. It needs `--into` (or `--project`);
standalone files have no `actions/` to bind.

```yaml
# export.map.yml — data, never executed. Imports are module specifiers (a package
# or a tsconfig alias, used as written) or `./relative` paths, relative to this file.
version: 1
strict: false                   # true: an action a spec uses with no mapping is an error
test: { import: ./fixtures }    # the module that exports the host's extended `test`
basePage:                       # the class generated page objects extend
  import: ./pom/base-page
  name: BasePage
  pageProperty: page            # the base class's Page property (default page)
actions:
  login:                        # a list picks by `when`; the last may have none
    - when: { var: role, equals: admin }
      fixture: { name: adminSession }
    - note: the host's session fixture signs the member in
      fixture:
        name: memberSession
        type: "{ user: string }"        # for the report and a comment
        providesPage: false             # true: `{ memberPage: page }`
        vars:
          role: { const: member }       # checked against the call, not exported
          tenant: { option: tenant }    # becomes test.use({ tenant: … })
          debug: { ignore: true }
  open_order:
    method:
      import: ./pom/orders-page
      class: OrdersPage
      call: openOrder
      args: [{ var: orderId }, { var: tab, default: summary }, { const: true }]
      instance: { fixture: ordersPage }  # optional: the host's instance, not new OrdersPage(page)
      ignoreVars: [debug]
  sign_in_api:
    apiLogin:                            # a request-only login → storageState (below)
      storageState: .auth/member.json    # default .auth/<action>.json
      setupProject: setup                # optional: the host's project writes it
  pick_filter:
    generate: { class: OrdersFlowPage, method: pickFilter }   # naming only
```

What each mapping does to the generated test:

| Mapping | Result |
|---------|--------|
| `fixture` | the test signature takes the fixture (`async ({ page, memberSession }) =>`), `test` comes from the map's `test.import`, and the action's steps are **not** emitted. A fixture the body never reads is kept alive with `void memberSession;` (`noUnusedParameters` / `no-unused-vars`). Every var the call *passes* needs a rule: `option` sets `test.use({ <option>: value })` with the call's value — or the action's default when the call passes none, since the host fixture's own default may differ —, `const` must equal the call's value (a mismatch is an error naming both), `ignore` drops it. `providesPage` destructures `{ adminPage: page }` so the steps run in the page the fixture hands out |
| `method` | `await new OrdersPage(page).openOrder("2002", "details");` (or `await ordersPage.openOrder(…)` with `instance`, which needs the same `test` as the spec's fixtures — two different `test` modules in one spec are an error), the host module imported through the host's alias / relative path / `.js` extension (in an ES module host a barrel is imported as `…/index.js`, `.mts` / `.cts` as `.mjs` / `.cjs`). `args` take action vars (the call's value, else the spec's, else the action's default) or constants; a var the call passes that no argument takes is an error unless listed in `ignoreVars` |
| `apiLogin` | see below |
| `generate` | the same page object an unmapped action gets, with the class and method names you chose; actions that name one class share its file |
| none (unmapped) | **not strict**: a generated page object (below). **strict**: an error listing every unmapped action a spec uses |

A fixture and an `apiLogin` run **before the test body**. That is exactly what
the `use:` step meant when it was the first step; used later, the export still
writes it but reports a `mappedOrdering` risk (what ran before it now runs
signed in). A fixture-bound or `apiLogin` action cannot be nested in another
action or a `repeat` / `if` / `retry` block, nor carry `when:`: those are
errors that suggest a `method` mapping.

**Unmapped actions** become generated page objects under `lib/pages/`: one class
per action (`PickFilterPage` with a `pickFilter()` method, the steps inside;
a derived name that is already a host class the map imports — the base page or
a `method` class — gets a number, `OrdersPage2`, and a `generate.class` that
is one is an error),
extending the map's `basePage` (imported from the host) or a minimal generated
`lib/pages/base-page`. The call site is `await new PickFilterPage(page).pickFilter({ … })`.
Vars the action never reads are not parameters (a declared-but-unused var would
fail the host's `noUnusedLocals`). Nested actions call each other the same way;
a mapped one inside a page object is its `method` call. Page objects are code
written for the host's style rules: the host's prettier formats them and its
lint rules apply (only `lib/`'s vendored runtime files carry the
`eslint-disable` banner).

### API login as a storageState

An action whose steps are all plain `request` steps (no `matrix` / `until`, no
`credentials: omit`), whose name says it signs in (`login`, `log_in`, `signin`,
`sign_in`, `authenticate` as a word; never one that says `logout`, `revoke`,
`delete`, `refresh`, `reset` …) and that no real step precedes (only `use:`
steps the map hoists before the test body) is exported without a mapping as a
**storageState**. Anything else stays where it is (a page object): an
explicit `apiLogin` mapping does it for any request-only action (and says why
when it cannot). The first request is the login, the rest follow it in the same
request context, so a captured token reaches the next request
(`${requests.<assign>.captures.token}`).

- `lib/authState` holds one `CairnAuth` per login and signs in with
  `request.newContext` and saves the session under `<export>/.auth/`
  owner-only (`0600`, the folder `0700`) and atomically (a temp file renamed
  over it, so a worker never reads a half-written state); `.auth/.gitignore`
  keeps the saved sessions out of version control, and a `storageState` path
  outside `.auth/` is an error. The test gets
  `test.use({ storageState: cairnStatePath("sign_in_api") })`. When its page
  comes from a `providesPage` fixture, the export reports a
  `mappedStorageState` risk: a fixture that builds its own context
  (`browser.newContext()`) never sees that storageState.
- Credentials are read from `process.env` **when the sign-in runs** (a missing
  required one fails with its name before anything is sent). They are never in
  generated code, the manifest, the report or the saved state, and never go
  through `page.evaluate`. A login that needs the page (`hydrate`, filling a
  form) is not an API login.
- Default and `--preconditions inline|skip|manifest`: the test file signs in
  once per process in a `test.beforeAll` (`testInfo.project.use.baseURL` is the
  base URL). `--preconditions global`: the generated `global-setup` signs in once
  for the suite (register it in the host config, like the other global work).
- `setupProject: setup` points at a project the host already has (checked
  against the host config's `projects`): the test only gets
  `test.use({ storageState: "<path>" })` and nothing is generated.
- Values the action captured are not available to the test body; a spec that
  splices one is reported as an `unresolvedSplice`.

### Report, manifest, check, verify

The report (and `--format json`) carries `map: { file, digest, strict, actions }`
(each action: `treatment` fixture | method | storageState | generated, `target`,
`specs`, `note`) and each spec lists its own `mapped` entries; the README has an
Export map section. The manifest's `source.map` records the file (relative to the
export root) and a digest of its parsed content, so `--check` regenerates with
the same map and warns when the map changed; a changed map that changes the
output makes the files stale, and a missing map is an error (exit 2).
`--verify` works on mapped exports as on any other: the host's own `tsc` checks
the fixture names, page-object methods and argument types against the host's
real types (a fixture that does not exist is a typecheck failure), its eslint
lints the page objects, and `playwright test --list` loads the host's fixtures
module.

## Export targets: `export.targets` and `--target` {#export-targets}

A profile keeps the flags of one handoff in the project's config:

```yaml
# cairntrace.config.yml
export:
  targets:
    ui:
      input: flows                          # used when no path is given
      into: ../e2e/tests/cairn              # relative to this file
      hostConfig: ../e2e/playwright.config.ts
      preconditions: inline
      verifiers: gate
      gateEnv: [MONGO_URI]
      lang: ts
      env: local
      maxEvalRatio: 0.25
      allowEvalWithoutBypass: false
      mapFile: ../e2e/export.map.yml        # the export map (needs into)
      verifyProject: chromium               # the host project --verify runs under
```

```bash
cairn export playwright --target ui                 # the profile as written
cairn export playwright --target ui --max-eval-ratio 0.5   # a flag overrides the field
```

The config is `--config`, else the nearest `cairntrace.config.yml` above the
path (or the working directory). `cairn config validate` checks every target
as an export request on its own: the modes combine, `input` and `hostConfig`
exist, `hostConfig` comes with `into`, the host config reads statically and its
`testDir` / `testMatch` find the tree, and `maxEvalRatio` is between 0 and 1;
`mapFile` exists, parses and names files for its relative imports; the
result lists the targets under `exportTargets`. The manifest records the
`target`, `maxEvalRatio`, `allowEvalWithoutBypass`, `strictLocators` and `verifyProject` next
to the flags it already records; `verifyProject` (also `--verify-project`
on the export command) is the host Playwright project a later `--verify`
lists, runs and mutates under (see [Multi-project hosts](#verify)).

## Eval ratio: `--max-eval-ratio` {#eval-ratio}

An `eval` step is opaque: it does not heal, cannot be reviewed as a Playwright
action and needs `bypassCSP` against a strict CSP. `--max-eval-ratio <0..1>`
(profile: `maxEvalRatio`) refuses a spec whose share of eval steps is above the
limit. The ratio is `eval steps / steps` over the spec as it runs and exports:
imported actions expanded, `if` / `repeat` bodies walked into, a container
counting as one step, `teardown:` steps counted (they run in the exported test
too, and the `bypassCSP` check lists them as well). Typed steps that evaluate
in the page (`wait: { app }`) are not opaque, so they do not raise the ratio,
but they are page-eval sites for `bypassCSP`. A spec exactly at the limit
passes.

- The refusal is **per spec**: the other specs are still exported. Each refusal
  is printed on stderr and listed under `refused` (`name`, `evalSteps`,
  `totalSteps`, `ratio`, `limit`, `message`) in the report, and the command
  exits **1** after writing the rest. When every spec is refused nothing is
  written (exit 1). With `--stdout` the refused spec prints nothing and exits 1.
  Over MCP the result is `isError` with the same report.
- `--check` / `--verify` regenerate with the limit the manifest recorded, so a
  refused spec is not reported as missing; a spec edited to fit the limit shows
  up as new.
- Every spec with an eval carries `evalRatio: { evalSteps, totalSteps, ratio }`
  in its coverage, shown as `eval 2/3 (67%)` in the markdown report. It is also
  the `evalRatio` semantic risk.
- `cairn spec lint` warns (`eval-ratio`) when an `export.targets` limit would
  refuse the spec, before anyone exports it.

## Strict locators: `--strict-locators` {#strict-locators}

`cairn run` on the default agent-browser backend acts on the FIRST match of a
semantic locator (`by: role`, `label`, `text`, `testid`, …) that has no `nth`.
Playwright is strict: a locator that matches several elements fails the action.
To keep the source semantics, the exporter appends `.first()` to every such
locator, so an exported test can pass where `cairn run --backend playwright`
(which is strict, correctly) fails on an ambiguous locator.

`--strict-locators` (profile field `strictLocators: true`, MCP `strictLocators`)
emits no `.first()`: a locator with `nth` keeps `.nth(n)`, a `by: selector`
locator was never wrapped, and everything else is exactly what Playwright's
strict mode judges, in tests, action modules and generated page objects alike.
`--no-strict-locators` turns a profile's `true` off for one export.

- **Default: unchanged (`.first()`).** The config has no run-backend setting (a
  run picks its backend with `--backend`), so there is nothing to infer the mode
  from; `--strict-locators` is the opt-in. Use it when the exported suite runs in
  a Playwright tree that is meant to fail on an ambiguous locator, or when you
  trust `cairn run --backend playwright` as the reference.
- **The manifest records it** (`source.strictLocators`), so `--check` and
  `--verify` regenerate with the same mode without the flag; a `--check` with the
  other flag explicitly given reports the files stale.
- **`--verify --differential` and the mode.** The cairn side of the differential
  is always `cairn run --backend playwright`, which is strict. With a strict
  export both sides judge locators alike, and the differential report carries
  `strictLocators: true`. With a default export, a spec the run failed and the
  export passed gets a warning pointing at `--strict-locators`: if the failing
  step's locator matches several elements, that is the difference.

## What maps well

| Cairntrace | Playwright |
|------------|------------|
| open / click / fill / hover / focus / select | page.goto / locators |
| `postcondition.network` on an action | `page.waitForResponse(...)` before the single action |
| wait text/notText/selector/value/load | expect.poll / waitForSelector / expect(locator).toHaveValue / waitForLoadState |
| request (+ `assign`) | page.request.fetch (cookies) + a splice binding |
| request `credentials` / `until` / `retry` / `capture` | `cairnRequest(page, …)`: an isolated request context for `omit`, the same polling, retry, JSON matchers and path filters, the runner's envelope (`${requests.<name>.captures.<key>}` splices) (`lib/request` in `--project`) |
| request `matrix` | `cairnRequestMatrix(page, …)`: every combination runs, the test fails listing the mismatches |
| `use: login` | `cairnLogin(page, CAIRN_AUTH)`: the environment's `auth:` through `page.request` (the page's cookies), secrets as `process.env` reads (an unset one throws before anything is sent, like `cairn run`), hydrate given only the login response (`lib/auth` + `lib/request` in `--project`); without an `auth:` block at export time the test is `test.fixme` |
| eval (inline js and `eval.file`) | page.evaluate (+ a splice binding for `assign`) |
| download / upload | waitForEvent("download") into the test output dir / setInputFiles (fixtures copied) |
| browser script.file | transpiled/embedded page.evaluate |
| batch | sequential steps (no hover atomicity) |
| when: url\*/text\*/selector\*/var | real `if` wrappers |
| repeat (`until`, `onMax`, `${repeat.*}`) | a bounded `for` loop; `until` checked before each iteration, a final `expect` for `onMax: fail` |
| if / else | `if (…) { … } else { … }` |
| wait.any / wait.all / optional / assign | `Promise.any` / one `expect.poll` reading every condition each tick (all must hold at the same moment, like `cairn run`) / a caught miss / a typed `{ matched, index }` binding |
| use + retry | a `try/catch` retry loop (around the action module call in `--project`) |
| set / check / uncheck / choose / form | `cairnWidget(page, …)` / `cairnWidgetForm(page, …)`: the same in-page widget runtime and `browser.fieldRoot` / `browser.widgets` config as `cairn run` (`lib/widgets` in `--project`) |
| click `optional` / `dispatch` / `fallback: dispatch` | an `isVisible()` guard / `cairnWidget(page, { op: "click", mode: "dispatch", … })` / a 5s pointer click with that dispatch as the catch |
| fill `mode: set` / `optional` | `cairnWidget(page, { op: "fill", … })` (the runner's own in-page fill) / an `isVisible()` guard |
| eval / browser script / login hydrate that use `__cairn` | the source runs after `CAIRN_PRELUDE`, the same `window.__cairn` installer with the config `browser.appHandle` accessors (`lib/prelude` in `--project`) |
| `wait: { app }` | `expect.poll(() => cairnAppCheck(page, path, check))`: the same in-page check `cairn run` polls (a navigation mid-check counts as "not yet"; a strict CSP that blocks it fails at once, naming the CSP) |
| text / url / count / network / console | expect(...) (`noFailedRequests`, and `network` in a spec that has one: `cairnAssertNoFailedRequests` / `cairnAssertNetwork`, the runner's judges) |
| `capture` (text / value / attribute / table) | `cairnCapture(page, …)`: the runner's in-page probe, retried for the step's `timeoutMs`, binding `${captures.<name>…}` (`lib/probe` in `--project`) |
| `table` verifier | `cairnReadTable` + `cairnJudgeTable`: the same probe and checks |
| verifier `poll` | `expect(…).toPass({ timeout, intervals })`; `stableMs` → `cairnPoll` |
| `run:` step / `teardown:` | the bounded command helper, with `--preconditions inline` or `global` (teardown in a `finally`) |

## Import

Two commands go the other way, into reviewable Cairntrace YAML. Both are drafts:
they write what the source did or asserted, never a finished contract. Each
reports a coverage summary and runs `cairn spec lint` / `cairn spec verify` on
the file it wrote, so the findings that remain are in the report (`check`).

Both refuse to overwrite an existing file (exit 2; `--force` overwrites). A
draft that maps **nothing** — no step and no outcome came out — is not
written: the command prints a loud warning on stderr, reports `status:
refused` with the TODOs that say why, and exits **1** (`--allow-empty` writes
the placeholder draft anyway; MCP: `allowEmpty`, the result is `isError`). A
draft with more TODOs than mapped constructs is written with a `low coverage`
warning (stderr and the report's `warnings`).

```bash
cairn import playwright tests/login.spec.ts --format md
cairn import playwright tests/login.spec.ts --test "locks the account" --out flows/_drafts/lockout.yml
cairn import playwright-trace test-results/login/trace.zip --intent "A member signs in" --format json
```

Where it fits in the author flow: catalog → discover **or import** → `cairn spec
finish` → `cairn spec promote` ([Discover](/discover); `cairn docs author-flow`).
Import is the shortcut when the journey already exists as a Playwright test or a
recording; replace its TODO steps and keep only the draft outcomes that state
behavior.

### Playwright test (`cairn import playwright`)

The file is parsed with the TypeScript compiler API and never executed.
`typescript` is taken from the project being imported (found by walking up from
the file) when it exposes the JavaScript API, else cairntrace's own (a runtime
dependency of cairntrace); a TypeScript without the API (the native TypeScript 7
compiler) is skipped and named if nothing else is left. The importer reads
**one** test: the first, or `--test <title substring | 1-based n>`; the others
are named in TODOs.

| Shape in the test | What the importer does |
|---|---|
| `test.step("title", ...)` | inlines the body; the title becomes the id of the first step or outcome inside |
| `test.beforeEach` (file or describe level) | inlines its body before the test; `beforeAll` / `afterAll` / `afterEach` are TODOs |
| page objects (`new LoginPage(page)`; fields, getters, constructors, base classes, same file or relative imports, through barrels: `export * from`, `export { A as B } from`) | inlines the called method with its arguments bound; an `if` on a flag the call passes as a literal runs only the branch it takes (approximated) |
| helper functions | inlines them (same file or relative imports, barrels included) |
| fixtures in the signature (`async ({ page, loginPage })`) | reads `test.extend({...})` through the test file's relative imports (a barrel that re-exports `test` too): setup runs before the body in signature order, an option fixture's default is its value unless a `test.use({ option })` in scope sets it, code after `use()` is a TODO; a fixture or helper that builds its page with `browser.newContext()` / `context.newPage()` becomes the spec's page (approximated: context options and a second context are not imported); an unresolvable fixture is named in a TODO |
| the selector-first page API (`page.fill(sel, v)`, `page.click(sel)`, `type`, `check`, `press`, `selectOption`, `hover`, …), `page.waitForSelector("css=… >> text=…")` | the same steps as the locator methods, the selector string parsed like a `locator()` one (`css=`, `text=`, `>>` chains, `:has-text()` as a text filter) |
| `getByRole` (+ `name`, `exact`), `getByLabel`, `getByText`, `getByTestId`, `getByPlaceholder` / `AltText` / `Title`, `locator("css")` | `by: role` / `label` / `text` / `testid` / `selector` (placeholder, alt and title become exact attribute selectors) |
| `.filter({ hasText })`, `.nth(n)`, `.first()` | `hasText`, `nth` (an exporter's own `.first()` is not carried back) |
| `click`, `hover`, `focus`, `fill`, `clear`, `pressSequentially`, `press`, `check`, `uncheck`, `setChecked`, `selectOption`, `setInputFiles`, `scrollIntoViewIfNeeded`, `keyboard.press` | the matching step |
| `goto`, `waitForURL`, `waitForLoadState`, `waitForTimeout`, `waitForSelector`, `locator.waitFor` | `open` / `wait` |
| `request.get/post/...`, `page.request.*` | `request` (credential headers and secret-named body keys become `${secrets.X}`) |
| `toHaveURL`, `toBeVisible`, `toBeHidden` (and `.not`), `toHaveText`, `toContainText`, `toHaveCount`, `expect(page.url())`, `expect(await loc.isVisible())` | outcomes (`url`, `count`, `text`, `notText`) |
| `toHaveValue`, `toBeEnabled`, `toBeDisabled`, `toHaveAttribute` | a `wait: value` / `expect` step |

Every construct is counted once: **mapped**, **approximated** (the reason is a
`# APPROXIMATED:` header line: a regex treated as text, a role name a count
cannot filter by, `dblclick` as a click, a test id assuming `data-testid`, a
dropped scope or `.last()`) or **unmapped** (a `# TODO:` comment before the step
it precedes, with the reason: control flow, `page.evaluate`, XPath and other
Playwright-only selectors, `.and` / `.or`, `expect.poll`, `toBeChecked`,
`test.use` browser options, `test.skip`, an unresolved fixture). The report (`--format
json|yaml|md`) has `coverage { mapped, approximated, unmapped, total }`, `todos`,
`approximations` and `check`.

Values are static only: literals, consts, template strings and
`process.env.X` (`${env.X}`, or `${secrets.X}` for a credential-named
variable). A value typed into a password, token, key, OTP, one-time-code or pin
field becomes a `${secrets.X}` placeholder, and so do a URL's user:password,
credential-named or credential-shaped query values and path segments, string
and number values under a credential-named request body key (nested objects
included) and credential-shaped literals anywhere (a JWT, a long hex or base64
token). The literal is not written anywhere — not in a TODO comment either,
whichever argument it was (`page.fill(selector, value)`). Declare the secret in
config `secrets.required`.

Names are matched as whole words, split at separators and camelCase:
`password`, `passe` (`Mot de passe`), `pin`, `otp`, `secret`, `api_key`,
`access_token`, `X-CSRFToken`, `session_id` name a credential; `Compass`,
`passengers`, `tokenizer`, `token_count`, `secretary`, `x-session-locale`
and a body `signature` do not (the value's shape still decides). A hex path
segment is a credential only after a credential-context segment
(`/reset/<token>`, `/reset-password/<token>`, `/verify/<code>`) — never a
commit SHA, a digest or a collection id such as `/api/tokens/<id>` — and a
request or trace id header (`x-request-id`, `traceparent`) is not judged by
its hex shape. A number under a credential key (`pin: 482913`) becomes a
`${secrets.X}` reference, which is always text: an approximation says the
request now sends it as a string.

### Playwright trace (`cairn import playwright-trace`)

```bash
cairn import playwright-trace <trace.zip> [--out <spec.yml>] [--name <name>] \
  [--intent "<text>"] [--stdout] [--force] [--allow-empty] [--format json|yaml|md]
```

A trace archive is what `trace: "on"` (or `context.tracing.stop({ path })`)
writes: `trace.trace` (or `<n>-trace.trace` and `test.trace`), `trace.network`
and `resources/`. The importer reads the two JSON-lines logs only; screenshots,
sources, DOM snapshots and response bodies are never read. The zip is opened by
a small built-in reader.

- **Steps.** `open` for navigations (same-origin URLs become paths relative to
  the recorded `baseURL`, which the header names), `click` (`dblclick` and
  `tap` approximated), `fill`, `type`, `press`, `select`, `check`, `uncheck`,
  `hover`, `focus`, `request` and `wait` (`waitForSelector`,
  `waitForTimeout`). `test.step` titles become step ids; the rest are named
  after the action and target.
- **Locators.** The recorded selector, best handle first: role + name, label,
  test id, text, CSS. A selector that is plain CSS is upgraded from the element
  the call log resolved (a button or link's text or `aria-label`, else the
  test-id attribute); uniqueness is not verified, so read the approximation
  line.
- **Draft outcomes** (descriptions start with `DRAFT:`): recorded `expect()`
  calls (visible, hidden, text, count, URL, value, enabled), the final
  main-frame URL (`url.endsWith` its path; a path with id-like or token
  segments becomes `url.matches` with `[^/?#]+` in their place, so the draft
  does not pin one record), and same-origin fetch / XHR
  responses as `network` outcomes (method, a path pattern with id-like
  segments cut, the status; no query string, headers or bodies). A recording
  shows what happened once, not what must stay true: keep the ones that state
  the behavior.
- **Secrets.** A value typed into an `type=password` field or one named
  password, token, OTP, pin, API key and so on, a credential header on an API
  call, a credential-named JSON body key (every value nested under it, numbers
  included), a URL's user:password (cross-origin URLs too), credential-named
  query and fragment values (`#access_token=…`) and credential-shaped values
  anywhere (a JWT, a long hex or base64 token, also as a path segment such as
  `/reset-password/<token>`) are `${secrets.X}` placeholders, with the same
  whole-word names and hex rules as the test importer (a commit SHA, an
  avatar digest, `/api/tokens/<id>`, `x-request-id`, `x-session-locale`,
  `Compass heading` stay as recorded). A final pass replaces every value
  identified as a credential wherever else it was recorded — a call before
  the fill that revealed it, TODO and approximation lines, the rendered YAML
  — when it is a strong credential (typed into a password field or under a
  credential's name) of 4+ characters, or any other one of 8+ characters or
  credential-shaped, so a short word never rewrites a title or a URL; a step
  id derived from one becomes `<verb>_redacted`. The header comment lists the
  names, never the values.
- **Bounds.** A `.trace` / `.network` entry above 64 MB, or more than 160 MB
  decompressed from one archive, is refused (exit 2); the logs are parsed line
  by line.
- **TODOs.** A recorded call that failed, raw keyboard input, `evaluate`,
  reload / back, cookies, routes and file payloads (a trace stores the
  content, not a path).

`--name` and `--intent` default to the trace's test title. The default output
is `./<name>.yml` (an existing file needs `--force`).

Review TODO comments, satisfy cold-start, then `cairn run --cold-start`.

## Authoring path

1. `cairn docs authoring` / discovery (`cairn_discover_*`), or `cairn import` when
   the journey already exists as a Playwright test or trace
2. Author the YAML → `cairn run` → heal
3. Only then `cairn export playwright`, and prove it: `--verify` (static gates),
   `--verify=differential --mutate` before trusting a CI copy, `--check` in CI

See also: [Discover](/discover), [Authoring](/authoring),
`cairn docs export --json`, `cairn docs import --json`.
