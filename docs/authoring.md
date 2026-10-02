---
title: Write Durable Browser Specs for Coding Agents
description: Author Cairntrace contracts with typed outcomes, semantic locators, repairable steps, contract hashes, and reliable cold-start browser replay.
---

# Authoring specs that survive

Authoring a cairn spec is closer to authoring a contract than to authoring a test. The contract is the durable thing. Steps are repairable hints. This page is the discipline that makes a spec live across months of code churn instead of weeks.

## The contract first, the steps second

Start every spec with `intent` and `outcomes`, never with steps. `intent` is one sentence describing what the user wants to happen. `outcomes` are the typed observables that confirm it did. Until both are written, the spec has no contract; running it just produces a transcript of whatever the steps happened to do.

```yaml
intent: Search for "spiced chickpeas", filter by category, and see exactly 7 results.
outcomes:
  - id: results-narrowed
    count: { selector: "[data-testid='result-count']", equals: 7 }
  - id: filter-applied
    text: { contains: "category:baking" }
steps:
  - open: { path: "/search?q=spiced+chickpeas" }
  - click: { by: { role: checkbox, name: "Baking" } }
```

If a colleague can delete every `step:` in the file and you can still describe what the spec should prove, the contract is right. If removing `step:` turns the spec into pure prose, the contract is not yet there.

## Outcomes are typed observables

The verifier vocabulary is closed: `text`, `notText`, `url`, `network`, `noFailedRequests`, `console`, `count`, `xlsx`, `file`, `httpJson`, `script`, `process`. If you find yourself wanting a new verb, use `script` with a small JS expression and a `.raw.json` sidecar — never invent a new verifier type, because then every agent has to learn the new vocabulary.

Each outcome must be enforceable from a single page state. Outcomes are not assertions-in-time; they are assertions-on-state. If you need a sequence ("after step 3 the cart is empty, after step 5 it has 3 items"), write two outcomes and pin them to their step.

```yaml
outcomes:
  - id: cart-empty-after-clear
    count: { selector: "[data-testid='cart-count']", equals: 0 }
  - id: cart-three-after-add
    count: { selector: "[data-testid='cart-count']", equals: 3 }
```

## Steps are hints, not scripts

A `step` is an instruction a code generator (you) or a runtime (cairn) might rewrite without changing the contract. Steps must use the typed step vocabulary too (`open`, `wait`, `click`, `hover`, `focus`, `fill`, `type`, `press`, `scroll`, `upload`, `download`, `transform`, `request`, `snapshot`, `use`, `batch`, `eval`, `monitor`). Free-form prose inside an `eval:` step is allowed, but if you find yourself reaching for it, stop and ask whether one of the typed steps already encodes the intent.

The same locator philosophy that drives `playwright` should drive cairn: prefer semantic locators (`by: role|label|text`), fall back to `by: testid` (honors `browser.testIdAttribute`, default `data-testid`), and only touch CSS/XPath when nothing else survives. When a name is repeated on the page (three **Open** buttons), add `near: "the heading a user would look at"` instead of hardcoding an ObjectId or `nth: 0`. After a click that navigates, `wait: { url: { includes: "/connection/" } }` is the typed wait — do not `eval` `location.pathname`.

```yaml
steps:
  - open: { path: "/settings" }
  - click: { by: { role: tab, name: "API tokens" } }
  - click: { by: { role: button, name: "Rotate token" } }
  - click: { by: { role: button, name: "Yes, rotate" } }
```

## Paths and environments

Never hardcode an absolute path to a fixture, script, or upload — the spec stops working on the next machine. Relative paths in steps (`upload.path`, `eval.file`, `transform.file`/`input`, eval `args.filePath`/`fixtureFiles`) resolve against the file that declares the step: the spec's folder for its own steps, the **action's** folder for the steps of an imported action. A path inside an action that only exists next to the importing spec (how earlier releases resolved it) still works, with a deprecation warning naming the action and step — move the file next to the action. Two placeholders cover the rest:

