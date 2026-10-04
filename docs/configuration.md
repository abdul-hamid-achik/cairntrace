---
title: Configure Cairntrace Browser Testing
description: Configure projects, environments, browser backends, artifacts, services, secrets, logging, retention, and reports for Cairntrace behavioral specs.
---

# Configuration

Every cairntrace surface reads from a single config source: `cairntrace.config.yml`. The file is **optional** — a spec with absolute URLs runs without one — but anything project-specific (environments, services, secrets, retention, integrations) lives there. The schema is strict: unknown top-level keys are rejected, so a typo fails `cairn config validate` instead of silently being ignored.

```bash
cairn config validate --json          # validate structure + cross-field rules
cairn config validate --config ./cairntrace.config.yml
cairn config vars --env dev           # every var: value per environment, where defined, who uses it
```

## File location resolution

The loader walks the file system upward from the spec file looking for the first `cairntrace.config.yml`. If your specs live in `specs/flows/login.yml` and the project root has the config, that's used. `--config <path>` overrides the lookup on every command that reads config.

## Schema

```yaml
# cairntrace.config.yml
version: 1                           # required, always 1
project: my-app                       # used in artifacts, breadcrumbs, MCP resource names
defaultEnvironment: local             # the env used when no --env is passed (default: local)
artifactRoot: ~/.cairntrace/runs      # override the default artifact root
workflowRoots: [./flows, ./checks]    # dirs cairn scans for specs (cairn explain / codemap)
include: [vars/*.yml]                 # merge vars/fixtures/gates/datasources/suites from other files
vars: { tenant: acme }                # shared by every environment (an environment's vars win)
requires: { cairntrace: ">=3.1" }     # the cairn this config needs (exit 4 on an older one)
runtimes: { node: { version: ">=22" } }  # the node binary of node scripts and verifiers (or path:)
run:                                  # run policy: lock, preflight, verifyClean, finally
  lock: true                          # one `cairn run` per config at a time (exit 4 for the second)
  preflight: [{ secret: DEPLOY_TOKEN }]
  verifyClean: [browsers]             # nothing of this project survives the run (exit 9)

environments:                         # required — at least one environment
  local:
    baseUrl: http://localhost:3000
    vars: { allowedCountry: US, retryCount: 3, useSandbox: true }
    viewport: { width: 1280, height: 800 }
  staging:
    extends: local                     # start from local (deep merge), then override
    baseUrl: https://staging.app.com
    services: false                    # disable all services for this env (app is remote)
    secrets: { provider: tvault, tvault: { group: payments, env: prod } }

secrets:                              # default secrets block (an env-level secrets replaces it)
  provider: tvault                    # env | tvault
  keys: [API_KEY, DB_URL]             # selected TinyVault values for this invocation
  required: [API_KEY, DB_URL]         # fail the run if these are unset/empty
  tvault:                             # required when provider: tvault
    project: my-app                    # direct mode — OR —
    # group: payments                  # inheritance mode (requires env)
    # env: prod

retention:
  keepRuns: 10                        # prune to newest N runs/spec after every run
  keepFailedRuns: 10                  # newest N failed/errored runs survive pruning anyway (default: 10)
  publish: { enabled: true, retentionDays: 7 } # explicit remote archive before pruning

report:
  theme: cairn                        # cairn | slate | midnight | contrast
  colors: { accent: "rgb(94,129,172)", danger: "#c0392b" }   # optional CSS token overrides

browser:                              # browser-backend tuning (agent-browser)
  verifyAfterClick: true              # confirm same-tab link delivery (default: true)
  postClickSettleMs: 20000            # opt in to network-idle after every click
                                      # click settleMs > spec settleMs > this value
  testIdAttribute: data-testid        # attribute read by by: testid (e.g. data-qa)
  fieldRoot:                          # widget steps: locate a field container from its key
    - '[data-field-key$=".{key}"]'    # first template with a visible match wins
  widgets:                            # widget drivers in detection order (default: all built-ins)
    - use: vue-multiselect
    - use: primevue-calendar
    - file: ./drivers/user-picker.js  # project driver module, runs in the page like an eval file
  appHandle:                          # read-only page accessors: window.__cairn.app.<name>
    store: window.__APP__.$store       # a page expression, evaluated on every read

webServer:                            # optional single-server lifecycle for `cairn run`
  command: "node .output/server/index.mjs"
  build: "bun run build"               # run once before command (skipped when reusing)
  url: http://localhost:3000           # readiness probe: needs 2xx/3xx (anyResponse: true = any answer; defaults to the env baseUrl)
  waitForText: "listening on"          # …or treat ready when this hits stdout/stderr
  reuseExisting: true                  # reuse a server already answering (false in CI)
  readyTimeoutMs: 60000
  setup: ["bun run db:migrate"]        # run after ready, before specs
  teardown: ["rm -rf ./.cairntrace/tmp"]  # best-effort, after specs

services:                             # multi-service lifecycle (docker/seed/tmux) — see Services page
  docker: { command: "docker compose up -d", reuseExisting: true, readinessCheck: "curl -sf http://localhost:27017" }
  seed: { command: "yarn demo-import", ttlSeconds: 21600, freshnessCheck: "mongosh --quiet --eval 'db.count()' mydb" }
  tmux:
    session: myapp
    waitForReadyBeforeNext: true         # opt-in serial boot; shared readyTimeoutMs deadline
    windows:
      - { name: web, cwd: web-app, command: "yarn serve", readyOn: { url: http://localhost:8080 } }
  teardown: ["tmux kill-session -t myapp", "docker compose down"]
  artifacts: { when: on-failure }     # services evidence in each run dir (services.stash is deprecated)
  # Service operations (all optional): provisioner {up, down, exports}, tunnels [...], files [...],
  # tmux windows' restart / healthcheck.onUnhealthy, seed phases / commit / expectOutput /
  # postCommands objects — see the Services page.

stash:                                # fcheap run-artifact stash — see Stash page
  enabled: true
  autoStash: on-failure               # on-failure | never
  tags: [regression, audit]
  # failTtl: 90d                      # failed runs expire after 90d by default; `never` keeps them

clips:                                # default tags; clip points live in the spec
  tags: [regression]

investigate:                          # fcheap connect + vecgrep — see Investigate page
  codebaseDir: ./src                   # default codebase for `cairn investigate --connect`
  mode: hybrid                         # semantic | keyword | hybrid
  limit: 10
  index: false                         # build/refresh vecgrep before connecting
  autoInvestigate: on-failure          # on-failure | never

annotate:                             # codemap annotation — see Annotate page
  enabled: true
  autoAnnotate: on-run                 # on-run (pass+fail) | on-investigate | never
  source: cairntrace

authoring:                            # convention exports + promote — see Authoring page
  draftsDir: flows/_drafts            # must start with _ so `cairn run <dir>` skips it
  template: { requires: { env: [local] }, metadata: { tags: [draft] }, imports: [actions/auth.yml] }

discovery:                            # discovery sessions — see Discover page
  sessionTtlMs: 1800000               # idle time before a session's browser closes (default 30 min)
  backend: agent-browser              # agent-browser | playwright

export:                               # `cairn export playwright --target <name>` — see Export page
  targets:
    ui:                               # paths are relative to this file; flags override a field
      input: flows
      into: ../e2e/tests/cairn
      hostConfig: ../e2e/playwright.config.ts
      mapFile: ../e2e/export.map.yml  # bind actions to the host's fixtures / page objects
      preconditions: inline           # inline | global | skip | manifest
      verifiers: keep                 # keep | gate | drop
      lang: ts
      maxEvalRatio: 0.25              # refuse specs with more than 25% page eval steps
```

