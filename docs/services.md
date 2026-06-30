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
- **seed** — runs after docker is healthy. Freshness is tracked at `~/.cairntrace/services/<project>.seed.json` with a three-layer check (fingerprint + TTL + optional data-level command). A fresh-enough seed is reused; otherwise the seed command re-runs.
- **tmux** — a named session with one or more windows, each with its own `cwd`, `command`, `readyOn`, and `healthcheck`. `readyOn` can be `{ url }` or `{ text }`.
- **stash** — optionally stashes session artifacts (tmux panes, docker logs, seed output) to fcheap.
- **teardown** — runs in reverse order (tmux kill → docker down) after the last spec.

## Skipping and per-environment overrides

```bash
cairn run flows/x.yml --no-services           # skip the whole lifecycle
cairn run flows/x.yml --services-dry-run       # print the plan, do not execute
```

Per-environment overrides replace `--no-services` for remote envs:

```yaml
environments:
  dev:
    services: false          # disable all services (app is already deployed remotely)
  staging:
    services:                # partial block deep-merges over the top-level one
      tmux:
        session: myapp-staging
    secrets:                 # an env-level secrets block REPLACES the top-level one
      provider: tvault
```

A partial `services:` block deep-merges over the top-level one. An env-level `secrets:` block replaces the top-level one entirely.

## TinyVault seeding

`secrets.provider: tvault` injects vault secrets into the seed command's env the first time the run path needs them. The `tvault:` block supports direct (`project`) or inheritance (`group` + `env`) mode. See [Secrets](/secrets) for the status command and the `cairn secrets` diagnostic.

## Validation

`cairn config validate --json` validates the config file — the zod schema plus cross-field `.refine()` rules: unique window names, `readyOn` constraints, and `tvault` provider requires a `tvault:` block with either `project` or `group`+`env`. Run it before relying on a services block in CI.

## See also

- [Configuration](/configuration) — the `services:` schema and env resolution
- [Secrets](/secrets) — the TinyVault integration the seed step uses
- [Stash](/stash) — `services.stash` persists session artifacts to fcheap