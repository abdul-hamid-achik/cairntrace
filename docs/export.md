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

# Is a committed export still in sync with its specs? (exit 0 fresh, 1 stale, 2 error)
cairn export playwright --check playwright-export --format json
```

MCP: `cairn_export_playwright` with `path`, optional `out` / `outDir`, `lang`,
`stdout`, `project`, `into`, `config`, `env`, `var`. It runs the same code
path as the CLI: `project` / `into` exports copy upload fixtures and write
`.cairn-export.json`, batch `outDir` exports write the README and manifest,
and specs that fail to export are listed under `errors`.

## Coverage report

Every export reports, per spec, what was translated and what was not:

- `skips` — every construct that was not exported. A **hard** skip marks the
  generated test `test.fixme` so it can never pass by omission: `transform`
  steps, unreadable `eval.file` / browser `script.file`, inline
  `runtime: node` scripts, `file` / `xlsx` / `process` verifiers, unresolved
  `use:`, and runtime splices with no binding (below).
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
  page-evaluated source or args), and `envPolicy` (the environment whose
  baseUrl the export baked in refuses the spec, so the test always skips).
- `fixme` — `true` when a hard skip made the test `test.fixme`.

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

`${secrets.X}` and an unset `${env.X}` (no `:-default`) emit as
`process.env.X ?? ""`; `${run.token}` emits a per-invocation `RUN_TOKEN`; a
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

In `--project` mode an action function **returns** the values it captured
(`{ requests, evals, artifacts }`) and the calling test merges the ones it
splices. A splice that cannot be bound — its producer is a skipped
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
30-minute floor applies **only** to tests that run durable node verifiers; a
UI-only spec gets its derived budget so a stuck step fails in minutes. In `--project` mode each file's `beforeAll` sets its
own timeout from its executable preconditions' `timeoutMs` (or 120 seconds
each), with the 30-minute floor only when a precondition is long (5 minutes
or more); `playwright.config.*` uses the largest test or hook budget and sets
`actionTimeout` / `navigationTimeout` to 30 seconds, matching Cairntrace's
per-step default.

Preconditions run in each test file's `beforeAll` (`SKIP_PRECONDITIONS=1`
skips them); `global-setup.*` is a one-time suite hook that only logs.
Documentary preconditions never run: a single `echo …` with no shell control
or substitution outside single quotes. `echo "resetting" && psql …` is an
executable command (and a `requiredSetup` risk in single-file exports). Each precondition keeps its
spec-relative `cwd`, its own `timeoutMs`, and layers authored
`preconditions.env` over a filtered child environment; the generated runner
strips publisher/TinyVault control credentials and kills the owned shell plus
descendants at the hard deadline. Single-file exports do not run
preconditions; they are listed in a header comment and as risks.

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
spec, and each file imports only the helpers it uses.

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

## What maps well

| Cairntrace | Playwright |
|------------|------------|
| open / click / fill / hover / focus / select | page.goto / locators |
| `postcondition.network` on an action | `page.waitForResponse(...)` before the single action |
| wait text/notText/selector/value/load | expect.poll / waitForSelector / expect(locator).toHaveValue / waitForLoadState |
| request (+ `assign`) | page.request.fetch (cookies) + a splice binding |
| eval (inline js and `eval.file`) | page.evaluate (+ a splice binding for `assign`) |
| download / upload | waitForEvent("download") into the test output dir / setInputFiles (fixtures copied) |
| browser script.file | transpiled/embedded page.evaluate |
| batch | sequential steps (no hover atomicity) |
| when: url\*/text\*/selector\* | real `if` wrappers |
| text / url / count / network / console | expect(...) |

## Import

```bash
cairn import playwright tests/login.spec.ts --format md
```

The importer reads the first real `test(...)` — `test.step`, hooks
(`beforeAll` / `afterAll` / `beforeEach` / `afterEach`), `test.use`, and
`describe` are never mistaken for tests — and accepts
`test(title, { tag, annotation }, fn)`. `test.step` titles become step and
outcome ids, and the helpers a `--project` export emits (`verifiedFill`,
`verifiedType`, `clickUntil`) map back to `fill` / `type` / `click`.
Page-object calls (`await loginPage.login(...)`) cannot be inferred and stay
as TODO comments.

Review TODO comments, satisfy cold-start, then `cairn run --cold-start`.

## Authoring path

1. `cairn docs authoring` / discovery (`cairn_discover_*`)
2. Export YAML → `cairn run` → heal
3. Only then `cairn export playwright` if needed

See also: [Discover](/discover), [Authoring](/authoring) (if present), `cairn docs export --json`.