The schema is `.strict()` at every level, so a misspelled key (e.g. `runner:` or `run:` — neither exists) is a validation error, not a silent no-op.

Agent-browser confirms same-tab link delivery from URL, document, or DOM
evidence by default without waiting for network-idle. A positive click-step or
spec-root `settleMs`, or `browser.postClickSettleMs`, opts into network-idle
settling; click/spec values take precedence over config. Playwright honors
explicit click/spec values and otherwise keeps its native waits. A resolved
value of `0` skips both the extra settle and the link-delivery probe at that
scope. `browser.verifyAfterClick: false` disables the agent-browser guard
globally. `browser.testIdAttribute` (default `data-testid`) is the attribute
`by: testid` and Playwright `getByTestId` read — set it to `data-qa`
when that is the product's stable hook. The authoring tools scan the same
attribute: `cairn snapshot`, `cairn discover`, and the MCP discovery/snapshot
tools report `testIdAttribute` and list locators found on it.

`browser.fieldRoot` (one template or a list, each containing `{key}`) is how
`set` / `check` / `choose` / `form` find `field: <key>`; the default is
`[<testIdAttribute>="{key}"]`, then `[name="{key}"]`. `browser.widgets` lists
the widget drivers to try, built-ins (`{ use: <name> }`) and project driver
modules (`{ file: <path> }`, resolved against the config directory); the native
drivers are always appended. See [Widgets](/widgets).

