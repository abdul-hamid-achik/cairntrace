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
    vars: { allowed_countries: [US, MX] }
    viewport: { width: 1280, height: 800 }
  staging:
    baseUrl: https://staging.app.com
    services: false                    # disable all services for this env (app is remote)
    secrets: { provider: tvault, tvault: { group: payments, env: prod } }

secrets:                              # default secrets block (an env-level secrets replaces it)
  provider: env                       # env | tvault
  required: [API_KEY, DB_URL]         # fail the run if these are unset/empty
  tvault:                             # required when provider: tvault
    project: my-app                    # direct mode — OR —
    # group: payments                  # inheritance mode (requires env)
    # env: prod

retention: { keepRuns: 10 }           # prune to newest N runs/spec after every run

report:
  theme: cairn                        # cairn | graphite | midnight | contrast
  colors: { accent: "rgb(94,129,172)", danger: "#c0392b" }   # optional CSS token overrides

webServer:                            # optional single-server lifecycle for `cairn run`
  command: "node .output/server/index.mjs"
  build: "bun run build"               # run once before command (skipped when reusing)
  url: http://localhost:3000           # readiness probe (defaults to the env baseUrl)
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
    windows:
      - { name: web, cwd: web-app, command: "yarn serve", readyOn: { url: http://localhost:8080 } }
  teardown: ["tmux kill-session -t myapp", "docker compose down"]
  stash: { enabled: true, autoStash: always, capture: [tmux, docker, seed] }

stash:                                # fcheap run-artifact stash — see Stash page
  enabled: true
  autoStash: on-failure               # on-failure | never
  tags: [regression, audit]

clips:                                # vidtrace video clip points — see Clip page
  points:
    - { label: failure, start: "0:12", end: "0:18" }
  tags: [regression]

investigate:                          # fcheap connect + vecgrep — see Investigate page
  codebaseDir: ./src                   # default codebase for `cairn investigate --connect`
  mode: hybrid                         # semantic | keyword | hybrid
  limit: 10
  autoInvestigate: on-failure          # on-failure | never

annotate:                             # codemap annotation — see Annotate page
  enabled: true
  autoAnnotate: on-run                 # on-run (pass+fail) | on-investigate | never
  source: cairntrace
```

The schema is `.strict()` at every level, so a misspelled key (e.g. `browser:` or `run:` — neither exists) is a validation error, not a silent no-op.

## Environments

`environments` is a required record of `name → EnvironmentConfig`. Each environment can carry:

| Key | Effect |
|---|---|
| `baseUrl` | prepended to `open:` steps that begin with `/`; also `${baseUrl}` |
| `vars` | substituted as `${vars.X}` in specs (config env vars) |
| `viewport` | browser viewport applied at run start (spec-level `viewport:` wins) |
| `services` | `false` disables all services for this env; a partial `services:` block deep-merges over the top-level one |
| `secrets` | replaces the top-level `secrets:` block for this env entirely |

The active environment is `--env <name>`, else `defaultEnvironment`, else `local`.

## Placeholder resolution

For every `${baseUrl}`, `${env.X}`, `${vars.X}`, or `${secrets.X}` in a spec:

- `${baseUrl}` → the active environment's `baseUrl`.
- `${env.X}` → `process.env` (with tvault secrets injected when `secrets.provider: tvault`). `${env.X:-default}` resolves a default expression when the var is missing or empty; nested placeholders inside the default work.
- `${vars.X}` → merged vars, in priority order: CLI `--var key=value` (highest) > spec `vars:` > `environments.<env>.vars`.
- `${secrets.X}` → the secrets bag (env or tvault-resolved).

Each placeholder is resolved exactly once and emitted verbatim — a value that itself contains `${...}` stays inert, so there is no cross-secret injection. An unresolved `${vars.X}` fails at parse time with a typed error pointing at the spec line.

## Where run-time settings actually live

Several settings that look like config actually live on the **spec**, not `cairntrace.config.yml`:

- `backend`, `mode`, `viewport`, `vars`, `environment`, `preconditions`, `session`, `redaction`, `metadata`, `artifacts` (capture policies, video, clip points) — all spec-root keys.
- `redaction:` on a spec is `{ headers?, queryParams?, storageKeys?, values? }` (arrays of strings to scrub), not a regex list.

Backend choice and capture policies are per-spec because they describe *what this flow observes*, not project plumbing. Project plumbing (environments, services, secrets, retention, integrations) is what goes in config.

## Validation

`cairn config validate` runs the zod schema plus cross-field `.refine()` rules:

- `secrets.provider: tvault` requires a `tvault:` block with either `project` (direct) or `group`+`env` (inheritance) — not both.
- `tmux` window names must be unique within a session.
- A `tmux` window with `readyOn` must specify at least one of `url` or `text`.
- An `xlsx` verifier (spec-side) requires `sheets` or `validations`.

Run it in CI before `cairn run` so a malformed config fails fast instead of mid-run.

## See also

- [Steps](/steps) / [Verifiers](/verifiers) — the spec vocabularies (spec-root keys, not config)
- [Services](/services) — the `services:` lifecycle in depth
- [Secrets](/secrets) — the `secrets:` / `tvault:` blocks
- [Stash](/stash) / [Clip](/clip) / [Investigate](/investigate) / [Annotate](/annotate) — the integration blocks
- [Doctor & clean](/doctor) — `retention.keepRuns` and the `cairn clean` it feeds
- [Troubleshooting](/troubleshooting) — "Redaction layer rejected your config pattern" and other config errors