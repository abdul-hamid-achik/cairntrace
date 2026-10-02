---
title: Configure Cairntrace Browser Testing
description: Configure projects, environments, browser backends, artifacts, services, secrets, logging, retention, and reports for Cairntrace behavioral specs.
---

# Configuration

Every cairntrace surface reads from a single config source: `cairntrace.config.yml`. The file is **optional** — a spec with absolute URLs runs without one — but anything project-specific (environments, services, secrets, retention, integrations) lives there. The schema is strict: unknown top-level keys are rejected, so a typo fails `cairn config validate` instead of silently being ignored.

```bash
cairn config validate --json          # validate structure + cross-field rules
cairn config validate --config ./cairntrace.config.yml
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

environments:                         # required — at least one environment
  local:
    baseUrl: http://localhost:3000
    vars: { allowedCountry: US, retryCount: 3, useSandbox: true }
    viewport: { width: 1280, height: 800 }
  staging:
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

stash:                                # fcheap run-artifact stash — see Stash page
  enabled: true
  autoStash: on-failure               # on-failure | never
  tags: [regression, audit]

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

## Environments

`environments` is a required record of `name → EnvironmentConfig`. Each environment can carry:

| Key | Effect |
|---|---|
| `baseUrl` | prepended to `open:` steps that begin with `/`; also `${baseUrl}` |
| `vars` | substituted as `${vars.X}` in specs (config env vars) |
| `viewport` | browser viewport applied at run start (spec-level `viewport:` wins) |
| `services` | `false` disables all services for this env; a partial `services:` block deep-merges over the top-level one (`tmux: false` inside it drops only inherited local tmux windows, keeping docker/seed) |
| `secrets` | replaces the top-level `secrets:` block for this env entirely |
| `policy` | what may run here: `trait`, `mutations`, `description` (see [Environment policy](#environment-policy)) |

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
- `${vars.X}` → merged vars, in priority order: CLI `--var key=value` (highest) > spec `vars:` > `environments.<env>.vars` > imported action `vars:` defaults.
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
- An `xlsx` verifier (spec-side) requires `sheets` or `validations`.
- Gate references (`webServer.ready`, `services.docker.ready`, tmux `readyOn.gate` / `after`, gates naming other gates) must name entries of `gates:`, without cycles.
- Fixture `needs` must name known fixtures, without cycles, and never a shorter-lived scope (a `seed` fixture cannot need a `run` one); a `verify` verb may only read.
- An `environments.<env>.datasources` override must still form a complete entry once merged over the top-level one (`config validate` reports `environments.<env>.datasources.<name>: …`).

Run it in CI before `cairn run` so a malformed config fails fast instead of mid-run.

## See also

- [Steps](/steps) / [Verifiers](/verifiers) — the spec vocabularies (spec-root keys, not config)
- [Services](/services) — the `services:` lifecycle in depth
- [Fixtures](/fixtures) — the `fixtures:` registry and `cairn fixtures`
- [Verifiers](/verifiers#datasources) — the `datasources:` block the `mongo`, `temporal` and `http` verifiers read
- [Services](/services#readiness-gates) — the `gates:` registry and `cairn wait`
- [Secrets](/secrets) — the `secrets:` / `tvault:` blocks
- [Stash](/stash) / [Clip](/clip) / [Investigate](/investigate) / [Annotate](/annotate) — the integration blocks
- [Doctor & clean](/doctor) — `retention.keepRuns` and the `cairn clean` it feeds
- [Troubleshooting](/troubleshooting) — "Redaction layer rejected your config pattern" and other config errors