`browser.appHandle` maps names to page JavaScript expressions (a store, a
store getter). An eval step, a browser `script` verifier or a login
`hydrate` script that mentions `__cairn` reads them as
`window.__cairn.app.<name>`, and `wait: { app: { path, equals | in | exists } }`
polls one (`path` starts with the name). Each read re-evaluates the
expression; the accessors cannot be assigned. Expressions are project code,
like eval files: they run only in the page, and `cairn config validate`
reports one that does not parse. See
[Page prelude and app handles](/steps#page-prelude-and-app-handles).

## Environments

`environments` is a required record of `name → EnvironmentConfig`. Each environment can carry:

| Key | Effect |
|---|---|
| `extends` | another environment this one starts from (deep merge; see [Composing a config](#composing-a-config)) |
| `alias` | the same environment under another name; takes no other key (see [Environment aliases](#environment-aliases)) |
| `baseUrl` | prepended to `open:` steps that begin with `/`; also `${baseUrl}` |
| `vars` | substituted as `${vars.X}` in specs (config env vars), over the top-level `vars:`; strings, numbers, booleans, lists or objects |
| `viewport` | browser viewport applied at run start (spec-level `viewport:` wins) |
| `services` | `false` disables all services for this env; a partial `services:` block deep-merges over the top-level one (`tmux: false` inside it drops only inherited local tmux windows, `docker: false` the docker phase, keeping the rest; `provisioner` merges key by key, `tunnels` / `files` replace as lists, and `false` removes any of them). Without a top-level `services:` block the environment's own block stands alone: only that environment boots services (a provisioner one environment owns), and `cairn config validate` lists what each environment boots (`environmentServices`) |
| `secrets` | replaces the top-level `secrets:` block for this env entirely |
| `policy` | what may run here: `trait`, `mutations`, `description` (see [Environment policy](#environment-policy)) |
| `auth` | the API sign-in the built-in `use: login` step runs (see [Environment login](#environment-login-auth)) |
| `runner` | a delegated runner: the environment runs elsewhere and the local `cairn` keeps the invocation (see [Delegated runner](#delegated-runner-runner)) |

The active environment is `--env <name>` (MCP `env`), else the spec's `environment:`, else `defaultEnvironment`, else `local`.

When a config file exists, an **explicit** `--env` (or the MCP `env` input) must name an environment defined under `environments:`. An unknown name is a config error that lists the known environments — `cairn run`, `spec verify`, `spec heal`, `discover`, and `snapshot` exit with code 4 (`cairn run` stops before any secret, service, hook, or spec starts, and under `--format json|yaml` still prints a schema-valid errored result) — instead of a run that silently has no `baseUrl` and no vars.

Defaults stay lenient. A spec's `environment:`, a `defaultEnvironment`, or the `local` fallback that the config does not define runs as before, without that environment's `baseUrl` and vars; `cairn run` (once per invocation), `spec verify`, `spec heal`, `discover`, and `snapshot` print a warning on stderr. `local` against a config that defines no environments at all, whether it is the scaffolded `environment: local` or an explicit `--env local`, is silent and runs without an environment. Without any config file, environment names are not checked.

### Environment policy

```yaml
version: 1
environments:
  local:
    baseUrl: http://localhost:8080
    policy: { trait: owned }
  dev:
    baseUrl: https://dev.example.test
    policy: { trait: shared, mutations: deny, description: team QA environment }
  prod:
    baseUrl: https://app.example.test
    policy: { trait: protected }
```

| Key | Effect |
|---|---|
| `trait` | `owned` (yours alone), `shared` (others use it) or `protected`: a spec runs in a protected environment only when its `requires.env` lists it |
| `mutations` | `allow` (default) or `deny`: refuses specs that declare `requires.mutates: true` |
| `description` | shown in refusals and `cairn spec verify` |

A spec declares the other half with `requires: { env: [...], mutates: true }`; a `requires.env` entry may be `{ <env>: { optIn: VAR } }`, allowed only when `VAR` is `1`/`true` in the caller's environment. `cairn run` refuses a spec before anything starts: status `refused`, and exit 7 when every spec of the run was refused; a batch where other specs ran keeps going unless `--strict-requires`. See [Authoring](/authoring#where-a-spec-may-run).

### Run policy (`run`)

`run:` (top level, and `environments.<name>.run` merged over it key by key) declares what a wrapper script around `cairn run` used to do, enforced by the run engine for the CLI and for MCP `cairn_run`:

| Key | Meaning |
|---|---|
| `lock` | `true`, `false` or `{ scope: config \| project, staleAfterPidDead }`: one run at a time per config (or per `project:`); a live foreign owner refuses with exit 4, a dead owner's lock is reclaimed with a warning. `cairn services up \| down \| restart` refuse (exit 4) while a live run holds it and hold it themselves otherwise |
| `preflight` | checks run after secrets and before any service: `{ json, assert }`, `{ secret }` (fetched from the vault under `secrets.provider: tvault`), `{ command, expectExit?, timeout? }`, `{ gate }`; the first failure refuses the run (exit 4) naming the check. `when: { suite, env }` (a name or a list) runs a check only for those suites / environments |
| `verifyClean` | `browsers`, `tmux`, `docker-project` (or `{ tmux: name }`, `{ docker-project: name }`): asserted before the run (dirty = exit 4) and after it (dirty = exit 9) |
| `finally` | commands run after the teardown with `CAIRN_EXIT_CODE` and `CAIRN_INVOCATION_DIR`; non-fatal; on SIGINT/SIGTERM too (bounded, `CAIRN_EXIT_CODE` 130/143) |

A policy guards one config: specs from several configs where any declares `run:` are refused (exit 4; run each config's specs in an invocation of their own, or pass `--config <path>` to run them all under one config — a suite's specs still load their nearest config, so `--suite` alone does not help). With a policy (or a critical teardown) the printed document waits for the final verdict and carries it: `exitCode` 8 / 9 and `invocationOutcome`. A SIGINT/SIGTERM before that verdict prints the documents of the iterations that finished, with `invocationOutcome.exitCode` 130 / 143.

`services.teardown` entries may be `{ run, critical: true, timeout, onSignal: wait }`: a failed critical entry is exit 8, above every verdict. The `assert` language, the exit-code precedence (8 > 9 > the run's own code), the events and `cairn doctor --orphans` are in [Services](/services#run-policy-run-lock-preflight-clean-machine-belts).

### Suites (`suites`)

`suites:` replaces the table a wrapper script keeps from a suite name to spec paths, and what it adds per environment. `cairn run --suite checkout --env staging` runs it. Spec paths next to `--suite` narrow it to those of its own specs, with its hooks, vars and labels (a path that is not one of its specs is a usage error, exit 2).

```yaml
version: 1
environments:
  local: {}
  staging: {}
suites:
  checkout:
    description: Checkout flows
    specs: [flows/checkout, flows/smoke/login.yml, payment-happy-path]
    tags: [critical]
    order: [login]
    parallel: 2
    bail: true
    requires: { env: [local, staging] }
    vars: { region: eu }
    processEnv: { REGION_MODE: "${env.REGION_MODE:-strict}" }
    labels: { cohort: "${env.REGION_MODE:-strict}" }
    env:
      staging:
        vars: { region: us }
        before: ["./tools/warm-cache.sh"]
        after: ["./tools/collect-diagnostics.sh"]
        hookTimeoutMs: 120000
        specs: [flows/checkout/smoke]
        bail: false
        processEnv: { REGION_MODE: relaxed }
        seed: { postCommands: { skip: [staging-fixture] } }
    seed: { postCommands: { skip: ["./tools/seed-extra.sh"] } }
```

| Key | Meaning |
|---|---|
| `specs` | a glob, an existing path (file, or a directory: everything below it; `dir/**` works too) or a spec `name`. Directories and globs skip drafts (`_` folders and files); a draft named by path runs |
| `tags` | keep specs whose `metadata.tags` include every tag (case-insensitive). Without `specs`, the suite is every spec of the project with those tags |
| `order` | these specs run first, in this order; the rest of the selection follows. An entry outside the selection is an error. Without `specs` and `tags`, `order` is the selection |
| `parallel`, `bail` | defaults for `--parallel` (the flag wins) and `--bail` (the flag adds to it; `--no-bail`, MCP `bail: false`, turns it off) |
| `requires` | `{ env, vars }`: the environments the suite may run in and vars that must be set (checked once the vault's secrets are in); a mismatch is exit 7 before anything starts |
| `vars` | vars for the run, under `--var` (in the specs and in the hooks' `CAIRN_SUITE_VAR_<NAME>` alike); the environment's `vars` win by name. They resolve once the vault's secrets are in; a var whose `${env.X}` is still unset is not passed (the config var of that name stays). Two names that reach hooks as one `CAIRN_SUITE_VAR_<NAME>` (`a-b`, `a_b`) are a validate error |
| `before`, `after`, `hookTimeoutMs` | commands run **once**: `before` after services and the webServer are up (a failure or timeout stops the run, exit 2), `after` on every exit path (a SIGINT/SIGTERM included) with `CAIRN_EXIT_CODE` — the specs' verdict; 8 / 9 settle after the teardown that follows — and services still up (non-fatal). Each runs in the config directory, bounded by `hookTimeoutMs` (default `--hook-timeout-ms`), with `CAIRN_SUITE`, `CAIRN_SUITE_VAR_<NAME>`, `CAIRN_INVOCATION_DIR`, `CAIRN_ENV` and `CAIRN_BASE_URL` set |
| `processEnv` | environment variables exported to every process of the run (preflight commands, the services phases, hooks, specs and their commands and verifiers); `${env.X}` in the config and specs resolves to them. `${env.X}` / `${vars.X}` in values resolve after the vault; an entry whose `${env.X}` is unset is not exported. `PATH`, `HOME`, `SHELL`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `TVAULT_*` and the variables cairn sets itself (`CAIRN_SUITE`, `CAIRN_SUITE_VAR_*`, `CAIRN_EXIT_CODE`, …) are refused. Only names are logged |
| `labels` | `key: value` pairs stamped on every run of the suite, before `suite=<name>` and the caller's `--label` (later wins) |
| `env.<name>` | `vars`, `before`, `after`, `hookTimeoutMs`, a `specs` list and `bail` that replace the suite's, `processEnv` / `labels` that merge over the suite's by name, and `seed.postCommands.skip` that adds to the suite's, for that environment. Hooks are the suite's, then the environment's. The name must be a defined environment |
| `seed.postCommands.skip` | seed post-commands this suite does not run: a named post-command by `name`, a plain string by its exact command text; one that matches nothing is a warning (put environment-only ones under `env.<name>.seed`) |

Specs resolve against the config directory. `cairn suites list [--env] [--json]` and `cairn catalog --kind suites` print the specs each suite resolves to per environment, or why one does not; `cairn config validate` reports a suite that resolves to nothing. `suites:` merges through `include:` like `fixtures:`. The journal records `suite.started`, `suite.hook.started|finished` and `suite.finished`, and `invocation.json` carries `suite`. Details are in [Services](/services#suites-cairn-run-suite).

### Metric probes (`metrics`)

`metrics:` declares numbers the run engine samples instead of an `--after` collector script:

```yaml
version: 1
environments:
  local: {}
metrics:
  - name: queue_depth
    command: ./tools/queue-depth.sh
    parse: { json: $.depth }           # or { regex: "depth=(\\d+)", unit: msgs }
    sample: [before, after]            # the default; or every: 5s
  - name: indexed_docs
    scope: invocation                  # spec (default) | invocation
    http:
      url: ${vars.searchUrl}/_stats
      auth: { bearer: "${secrets.SEARCH_TOKEN}" }
      json: { path: "$.indices[*].docs.count", reduce: sum }
    timeout: 5s
```

| Key | Meaning |
|---|---|
| `name` | letters, digits, `_`, `-`: the report keys are `<name>.delta` |
| `command` + `parse` | a shell command (config directory, the run's scoped environment; `${vars.X}` is not expanded here, the shell sees it literally); `parse` reads one number from stdout: `{ json: <path>, reduce? }` or `{ regex, group?, unit? }` |
| `http` | `{ url, headers?, auth: { bearer \| basic }, json: { path, reduce? } }`: a GET whose JSON answer holds the number. `${secrets.X}`, `${env.X}` and `${vars.X}` resolve at each sample |
| `reduce` | `sum`, `max`, `min` or `count`: required when the path selects several values |
| `sample` / `every` | `sample: [before, after]` (default both) or `every: <duration>` (at least 250ms): periodic samples plus one at each end, stopped when the scope ends |
| `scope` | `spec` (default): around each spec; `invocation`: around each iteration's specs |
| `timeout` | budget of one sample (default 10s, at most 5m) |

Each probe writes `<runDir>/diagnostics/metrics.json` (`urn:cairntrace.dev:metrics:v1`: before, after, delta, series stats, failures) and merges `<name>.before`, `<name>.after`, `<name>.delta` (and `.min`, `.max`, `.mean` for `every`) into `diagnostics/report.json` after the `--after` hooks, so `cairn stats --metric queue_depth.delta --group-by path` works (stats reads non-negative numbers; a negative delta stays in `metrics.json`). Invocation-scope rows also go to the journal's `metrics.json` and to every run of the iteration. A failing probe is recorded (warned once, `metric.sampled` with an error), never fatal; secrets and tokens are scrubbed from errors and artifacts. `environments.<name>.metrics` merges over the top-level list by name.

### Environment login (`auth`)

`environments.<name>.auth` is what a spec's `use: login` step runs when no imported action is named `login`. It signs the run in through the API, so the flow does not have to drive the sign-in form.

```yaml
version: 1
environments:
  local:
    baseUrl: http://localhost:3000
    auth:
      alreadyAuthenticated:              # optional: skip the login when this holds
        method: POST
        url: /api/session
        json: { "$.user.email": "${secrets.E2E_EMAIL}" }
      login:
        url: /api/login                  # method defaults to POST
        body: { email: "${secrets.E2E_EMAIL}", password: "${secrets.E2E_PASSWORD}" }
        expectStatus: 200
      after:                             # optional follow-ups, in order
        - id: otp
          when: { var: requests.login.body.user.mfa, equals: otp }
          request:
            method: PUT
            url: /api/otp/verify
            headers: { authorization: "Bearer ${requests.login.body.token}" }
            expectStatus: 200
      hydrate:                           # optional page script after a fresh login
        file: auth/hydrate.js            # or eval: "…"; sees args.login only
```

| Key | Effect |
|---|---|
| `alreadyAuthenticated` | `{ method (GET), url, headers?, body?, timeoutMs?, status?, json? }`: a probe sent first. When its status is in `status` (default any 2xx) and every `json` [matcher](/verifiers#matchers) holds, the login is skipped |
| `login` | `{ method (POST), url, headers?, body?, timeoutMs?, expectStatus?, retry?, capture? }`: the sign-in request; its response is `${requests.login.…}` |
| `after` | follow-up requests (`{ id?, when?, request }`, at most 20). `request` takes the [request step](/steps#request) fields except `until` and `matrix`; `when: { var, equals \| in \| exists }` reads runtime values such as `requests.login.body.…` |
| `hydrate` | `{ eval \| file, timeoutMs? }`: page JavaScript run once after a fresh login (`file` is relative to the config directory). It receives `args.login`, the login response body, and never the credentials. With nothing open yet, Cairntrace opens the app origin first |

Strings take `${secrets.X}` and `${env.X}` (the run environment, with the provider's secrets) and `${vars.X}` (config, spec and `use: { action: login, vars }` vars). They resolve when the step runs, and `${requests.<name>.…}` resolves per follow-up from the responses so far. Every secret value is registered for redaction before the first request is sent, and an unset one without a `:-default` fails the step before anything is sent. With `secrets.provider: tvault`, the names the auth block uses are fetched whenever a flow (or one of its imported actions) has `use: login`. See [`use: login`](/steps#environment-login-use-login) for the step side and [Export](/export) for the Playwright equivalent.

### Delegated runner (`runner`)

```yaml
version: 1
environments:
  local:
    baseUrl: http://localhost:8080
  remote:
    services: false
    runner:
      command: [bun, tools/remote-run.ts, --pool, "${vars.pool}"]
      env: { REMOTE_TOKEN: "${secrets.REMOTE_TOKEN}" }
      timeoutMs: 14400000
      idleTimeoutMs: 600000
      cancelGraceMs: 180000
    run: { lock: false }
vars: { pool: default }
```

| Key | Meaning |
|---|---|
| `command` | the runner's argv (never a shell string); `${env.X}`, `${secrets.X}`, `${vars.X}`, `${config.dir}` and `${baseUrl}` resolve when it is spawned |
| `cwd` | working directory, relative to the config directory (default: the config directory) |
| `env` | extra environment for the runner, resolved like `command`; `CAIRN_DELEGATE_*` / `CAIRN_INVOCATION_*` are reserved |
| `timeoutMs` | hard deadline for the whole runner (default: none); past it cairn cancels it like a Ctrl-C and the invocation exits 2 |
| `idleTimeoutMs` | the longest the events stream may stay silent, remote heartbeats included (min 1000; default: none, with a warning after 5 minutes); past it cairn cancels the runner like a Ctrl-C and the invocation exits 2 |
| `cancelGraceMs` | how long a cancel waits after SIGINT (sent to the runner's pid) before SIGTERM to its process group (default 180000) |

`cairn run --env remote` (and MCP `cairn_run`) resolves the suite and specs, checks the environment policy, takes the run lock (that environment's own; `run.lock: false` when the runner manages capacity) and runs `run.preflight` locally, then spawns the runner with `CAIRN_DELEGATE_REQUEST` / `CAIRN_DELEGATE_EVENTS` and relays the remote invocation into the local journal. No services, webServer, browser, suite hooks, metrics or `verifyClean` run locally; `run.finally` runs after the runner exited. An environment with a runner may not own a `services:` block (also one inherited through `extends`: set `services: false`), never runs a spec locally, and is never mixed with another environment in one invocation (exit 4). The exit code is checked against the stream and the copied run directories, never taken on the runner's word. The contract, the exit codes and how to write a runner are in [Delegated runners](/delegate).

### Engine pin (`requires`, `runtimes`)

`requires: { cairntrace: <semver range> }` names the cairn the config needs (`>=3.1`, `^3.1.0`, `3.x`, `>=3.0 <4`, `||`). A run, `cairn spec verify`, `cairn catalog`, any other command that loads the config and every MCP tool refuse an older (or newer) cairn with exit 4 and a message naming both versions; `cairn doctor` and `cairn config validate` report it. `runtimes.node: { path?, version? }` chooses the node binary of node scripts, `script` verifiers and transforms: `CAIRN_NODE` wins, then `path` (relative to the config directory), then the first `node` on PATH that satisfies `version`, then the highest matching install of nvm, fnm, volta, asdf, mise or Homebrew; a node that is missing or out of range is exit 4. See [Services](/services#engine-pin).

### Service operations (`services`)

`services.provisioner`, `services.tunnels`, `services.files`, the tmux window keys `restart` and `healthcheck.onUnhealthy` (and `tmux.columns` / `rows`), and the seed keys `phases`, `commit`, `target`, `expectOutput` and object `postCommands` are documented, with an example, in [Services](/services#service-operations-restart-logs-supervision) and [Services: seed transaction](/services#seed-transaction). Phase order is provisioner → tunnels → docker → files → seed → tmux.

## Fixtures

`fixtures:` declares test data that specs reference by name instead of
running ensure/clear/provision scripts in their preconditions. Each entry has
one adapter (`kind: exec | mongo | http`), the verbs it supports (`ensure`,
`reset`, `verify`, `teardown`), a `scope` (`run` by default, `suite` or
`seed`), optional `needs`, `with` parameters, `outputs`, an `owner` and a
`ttl`.

```yaml
version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:3000
datasources:
  appdb:
    kind: mongo
    docker: { service: mongo }
    database: demo
fixtures:
  demo_kit:
    kind: mongo
    datasource: appdb
    scope: seed
    with: { kitId: 6a0000000000000000000001 }
    owner: { marker: { cairnFixture: demo_kit } }
    ensure:
      - cloneDoc:
          collection: kits
          from: { kind: deliverable, cairnFixture: { $exists: false } }
          to: { _id: { $oid: "${with.kitId}" } }
    outputs: { kitId: "${with.kitId}" }
  kit_rows:
    kind: mongo
    datasource: appdb
    needs: [demo_kit]
    reset:
      - updateOne:
          collection: kits
          filter: { _id: { $oid: "${fixtures.demo_kit.kitId}" } }
          update: { $set: { rows: [] } }
        expect: { matched: 1 }
  workspace:
    kind: exec
    scope: suite
    ensure: { node: tools/create-workspace.mjs }
    teardown: { node: tools/delete-workspace.mjs, args: ["${fixtures.workspace.id}"] }
    outputs: { id: $.id }
```

A spec lists what it needs — `fixtures: [kit_rows.reset, workspace]` — and
splices outputs as `${fixtures.<name>.<key>}`. On an environment whose
`policy.trait` is `shared` or `protected`, mutating verbs are dry-run unless
`cairn run --allow-fixture-writes` or the reference says `write: true`;
under `policy.mutations: deny` they are always dry-run.
Every verb is recorded in `~/.cairntrace/fixtures/<project>.ledger.jsonl`,
which `cairn fixtures status` and `cairn fixtures sweep` read. See
[Fixtures](/fixtures) for the adapters, scopes, outputs and evidence.

## Placeholder resolution

For every `${baseUrl}`, `${env.X}`, `${vars.X}`, `${secrets.X}`, `${file.dir}` / `${project.root}`, or `${config.dir}` in a spec or an imported action:

- `${baseUrl}` → the active environment's `baseUrl`.
- `${env.X}` → the invocation environment. With `secrets.provider: tvault`, only `secrets.keys`, `secrets.required`, and names referenced in the root spec or its imported actions are resolved; they never mutate global `process.env`. `${env.X:-default}` resolves a default expression when the var is missing or empty; nested placeholders inside the default work.
- `${vars.X}` → merged vars, in priority order: CLI `--var key=value` (highest) > spec `vars:` > `environments.<env>.vars` (over its `extends` chain) > top-level config `vars:` > imported action `vars:` defaults. `${vars.X.key}` and `${vars.X.0}` read inside a list or object var (see [Composing a config](#composing-a-config)).
- `${secrets.X}` → the secrets bag (env or tvault-resolved).
- `${file.dir}` (alias `${project.root}`) → the directory of the **file being parsed**. In a spec that is the spec's directory; inside an imported action it is the action file's directory, not the spec's. Relative step paths (`upload.path`, `eval.file`, `transform.file`, …) resolve against the same directory.
- `${config.dir}` → the directory of the resolved `cairntrace.config.yml`: the explicit `--config` (MCP `config`) when given, else the one found by walking up from the spec's folder; the current working directory when there is no config. Use it for fixtures shared by specs and actions that live in different folders, e.g. `path: ${config.dir}/fixtures/import.xlsx`.

Each placeholder is resolved exactly once and emitted verbatim — a value that itself contains `${...}` stays inert, so there is no cross-secret injection. An unresolved `${vars.X}` fails at parse time with a typed error pointing at the spec line.

The config file's own text substitutes `${env.X}` / `${env.X:-default}` before it is parsed, and `${config.dir}` (the config file's directory) into the parsed values, so `vars: { fixtures: "${config.dir}/fixtures" }` gives every spec an absolute, machine-independent path — even when the directory name contains `#`, `:` or quotes.

### Sharing blocks with YAML merge keys

YAML anchors and merge keys (`<<: *anchor`) work anywhere in the file, so environments that differ in one or two values can share the rest:

```yaml
version: 1
environments:
  local:
    baseUrl: http://localhost:3000
    vars: &shared
      tenant: acme
      fixtures: "${config.dir}/fixtures"
  preview:
    baseUrl: http://localhost:4000
    vars:
      <<: *shared          # tenant + fixtures from local
      tenant: preview      # keys written here win over the merged ones
```

`cairn run`, every other command that reads config, and `cairn config validate` parse the file the same way, so a config that validates is the config a run sees.

## Composing a config

A config with several environments usually repeats most of its vars in each of them. Five additive features remove the copies; a config that uses none of them is read exactly as before (anchors and merge keys included).

```yaml
version: 1
include:
  - vars/*.yml                 # shared vars, fixtures, gates, datasources, suites
vars:                          # every environment gets these
  tenant: acme
  apiUrl: "${vars.host}/api"   # built from another var, per environment
  regions: [eu, us]            # typed: lists and objects
  admin: { email: admin@example.test, role: owner }
environments:
  local:
    baseUrl: http://localhost:3000
    vars: { host: http://localhost:3000 }
  tunnel:
    extends: local             # everything local has…
    waitScale: 3               # …plus what differs
  staging:
    extends: local
    baseUrl: https://staging.example.test
    vars: { host: https://staging.example.test, tenant: staging }
```

**Top-level `vars:`** apply to every environment. An environment's own `vars` override them by name, and so do the vars of the environment it `extends`. An environment that the config does not define (a spec's stale `environment:`) still gets the top-level vars.

**`environments.<name>.extends: <other>`** starts the environment from another one. Objects merge key by key (the extending environment wins), lists and scalars replace, `vars` merge by name (a var's value is replaced whole, never merged into), and `services: false` / `datasources.<name>: false` replace what they inherit. Chains are allowed (`tunnel` → `local`); an unknown name or a cycle is a config error. The merged environment is validated again, so an `extends` that produces an invalid block fails `cairn config validate`.

### Environment aliases

```yaml
version: 1
environments:
  local:
    baseUrl: http://localhost:3000
  chalupa:
    extends: local
    baseUrl: https://box.example.test
  remote: { alias: chalupa }   # cairn run --env remote == --env chalupa
```

**`environments.<name>: { alias: <target> }`** is the same environment under another name (`--env remote` for `chalupa`, a CI name for a local one). It is canonicalized to the target where `--env` is parsed (CLI, MCP and the Studio spawn path alike; also a spec's `environment:` and `defaultEnvironment`), so suites (`requires.env`, `env.<name>`), a spec's `requires.env` and the environment policy, seed and tunnel state keys, services and run locks, `CAIRN_ENV`, `cairn config vars --env` and the export's `CAIRN_ENV` guard all see the TARGET name. `run.json` carries `envAlias: <name>` (and `environment: <target>`), and so does `invocation.json` (`env` + `envAlias`); both are additive and absent when the real name was used. An alias takes no other key, names a real environment (no chains, no cycles), and nothing may `extends` it or name it in a suite: `cairn config validate` rejects each with the key path. `extends` is the other tool: it inherits and then overrides a NEW environment (own `baseUrl`, vars, policy, state keys), an alias copies nothing and is not a separate environment.

**Vars that reference vars.** `${vars.X}` inside a var value resolves once per environment, after the merge: in the example `apiUrl` is `http://localhost:3000/api` in `local` and `tunnel` and `https://staging.example.test/api` in `staging`. A value that is exactly one reference takes the referenced value with its type (`ids: "${vars.regions}"` is a list); inside a longer string a list or object renders as compact JSON. `${vars.X:-default}` falls back when `X` is not defined. A cycle (`a → b → a`) or a path missing inside a defined var is a config error that names the var and the environments. A reference to a var the config does not define is not: it is left for run time (`cairn config validate` warns, `var-reference`), and resolves from the authored template against the run's vars, so `runTag: "${vars.ticket}-smoke"` with `--var ticket=T-1` is `T-1-smoke` (still unset: the text stays, with a warning). `--var` and spec `vars:` otherwise override the final value of a var, not the inputs of another var's template. Var references are only read from what you wrote: a `${vars.X}` inside an `${env.X}` value or a secret stays as it is (never resolved, never an error).

**Typed vars.** A var may be a string, number, boolean, list or object (nested freely):

| Where `${vars.X}` appears | A list / object var becomes |
|---|---|
| an unquoted whole value in a spec or action (`ids: ${vars.regions}`), e.g. a script verifier's `fixtures:` | the list / object itself (`ctx.fixtures.ids` is an array) |
| a config fixture field that is exactly the placeholder | the list / object itself |
| a quoted or embedded placeholder, a URL, a header, a datasource field, an environment login template | compact JSON (`["eu","us"]`) |
| `${vars.X.key}` / `${vars.X.0}` anywhere | the value at that path (a missing path is a missing var) |

`ctx.vars` in a node script verifier carries typed vars as they are.

**`include: [paths or globs]`** merges the `vars`, `fixtures`, `gates`, `datasources` and `suites` of other YAML files. Paths are relative to the file that lists them; globs take `*`, `?` and `**` and match `.yml` / `.yaml` files in sorted order. Included files are validated entry by entry with the same schema (rules that span entries, such as a fixture's `needs` or gate references, run on the merged config), may include other files, and may not carry anything else. Entries merge by name: later files win and the including file wins over what it includes. Every override is reported as an `include-override` finding with both locations; a missing file or an include cycle is an error, a glob that matches nothing is a warning. `${config.dir}` in an included file is still the directory of `cairntrace.config.yml`.

**`environments.<name>.include: [paths or globs]`** is the same for one environment's own `vars`, for configs whose environments carry different var sets (a large local environment, a smaller dev, a handful in test) and would otherwise need every name promoted to top-level `vars:`, which leaks it into every environment and turns a var that one environment lacks from an unresolved reference (`cairn spec verify` fails there) into a defined one.

```yaml
version: 1
environments:
  local:
    baseUrl: http://localhost:3000
    include: [config/vars/local.yml]     # vars: { host: …, apiUrl: …, … }
  tunnel:
    extends: local                       # gets local's included vars too
    vars: { host: http://localhost:9080 }
  dev:
    include: [config/vars/dev.yml]
    vars: { region: dev-own }            # the environment's own vars win over its files
```

An environment file holds `vars:` (and may `include:` further files, which stay scoped to the same environment) and nothing else; a file that carries `fixtures`, `gates`, `datasources`, `suites` or `environments` is an error that names the file. The file shape is the one a top-level include uses, so `config/vars/local.yml` is also valid as `include: [config/vars/local.yml]` at the top level. Paths and globs resolve against the file that lists them; two environments may list the same file. An environment is always declared by the main config (there is no way to create one from an include), so `environments:` inside any included file is an error whose hint points here.

Precedence, lowest first, per environment: top-level `vars` (the config's own and its top-level includes) < the `extends` chain, root first, where each member contributes its included files in order and then the `vars` it writes itself < the environment's own included files in order < the `vars` the environment writes itself. `${vars.X}` references resolve afterwards, once per environment, across all of it. A var replaced inside one environment (a later file over an earlier one, or the environment's own `vars` over a file) is an `include-override` finding keyed `environments.<name>.vars.<var>` with both locations; a var that an environment overrides from the top level or from an extended environment is ordinary layering and not a finding. Missing files and include cycles are errors, a glob that matches nothing is a warning, and `${env.X}` in an environment file stays late-bound for `cairn export playwright` like anywhere else. The effective config an environment reads has no `include` key: it is already merged into `vars`.

### Listing vars: `cairn config vars`

```bash
cairn config vars                         # every var, every environment (markdown table)
cairn config vars --env staging --json    # one environment
cairn config vars --unused                # dead vars only
cairn config vars --used-by flows/checkout.yml
```

Each row has the var's `kind` (`string`, `number`, `boolean`, `list`, `object`, or `mixed` when environments disagree), its effective value per environment with the definition that wins there (`scope` and `file:line`, plus the authored `template` when it held `${env.X}` / `${vars.X}`), every definition (`definedAt`, lowest precedence first, `inheritedFrom` for merge keys and aliases), the definitions that win over an earlier one and where (`overriddenBy`), whether it is the same in every environment, and `usedBy`: specs, actions, script verifiers that read `ctx.vars.X`, config fixtures, datasources, gates, suites, environment logins, other config values and other vars. `unused: true` marks a var nothing uses, directly or through another var. Values that look like credentials (also under names with `password`, `pass`, `pw`, `token`, `secret`, … at any depth) are masked, and a var whose value carries environment data — an `${env.X}` / `${secrets.X}` anywhere in its definition, or a reference to such a var or to a credential-named one — shows its authored template instead of its value (`fromEnvironment: true`): an environment value is never printed. `--used-by <spec path or name>` keeps the vars that spec reaches through its own steps, its actions, the fixtures it lists (and their `needs`), its script verifiers, the environment login it uses, and the vars those are built from. JSON is the stable `urn:cairntrace.dev:config-vars:v1` document; MCP `cairn_config_vars` takes `config`, `env`, `unused`, `usedBy` and `limit`. An unknown `--env`, an unknown `--used-by` spec or an invalid config exits 4.

`cairn catalog --kind vars` lists the same vars per environment; a row the environment gets without writing it says `definedIn: top-level` or `extends` (with `inheritedFrom` and `file`). A var from the environment's own include file is `definedIn: environment` with `file` naming the include file and line.

## Where run-time settings actually live

Several settings that look like config actually live on the **spec**, not `cairntrace.config.yml`:

- `backend`, `mode`, `viewport`, `vars`, `environment`, `settleMs`, `coldStart`, `preconditions`, `session`, `redaction`, `metadata`, `artifacts` (capture policies, video, clip points) — all spec-root keys.
- `redaction:` on a spec is `{ headers?, queryParams?, storageKeys?, values? }`, not a regex list. Header, query-parameter, and storage-key names match case-insensitively; `values` are literal secret strings. These rules augment the built-in credential heuristics rather than replacing them.

Backend choice and capture policies are per-spec because they describe *what this flow observes*, not project plumbing. Project plumbing (environments, services, secrets, retention, integrations) is what goes in config.

## Validation

`cairn config validate` parses the file exactly like a run (`${env.X}` substitution, YAML merge keys, `${config.dir}`), then runs the zod schema plus cross-field `.refine()` rules:

- `secrets.provider: tvault` requires a `tvault:` block with either `project` (direct) or `group`+`env` (inheritance) — not both.
- `tmux` window names must be unique within a session.
- A `tmux` window with `readyOn` must specify at least one of `url` or `text`.
- `tmux.waitForReadyBeforeNext` defaults to false. When true, each window must satisfy `readyOn` before the next is booted; `readyTimeoutMs` remains one shared deadline for the complete sequence.
- An `xlsx` verifier (spec-side) requires at least one check: `contains`, `sheets`, a `headers` assertion, `rows`, `cells` or `validations`.
- `browser.appHandle` names are identifiers and each expression must parse.
- Gate references (`webServer.ready`, `services.docker.ready`, tmux `readyOn.gate` / `after`, gates naming other gates) must name entries of `gates:`, without cycles.
- Fixture `needs` must name known fixtures, without cycles, and never a shorter-lived scope (a `seed` fixture cannot need a `run` one); a `verify` verb may only read.
- An `environments.<env>.datasources` override must still form a complete entry once merged over the top-level one (`config validate` reports `environments.<env>.datasources.<name>: …`).
- `suites`: each suite needs `specs`, `tags` or `order`; `env.<name>` and `requires.env` name defined environments; every suite must resolve to specs in every environment it can run in (`cairn config validate` resolves them, and a `requires` refusal is not a problem).
- `metrics`: names are unique and dot-free, a probe has exactly one source (`command` with `parse`, or `http`), `sample` and `every` are exclusive, `every` is at least 250ms, regexes compile and JSON paths parse.
- `run.preflight` entries take exactly one of `json` (with `assert`), `secret`, `command` or `gate`; an `assert` must parse (the error names the offset); a `gate` must name an entry of `gates:`; `run.verifyClean` entries are `browsers`, `tmux` or `docker-project`.
- `environments.<name>.alias` names a defined, real environment: not itself, not another alias (chains and cycles are errors), combined with no other key (`baseUrl`, `vars`, `include`, `extends`, … belong on the target), never the `extends` of another environment and never named by a suite (`requires.env`, `env.<name>`): a suite names the target.
- Composition: every `include:` file (top-level and `environments.<name>.include`) must exist and parse, without include cycles; `extends` must name a defined environment, without cycles; every `${vars.X}` inside a var value must resolve in each environment, without cycles. Errors name the file (`shared/vars.yml: vars.x: …`) or the var and environments.

Valid configs can still carry warnings: a suite whose `requires.env` admits an environment with no `env.<name>` block while another admitted environment has one (`suite-env-fallback`: a run there silently takes the suite-level specs, vars and hooks; add `env.<name>` (an empty `{}` says the defaults are intended) or drop the environment from `requires.env`), vars that nothing uses (dead vars, `vars.<name> is not used …`, with where they are defined, an environment include file's `file:line` included), include globs that match no file (top-level or per environment), and an authored `${vars.X}` in a config field that never expands it (`literal-var-ref`, naming the field path: `environments.local.baseUrl holds ${vars.host}, …`). `${vars.X}` expands in specs, actions, fixtures, gates, datasources, suites, `http` metric probes, environment `auth` and inside other vars; every other config value, `baseUrl`, `webServer`, `services`, `run`, hooks and a metric `command` included, is read as written, so the run would open `${vars.host}/app` literally. Write the value or use `${env.X:-default}` there. Include overrides are listed under `findings` (`level: info`); `includes` lists the files that were merged.

Run it in CI before `cairn run` so a malformed config fails fast instead of mid-run.

## See also

- [Steps](/steps) / [Verifiers](/verifiers) — the spec vocabularies (spec-root keys, not config)
- [Services](/services) — the `services:` lifecycle in depth
- [Delegated runners](/delegate) — `environments.<n>.runner` and the `urn:cairntrace.dev:delegate:v1` contract
- [Fixtures](/fixtures) — the `fixtures:` registry and `cairn fixtures`
- [Verifiers](/verifiers#datasources) — the `datasources:` block the `mongo`, `temporal` and `http` verifiers read
- [Services](/services#readiness-gates) — the `gates:` registry and `cairn wait`
- [Secrets](/secrets) — the `secrets:` / `tvault:` blocks
- [Stash](/stash) / [Clip](/clip) / [Investigate](/investigate) / [Annotate](/annotate) — the integration blocks
- [Doctor & clean](/doctor) — `retention.keepRuns` and the `cairn clean` it feeds
- [Troubleshooting](/troubleshooting) — "Redaction layer rejected your config pattern" and other config errors