- `${file.dir}` (alias `${project.root}`) is the directory of the **file being parsed**. In a spec that is the spec's folder; inside an imported action it is the **action's** folder. That makes `${file.dir}/fixture.csv` in `actions/upload.yml` mean `actions/fixture.csv`, wherever the importing spec lives.
- `${config.dir}` is the directory of the resolved `cairntrace.config.yml`: the file passed with `--config` (MCP `config`), else the one found by walking up from the spec's folder (the current directory when there is no config). `cairn run`, `spec verify`, `spec heal`, and both exporters resolve it the same way. Use it for fixtures shared by specs and actions in different folders.

```yaml
steps:
  - upload: { by: label, name: "Import file", path: "${config.dir}/fixtures/import.xlsx" }
```

`cairn spec verify` resolves every one of those files exactly like a run (actions included) and exits 4 when one is missing; an absolute path outside the project is a warning.

Pick the environment explicitly with `--env`. When a config exists, an `--env` it does not define fails fast with the list of known environments — `cairn spec verify` exits 4 — instead of running without the environment's `baseUrl` and vars. A spec's own `environment:` is a default: if the config does not define it, the spec still runs (without that `baseUrl` and vars) and `cairn spec verify` warns. See [Configuration](/configuration#placeholder-resolution).

## Where a spec may run

A spec that changes shared data must not run everywhere. Declare it in the spec and let `cairn run` enforce it — not a shell guard in a precondition:

```yaml
requires:
  env:
    - local
    - dev: { optIn: CAIRN_ALLOW_DEV_MUTATIONS }   # dev only when that variable is 1/true
  mutates: true                                  # refused where policy.mutations is deny
```

Environments carry the other half in the config (`environments.<name>.policy`, see [Configuration](/configuration#environment-policy)): `trait: protected` environments run only specs that list them in `requires.env`, and `mutations: deny` refuses `requires.mutates: true`.

`cairn run` checks each spec before secrets, services, the webServer, hooks, preconditions or a browser start. A refused spec gets status `refused` with a `refusal` block (`reason`, `env`, `requires`, `code`: `env-not-listed`, `opt-in-missing`, `mutations-denied`, `protected-env`), its outcomes reported `skipped`, no run directory (the result carries `synthetic: true`: its `runId` / `runDir` are placeholders that are never written, so do not open them), a `run.refused` event in the invocation journal (the journal `summary` counts it as `refused`), and is never stashed, investigated or counted by retention. When every spec of the run was refused — one spec or many, whatever `--parallel` — nothing ran and `cairn run` exits **7**. In a batch where other specs ran, a refused spec is listed (`summary.refused`, and its own section in the markdown summary) and skipped; that batch fails with exit 7 only under `--strict-requires` (failed and errored specs still win with 1 and 2). `cairn spec heal` on a refused spec exits 7 too. `cairn run --select-only` lists refused specs under `skipped` with the reason, and `cairn spec verify --env <name>` fails with an `env-not-allowed` finding (exit 4); without `--env`, verify lists every environment and whether the spec may run there.

Exported Playwright tests keep the guard at run time: `requires` becomes `test.skip(...)` on `process.env.CAIRN_ENV` (and the opt-in variable) — set `CAIRN_ENV` when you run the exported suite. An export that bakes an environment's `baseUrl` (absolute URLs in a single file, `baseURL` in a `--project` config) ties the guard to that environment: the test runs only when `CAIRN_ENV` names it, because the URLs it drives belong to it. If the policy refuses the spec in the exported environment (not listed, protected, mutations denied), the test always skips and the export reports an `envPolicy` risk; re-export with an `--env` the spec may run in.

## Tags for suite selection

Put stable labels on a spec under `metadata.tags`. Agents and humans then run a **subset** of a directory without inventing new folders:

```yaml
metadata:
  feature: checkout-next
  priority: high
  tags:
    - checkout-regression
    - next
    - checkout
```

```bash
# preview which specs match (no browser)
cairn run flows/ --tag checkout --select-only --json

# run every matching spec (AND if you pass multiple --tag)
cairn run flows/ --tag checkout --cold-start --headed
cairn run flows/ --tag next --tag checkout-regression --cold-start
```

Matching is **case-insensitive**. Multiple `--tag` flags mean **AND** (the spec must declare every listed tag). Specs with no `metadata.tags` never match a tag filter.

## Labels, hooks, and A/B stats

Stamp free-form **cohort labels** on every run in an invocation:

```bash
cairn run flows/ --tag checkout \
  --label path=next \
  --label suite=checkout-ab \
  --before 'tools/flip-path.sh next' \
  --cold-start
```

- `--label key=value` (repeatable) is written into each `run.json` as `labels`.
- `--before <shell>` (repeatable) runs **after** services/secrets and **before** the first spec of each run (once per `--repeat`/`--matrix` iteration) — use it for domain setup (path flips, warmers). Failures abort the run.
- `--after <shell>` (repeatable) runs after **each spec** finishes (pass or fail), while services are still up, with `CAIRN_RUN_DIR` set to that spec's run directory (see [After hooks and external metrics](#after-hooks-and-external-metrics)). Failures and timeouts are logged, non-fatal.
- `--hook-timeout-ms <ms>` bounds each hook independently (10 minutes by default, 2 hours maximum). Raise it explicitly when a fenced drain/restart has a larger documented wall-clock budget; prefix the hook with `exec` when its cancellation must reach the target process directly.
- `services.seed.postCommands` always run after seed (even when seed is skipped as fresh) — use for fixture ensure scripts.

Aggregate cohorts:

```bash
cairn stats --group-by path --label suite=checkout-ab --baseline legacy --format md
```

Markdown output includes a table, ASCII bar charts (pass rate / duration p50 / optional domain metric), and pairwise deltas. JSON/YAML use schema `urn:cairntrace.dev:stats:v1`. Domain latency is harvested from `outcomes/*.raw.json` when fields like `processingDurationMS` are present.

## Repeat and matrix runs

Benchmark a flow N times, or across a parameter grid, in one command:

```bash
cairn run flows/import.yml --env chalupa --no-services \
  --label round=r7 --repeat 5 \
  --matrix 'workers=1,4;flag=on,off' \
  --before 'tools/apply-config.sh "$CAIRN_MATRIX_WORKERS" "$CAIRN_MATRIX_FLAG"' \
  --stop-on-fail

cairn stats --group-by workers --baseline 1 --metric rootMs
```

- `--repeat N` runs the whole spec set N times sequentially. Every run gets its own run directory and the label `repeat=<i>` (1-based). N is capped at 1000.
- `--matrix key=a,b[;key2=x,y]` runs the cartesian product (first key varies slowest). Each combination is stamped as `key=value` labels, so `cairn stats --group-by key` works, and exported as `CAIRN_MATRIX_<KEY>` environment variables (key upper-cased, non-alphanumerics become `_`) to `--before`/`--after` hooks and to the spec's `${env.…}` substitutions. A key may not be `repeat`. `--repeat` additionally exports `CAIRN_REPEAT`. The whole plan is capped at 5000 runs.
- With both flags, repeats are the outer loop and matrix combinations the inner one (a, b, a, b, …), so slow machine drift does not bias a single cohort.
- Services and the web server start once per invocation; `--before` hooks run again before every run.
- `--stop-on-fail` stops at the first run that does not pass. Without it every run executes.
- A plain-text summary (one line per run: status, labels, exit code, run dirs) is printed to **stderr** at the end, so `--json`/`--yaml` stdout stays one document per run. The process exit code is the most severe code across runs (6, then 1, then 2, then 7, then 0).
- Auto-prune (`retention.keepRuns`, default 3 per spec) is raised to at least the number of runs in the invocation, so earlier repeats are not deleted mid-benchmark. Runs from a _previous_ invocation still count against the normal limit.

## After hooks and external metrics

External collectors (CPU profilers, a benchmark harness) can attach artifacts to each run:

```bash
cairn run flows/import.yml --label sha=$(git rev-parse --short HEAD) \
  --after 'collect-profile.sh "$CAIRN_RUN_DIR/diagnostics"' \
  --hook-timeout-ms 120000
```

- Each `--after` command runs after every spec, pass or fail (skipped for specs that errored before a run directory existed), with `CAIRN_RUN_DIR` (absolute run directory; `diagnostics/` is pre-created), `CAIRN_RUN_ID`, `CAIRN_RUN_STATUS` (`passed`/`failed`/`errored`) and `CAIRN_SPEC_PATH`. Commands run sequentially in the order given. Timeouts (`--hook-timeout-ms`, shared with `--before`) kill the whole process tree; failures only warn.
- If `$CAIRN_RUN_DIR/diagnostics/report.json` exists, its **numeric top-level fields** (finite, non-negative; numeric strings accepted; nested objects, booleans and arrays ignored) become run metrics: `cairn stats --group-by <label> --metric rootMs` aggregates that field (p50/p95 per cohort). Metrics are read when `cairn stats` runs, so a collector may also write the file later.
- **Precedence:** the built-in duration columns (run wall-clock) always come from `run.json` and are never overridden. For the single `--metric <name>` column, a `report.json` field named `<name>` wins; if absent, the first matching field in `outcomes/*.raw.json` is used (the original behavior). Metric names ending in `ms` render as durations; other names (for example `gcSeconds`) render as plain numbers.

Keep product-specific scripts (path flip, mongosh fixtures) in the automation project; cairn only orchestrates via hooks + postCommands.

## Cold-start is not optional

Every spec must satisfy the **cold-start contract**: replayable from a fresh browser session. Four supported paths, pick one:

1. `imports: [actions/login.yml]` + `steps: [{ use: login }]` — reuse an action file.
2. `session: { resume: <checkpoint> }` — capture a logged-in state once with `cairn checkpoint capture-from-session` and resume it.
3. `preconditions: { commands: [{ run: "..." }] }` — set up state from the shell.
4. `coldStart: guest` — explicitly acknowledge that a public flow intentionally starts without a session.

Each precondition command is bounded by `timeoutMs` (120 seconds by default). On timeout Cairn
hard-kills the command and its descendant process tree, so a child setup tool cannot survive into
teardown or mutate the next run.

There is no path that "just works because my dev session is logged in." A spec that only runs in dev is a spec that does not run. The guest acknowledgement suppresses the setup lint; it does not skip the required cold-start replay.

## The contract hash exists for a reason

After editing `intent` or `outcomes`, the contract hash changes. If you forget to re-stamp, `cairn run` refuses the spec — by design. To re-stamp:

```bash
cairn spec verify my-spec.yml --stamp
```

You should be running `cairn spec verify --stamp` exactly once per contract change, never zero times and never five times. The hash is meant to be noisy when you skip it.

## Wait steps are bounded

`wait`, `evaluate`, and browser-network calls are all hard-bounded at 30000 ms by default. Override per-step with `timeoutMs` when the app genuinely needs more time. Do not blanket-timeout the whole spec — make the slow step slow, not the spec slow.

For hydration-sensitive first interactions, prefer:

```yaml
- open: { path: "/app", waitUntil: networkidle }
```

over a separate `wait:` step. Two `wait`s in series are how a fast spec turns into a slow one.

## Repairs are first-class

When a run fails, start with `agent_context.md` and `outcomes/*.md`. The run
also retains `events.ndjson`, `console/`, `network/`, per-step files under
`diagnostics/`, and any snapshots, screenshots, trace, or video enabled by the
capture policy. The repair engine reads the structured evidence and proposes
step rewrites that preserve the contract hash.

The repair proposal is a suggestion, not an approval. Open the diff, check that the contract is unchanged, and apply only what keeps the behavior intact. If the diff touches `intent` or `outcomes`, that is *not* a repair; that is a contract change, and the hash must be re-stamped.

## Lint before you run

`cairn spec lint` reads a spec the way an experienced reviewer would and
says what to change, with the line:

```bash
cairn spec lint flows/profile.yml --env local,staging --json
cairn spec lint flows/ --fix          # quote # selectors, add step ids
```

It catches the mistakes agents make most:

- `selector: #save` — YAML reads an unquoted `#` as a comment, so the value
  is empty. `--fix` quotes it. A comment after a key that holds a nested map
  (`click:  # primary` above an indented `by: role`) is a real comment and is
  left alone.
- Schema problems explained for the step that has them (`fill step: unknown
  key "label"`), not a dump of every union branch.
- Files that do not exist where a run will look (a `preconditions.commands`
  `cwd` included), and paths that only exist on one machine (`/Users/…`,
  `/home/…`).
- A cold start satisfied only by `echo` preconditions.
- Script verifier fixture keys the verifier's contract does not list, and
  required ones that are missing.
- Literal secrets: a known secret value or a credential var is an error. A
  literal typed into a field whose name sounds like a credential (Password,
  API key, PIN) is a warning, since the input type is not in the spec: write
  a credential as `${secrets.NAME}` or `${env.NAME}`, and keep test data or
  move it to `${vars.X}`. Fields about a credential ("Token name", "Password
  hint") are not flagged.
- `eval` bodies a typed step does better: `location.assign` → `open`, a
  login `fetch` → `request` or the login action, `.click()` → `click`, a
  value setter → `fill`, a polling loop → `wait` or `click.until`.
- Placeholders that would reach a shell literally (`${requests.x}` in a
  precondition), missing step ids, and `${vars.X}` that do not resolve in
  each `--env`.

`--fix` only applies edits that cannot change what the spec does: it writes
only when the edited file parses to the same document plus the quoted values
or new ids, and it leaves step ids alone in a file that uses YAML anchors or
aliases. Comments and quoting elsewhere stay byte-identical, and each
finding's `fix.applied` says whether it was written. Exit 4 when any finding
is an error.

## Finish, then promote

`cairn spec finish` is the done-check:

```bash
cairn spec finish flows/_drafts/profile_website_saved.yml --env local --json
```

It lints (errors stop here), runs the spec from a cold browser through the
same engine as `cairn run` (config, vars, scoped secrets, services — a
`cairn services up` stack is reused), stamps the contract hash when the run is
green, and returns the run directory, the report and a summary of
`agent_context.md` with what to do next. It takes the run flags that matter
for a cold start: `--no-web-server` when you already run the dev server (a
cold start otherwise boots the config `webServer` fresh and refuses a busy
port), `--no-services`, `--artifact-root`, `--provider` and `--device`.

`--mock` (or `--backend mock`) checks that the spec parses and its steps
replay, but no browser touches the app: the result says so, and promotion
does not accept a mock finish without `--force`.

Drafts live in the drafts directory (config `authoring.draftsDir`, default
`flows/_drafts`; the folder name must start with `_`). `cairn run <dir>` skips
every folder and file whose name starts with `_`, so a draft never joins a
suite by accident; `--select-only` lists them under `skipped`, and a run notes
how many it left out. When the human has reviewed it:

```bash
cairn spec promote flows/_drafts/profile_website_saved.yml --json
```

moves it out (to `flows/` by default, or `--to`), rewrites its relative
imports and file paths (eval and transform files, eval host files next to the
draft, upload paths, script verifiers, precondition `cwd`s), stamps the
contract and returns `{from, to, intent, outcomes, contractHash}`. A
precondition command without a `cwd` runs in the spec's folder, so promote
warns that the folder changed. If the promoted copy would point at a file
that does not exist, promote removes it again and keeps the draft. Promotion
requires a green finish of the exact content being promoted, on a real
backend (`--force` overrides, and says so); it never replaces an existing
spec.

[Author a spec from a request](/author-flow) walks through the whole path,
from a few sentences to a promoted spec.

## A checklist before you call a spec done

- `cairn explain --format json` — surface-level sanity check.
- `cairn docs <topic> --format json` for focused authoring reminders.
- `cairn catalog --query "<words>" --format json` — reuse the project's actions and vars instead of re-recording literals.
- `cairn spec lint my-spec.yml --format json` — fix-its before anything runs.
- `cairn spec verify my-spec.yml --format json` — schema, contract hash, dead links, missing files, and the environments the spec may run in (`--env <name>` to check one).
- `cairn spec finish my-spec.yml --format json` — lint, one golden run from a fresh browser, stamp when green. (`cairn run my-spec.yml --cold-start --format json` is the run on its own.)
- `cairn docs snippets --format md` — to lift reusable `actions/*.yml` files.

If `cairn spec finish` is green, paste the command into your project README. The next agent that touches that flow will thank you.

## When locators will not replay

A green local run and a miss in another environment is not a reason to
weaken `intent` or `outcomes`. Compile a [journey brief](/brief)
(`cairn export brief <spec> --from-run latest`) so a harness can find the
controls. The harness chooses WHERE; fill values stay authored. Prefer
semantic locators and `cairn spec heal` first if the accessibility tree is
the same and only CSS drifted.
