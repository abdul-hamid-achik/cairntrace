# Services

`cairn services` owns the multi-service environment a spec pool needs: docker, conditional data seeding, and tmux session management — all config-driven, started once before the pool and stopped after the last spec. `cairn services status` is the read-only check; the lifecycle itself runs automatically on `cairn run` unless disabled.

## `cairn services status`

```bash
cairn services status
cairn services status --config ./cairntrace.config.yml --project my-app
```

Reports the current state of the configured services environment (docker, seed freshness, tmux session). `--project <name>` overrides the project name (default: from config); `--config <path>` picks an explicit config. Output supports `--format json|yaml|md`.

## The lifecycle (on `cairn run`)

When `services:` is configured, `cairn run` starts the environment once, runs the spec pool, then tears it down. The phases:

```yaml
version: 1
environments:
  local: {}
services:
  docker:
    command: "docker compose up -d"
    reuseExisting: true
    readinessCheck: "curl -sf http://localhost:27017"
    healthcheck:
      command: "curl -sf http://localhost:9200/_cluster/health | grep -q green"
      intervalSeconds: 15
      retries: 5
  seed:
    command: "yarn demo-import"
    ttlSeconds: 21600
    freshnessCheck: "mongosh --quiet --eval 'db.count()' mongodb://localhost:27017/db"
    # Always run after seed (even when skipped as fresh) — lightweight fixture ensure.
    postCommands:
      - "mongosh mongodb://localhost:27017/db --quiet tools/ensure-fixture.js"
  tmux:
    session: myapp
    reuseExisting: true
    options:
      - { key: mouse, value: "on" }
    env:
      NODE_ENV: development
    windows:
      - name: web
        cwd: web-app
        command: "yarn serve"
        readyOn: { url: http://localhost:8080 }
        healthcheck:
          command: "curl -sf http://localhost:8080/healthz"
          intervalSeconds: 20
          retries: 3
  stash:
    enabled: true
    autoStash: always
    capture: [tmux, docker, seed]
    tags: [services, myapp]
  teardown:
    - "tmux kill-session -t myapp"
    - "docker compose down"
```

- **docker** — `command` runs once; `reuseExisting: true` skips if the readiness check already passes. `readinessCheck` gates startup; `healthcheck` polls until green or `retries` is exhausted.
- **seed** — runs after docker is healthy. Freshness is tracked at `~/.cairntrace/services/<project>.seed.json` with a three-layer check (fingerprint + TTL + optional data-level command). A fresh-enough seed is reused; otherwise the seed command re-runs. Optional `postCommands` always run after that decision (skip or complete) — use them for lightweight fixture ensure scripts the bulk import does not ship.
- **tmux** — a named session with one or more windows, each with its own `cwd`, `command`, `readyOn`, and `healthcheck`. `readyOn` can be `{ url }` or `{ text }`. On reuse, missing windows are created and idle panes (shell prompt, no running service) are re-launched; busy panes are left alone. If docker was freshly started this run, the whole session is recreated so app processes reconnect to new containers. Cairn waits for the interactive shell before `send-keys` and clears pane history first so `readyOn` text cannot match stale scrollback.
- **stash** — optionally saves session artifacts (tmux panes, docker logs, seed
  output) in the local file.cheap vault. It does not upload or replicate them.
- **teardown** — after the last spec. When tmux reuse is on (the default), cairn leaves the session alive and also skips `docker compose down` so infra the live panes need is not torn out from under them. With `tmux.reuseExisting: false`, full teardown runs (tmux kill + docker down).

## Skipping and per-environment overrides

```bash
cairn run flows/x.yml --no-services           # skip the whole lifecycle
cairn run flows/x.yml --services-dry-run       # print the plan, do not execute
```

Per-environment overrides replace `--no-services` for remote envs:

```yaml
version: 1
services:
  tmux:
    session: myapp
    windows:
      - name: web
        command: "bun run dev"
environments:
  dev:
    services: false          # disable all services (app is already deployed remotely)
  staging:
    services:                # partial block deep-merges over the top-level one
      seed:
        command: "bun run seed:staging"
        ttlSeconds: 3600
    secrets:                 # an env-level secrets block REPLACES the top-level one
      provider: tvault
      tvault:
        project: myapp-staging
```

A partial `services:` block deep-merges over the top-level one. An env-level `secrets:` block replaces the top-level one entirely.

## TinyVault seeding

`secrets.provider: tvault` resolves only the invocation's explicit
`secrets.keys`, `required`, and root-spec/imported-action placeholder names, then supplies that
scoped set to the seed command. It never exports a whole project or mutates
global `process.env`; publisher-only and TinyVault client-control variables
are removed from service children. The `tvault:` block supports direct
(`project`) or inheritance (`group` + `env`) mode. See [Secrets](/secrets) for
the status command and the `cairn secrets` diagnostic.

## Validation

`cairn config validate --json` validates the config file — the zod schema plus cross-field `.refine()` rules: unique window names, `readyOn` constraints, and `tvault` provider requires a `tvault:` block with either `project` or `group`+`env`. Run it before relying on a services block in CI.

## See also

- [Configuration](/configuration) — the `services:` schema and env resolution
- [Secrets](/secrets) — the TinyVault integration the seed step uses
- [Stash](/stash) — `services.stash` persists session artifacts to fcheap
