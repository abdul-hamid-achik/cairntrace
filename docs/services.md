# Services

`cairn services` owns the multi-service environment a spec pool needs: docker, conditional data seeding, and tmux session management — all config-driven, started once before the pool and stopped after the last spec. `cairn services status` is the read-only check; the lifecycle itself runs automatically on `cairn run` unless disabled. `cairn services up` / `down` keep the stack running between runs when you explore against it.

## `cairn services status`

```bash
cairn services status
cairn services status --config ./cairntrace.config.yml --env local
cairn services status --config ./cairntrace.config.yml --project my-app
```

Reports the current state of the configured services environment (docker, seed freshness, tmux session) for one environment: `--env <name>` (default: the config's `defaultEnvironment`, else `local`) selects its effective `services` block, per-environment overrides applied. It also reports the config's `cairn services up` owner `lock`: `state` (`absent`, `held`, `unreadable`), who holds it, for which `env` and since when (`ageSeconds`). A lock held for this environment also gets a quick liveness look — with the environment's scoped secrets, like a run — and `stale: true` with the `problems` when the services it owns are not actually up; a phase it cannot see is listed under `unchecked` and trusted. `--project <name>` overrides the project name (default: from config); `--config <path>` picks an explicit config. Output supports `--format json|yaml|md`.

## Keeping services up: `cairn services up` / `down`

Exploring a page (`cairn discover`, accompany sessions, manual checks) needs the stack up between runs, while a normal `cairn run` starts it and tears it down. `services up` boots it once and hands ownership to an explicit lock:

```bash
cairn services up --env local                       # docker → seed → tmux, left running
cairn discover /login --env local                   # explore against the warm stack
cairn run flows/new.yml --env local --reuse-services  # warm stack, cold browser
cairn services down --env local                     # full teardown, lock removed
```

- **`cairn services up [--config <path>] [--env <name>]`** starts docker, seed and tmux through the same code path as `cairn run` (same reuse rules, scoped TinyVault secrets, redacted narration on stderr), leaves them running, and writes the config's owner lock atomically: `{version: 1, owner: "services-up", project, env, configPath, startedAt, pid, by: "cli" | "mcp"}`. There is one lock per config file, `~/.cairntrace/services/<config dir>.<hash>.lock.json`, keyed by the config's resolved path, so two repos never share one, even when their `project:` names match or are both unset. `pid` is informational — the command exits once the services are up. Running `up` again for the same environment re-runs the boot (healing missing or idle tmux windows) and refreshes the lock. A failed boot tears down what it started and writes no lock (exit 2). Exit 4 covers three cases: no config found from the working directory, an unknown `--env`, and an environment without services. An explicit `--config` that does not exist or cannot be read is exit 2.
- **Environments share the lock.** Environments inherit the config's compose project and tmux session, so `up` for another environment of the same config refuses with exit 4 while the lock is held.
- **While the lock exists**, `cairn run` for the locked environment refuses with exit 4 and a message naming the lock: it would otherwise start and tear down a stack it does not own. So does a run of any other environment of the config. The refusal comes before any hook, service, webServer or browser starts; scoped TinyVault secrets are already resolved, and the invocation journal records the refusal. When the services behind the lock are no longer up (a reboot, a crash), the refusal says the lock is stale and names what is down. Under `--format json|yaml` the refused run still prints a schema-valid errored `RunResult` (or `BatchRunResult` for several specs) with `failure.phase: "invocation"`, as does a services or webServer boot failure (exit 2); MCP `cairn_run` returns the same document, and `--junit` is written. `--no-services` and environments with `services: false` are not affected. `--services-dry-run` prints a `lock:` line (would reuse / would refuse) instead of refusing; it does not check liveness. `cairn audit` follows the same rules and takes `--reuse-services` too.
- **`cairn run --reuse-services`** (MCP `cairn_run` `reuseServices: true`) runs against the locked stack. First it takes one quick readiness look:
  - the docker `readinessCheck`. Without one, a Compose command is checked with `docker compose ps`, using the command's own `-f` / `-p` / `--project-directory` / `--env-file` options and `docker.env`. A command it cannot read (shell operators, a wrapper script) or a `ps` that fails is trusted and logged as unchecked; set `readinessCheck` for an exact check;
  - the tmux session and every window, with no pane that died or fell back to an idle shell;
  - `readyOn.url` answering 2xx/3xx (any answer with `anyResponse: true`), and one look at each `readyOn.gate` and `docker.ready` gate.

  Then it starts nothing and tears nothing down, and the browser starts cold (unless `coldStart` is set explicitly). Its events say so: `services.docker.reuse`, `services.seed.skip`, `services.tmux.reuse`, never a `start` or `teardown` event; run-local service evidence still records the reused session. A **stale lock** (the services it owns are not up) fails with exit 4 and names what is down. So do `--reuse-services` without a lock, a lock held for another environment, and an unreadable lock file.
- **`cairn services down [--config <path>] [--env <name>]`** is the full teardown. It runs the configured `teardown` commands in order, without the reuse skipping a run applies, so `docker compose down` runs when the config lists it. A `docker` phase that no teardown command stops gets a warning, because its containers keep running. Then it runs `tmux kill-session` if the session is still alive, and removes the lock. It also stops a stack a normal run left alive for reuse (no lock needed). While the lock is held for another environment it refuses with exit 4 and tears nothing down. A failing teardown command is reported with exit 2; the rest still runs and the lock is still removed.

Both commands support `--format json|yaml|md` (`urn:cairntrace.dev:services-up:v1` with `phases`, `lock` and redacted lifecycle `events`; `urn:cairntrace.dev:services-down:v1` with `teardown[]`, `tmuxKilled` and `removedLock`). MCP agents use `cairn_services_up` / `cairn_services_down` (`config`, `env`); they wait for a `cairn_run` of the same server that holds the same config, and they refuse unless the server runs as `cairn mcp --allow-services` (or with `CAIRN_MCP_ALLOW_SERVICES=1`). The same flag gates the services boot of MCP `cairn_run`, `cairn_spec_finish` and `cairn_audit`: without it, a call whose config would start services fails with exit 4 before anything starts (pass `noServices` or `reuseServices`). For environments whose services provision paid or shared infrastructure, also mark the environment `policy: { trait: protected }` and list it in the specs' `requires.env` with an `optIn` variable that only your own driver sets.

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
    waitForReadyBeforeNext: true # opt-in: gate each later window on prior readyOn
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
  artifacts:
    when: on-failure
    capture: [lifecycle, tmux, docker, seed]
    maxLinesPerSource: 2000
    maxBytesPerSource: 524288
    maxBytesPerRun: 8388608
  stash:
    enabled: true
    autoStash: always
    capture: [tmux, docker, seed]
    tags: [services, myapp]
  teardown:
    - "tmux kill-session -t myapp"
    - "docker compose down"
```

- **docker** — `command` runs once; `reuseExisting: true` skips if the readiness check already passes. `readinessCheck` gates startup and is polled (1s cadence) until it exits 0 or the phase deadline (`readyTimeoutMs`, 0 = indefinite) is reached — containers routinely need a few seconds after `Started` before they accept connections. `ready` lists [readiness gates](#readiness-gates) waited after it — also when running containers are reused. `healthcheck` keeps polling after readiness until green or `retries` is exhausted.
- **seed** — runs after docker is healthy. Freshness is tracked at `~/.cairntrace/services/<project>.seed.json` with a three-layer check (fingerprint + TTL + optional data-level command). A fresh-enough seed is reused; otherwise the seed command re-runs. Optional `postCommands` always run after that decision (skip or complete) — use them for lightweight fixture ensure scripts the bulk import does not ship.
- **tmux** — a named session with one or more windows, each with its own `cwd`, `command`, `readyOn`, `after`, and `healthcheck`. `readyOn` can be `{ url }` (a 2xx/3xx answer, see [readiness gates](#readiness-gates)) or `{ text }`; either one is enough. `readyOn.gate` adds a gate that must also pass. `after: [gates]` delays booting the window until those gates pass (the database a worker connects to). By default Cairn boots every window before waiting for readiness. Set `waitForReadyBeforeNext: true` to boot in declaration order and wait for each window's `readyOn` before creating or starting the next; all windows share the single `readyTimeoutMs` deadline, and a dead/disappeared pane fails immediately. On reuse, missing windows are created and idle panes (shell prompt, no running service) are re-launched; busy panes are left alone. If docker was freshly started this run, the whole session is recreated so app processes reconnect to new containers. Cairn waits for the interactive shell before `send-keys` and clears pane history first so `readyOn` text cannot match stale scrollback.
- **artifacts** — saves bounded, redacted lifecycle, docker/provisioner command output, tmux, local Compose, and seed/post-command evidence inside each run while the services are still alive. A remote provisioner such as Chalupa retains its launch/tunnel transcript without probing an unrelated local Compose project. The block is optional and defaults to `when: on-failure`, all four sources, 2,000 lines and 512 KiB per source, and 8 MiB total per run. Set `when: always` while stabilizing a suite or `never` to disable it. Collection errors are recorded in `services/manifest.json` and never change the test verdict.
- **stash** — optionally saves session artifacts (tmux panes, docker logs, seed
  output) in the local file.cheap vault. It does not upload or replicate them.
- **teardown** — after the last spec. When tmux reuse is on (the default), cairn leaves the session alive and also skips `docker compose down` so infra the live panes need is not torn out from under them. With `tmux.reuseExisting: false`, full teardown runs (tmux kill + docker down). The same commands run when a phase fails mid-boot (failure cleanup). Each command leaves a `services.teardown.complete` / `services.teardown.fail` event (`index`, `exitCode`, `durationMs`) in the invocation journal, and its redacted output in `logs/services-teardown.log`.
- **teardown on SIGINT / SIGTERM** — the process is exiting, so cairn runs a synchronous teardown: it kills the tmux session it created, then waits up to `CAIRN_SERVICES_SIGNAL_GRACE_MS` (default 5000) for a boot command that is still running (docker, seed, readiness check, healthcheck, post-command) to exit. A terminal Ctrl-C reached that command too, and a provisioner that is cancelling its `up` holds its state lock until it exits, so a teardown started meanwhile would race it. cairn sends it no signal of its own, because a second signal turns a graceful cancel into a forced one. A command still running after the grace keeps running, as in 2.x, and the teardown proceeds. Then cairn runs the teardown commands that have not run yet, each capped at `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` (default 10000). Teardown commands (normal, failure cleanup, signal path) run detached: in their own process group and session, with no terminal and their output in a private temp file, so the Ctrl-C or group SIGTERM that stops cairn does not kill a provisioner's `down` halfway, and one still running after cairn exits does not die on a closed pipe. A teardown command must therefore not prompt. When the signal lands while the normal teardown runs a command, cairn waits up to `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` for it and never starts a second copy while it is alive, because two copies of a provisioner's `down` race for its state lock; past the wait it is left to finish in the background (the event names its output file). If nothing of it is left (something killed its process group), cairn runs it again. Each step is recorded as a `services.teardown.signal` event (`kind: boot` with `exited`; or `index` with `status: completed | failed | timed-out | finished | in-flight | re-run`), with the output in `logs/services-teardown.log`. Raise both budgets for slow remote provisioners, for example `CAIRN_SERVICES_SIGNAL_GRACE_MS=180000 CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS=240000` when `up` / `down` create and destroy cloud machines, so the teardown starts after the cancelled `up` released its lock and `down` can finish.

## Readiness gates

A readiness gate is a typed probe with a waiting policy, declared once in the config's top-level `gates:` registry and referenced by name (or written inline) wherever something has to be ready:

```yaml
version: 1
environments:
  local: {}
gates:
  mongo:
    tcp: localhost:27017
  search:
    http:
      url: http://localhost:9200/_cluster/health
      json: { status: { in: [yellow, green] } }
  broker:
    all:
      - tcp: localhost:5672
      - http:
          url: http://localhost:15672/api/health/checks/alarms
          auth: { basic: "${secrets.BROKER_USER}:${secrets.BROKER_PASSWORD}" }
  web:
    all:
      - http: http://localhost:8080/
      - http: { url: http://localhost:8080/api/session, status: [200, 401, 403] }
    stable: 2       # two passing attempts in a row
    every: 2s       # pause between attempts (default 1s)
    timeout: 5m     # budget of the wait (default 60s; 0 = no deadline)
  worker:
    command: { run: "curl -fsS http://127.0.0.1:9005/ready", exitCode: 0 }
    stable: 3

services:
  docker:
    command: docker compose up -d
    ready: [mongo, search, broker]
  tmux:
    session: myapp
    windows:
      - name: worker
        command: bun run worker
        after: [mongo]
        readyOn: { text: "listening", gate: worker }
      - name: web
        command: bun run web
        readyOn: { gate: web }

webServer:
  command: bun run preview
  url: http://localhost:4173
  ready: [search]
```

Every gate is exactly one probe:

- **`tcp`** — `host:port` (or `{host, port, timeoutMs}`); ready when a connection opens.
- **`http`** — a URL, or `{url, method, status, json, text, headers, auth, timeoutMs}`. `status` takes a code, a class (`2xx`), a range (`200-299`) or a list; the default is 2xx/3xx, and redirects are not followed. `json` maps dotted paths (`checks.db`, `items.0.state`, `items.length`) to a value or a matcher (`equals`, `in`, `contains`, `matches`, `exists`, `gt`/`gte`/`lt`/`lte`). `text` requires a substring of the body. `auth` is `{basic: "user:pass"}`, `{basic: {username, password}}` or `{bearer: token}`; credentials never appear in events or errors. Write them as `${secrets.X}`: it resolves from the run's scoped environment (TinyVault keys included) when the gate runs, and an unset one fails the attempt as `X not set`. `${env.X}` is substituted when the config loads, like anywhere else in the config — an unset variable becomes an empty string, and a 401/403 answer then says which credential is empty.
- **`command`** — a shell command, or `{run, exitCode, stdout, cwd, env, timeoutMs}`; ready on an accepted exit code (default 0). Each attempt runs in its own process group: the shell's exit settles it, and whatever it left running is killed — so is everything when it overruns its `timeoutMs` (default 30s). Registry gates run from the config's directory.
- **`gate`** — another registry gate by name.
- **`all`** / **`any`** — lists of gates or references, checked in parallel each attempt.

The waiting policy belongs to the gate being waited on: `stable` (consecutive passing attempts; a failure restarts the count, and a nested gate's own `stable` counts its own streak — once per attempt, even when the gate is reached through two paths), `every` and `timeout`. A one-look liveness check (`--reuse-services`, `cairn services status`) ignores `stable` at every depth. A string reference is a registry name, except `http(s)://…` (an HTTP gate needing 2xx/3xx) and `tcp://host:port`. Unknown names and reference cycles are config errors (`cairn config validate`, and any command that loads the config) — in the registry and in `services` / `webServer` references alike; a spec's `preconditions.wait` names are resolved when the spec runs, before its first wait.

Where gates apply:

| Field | When | Budget when the gate has no `timeout` |
|---|---|---|
| `services.docker.ready` | after the start command and `readinessCheck`, and on container reuse | what `readinessCheck` left of docker `readyTimeoutMs` (default 120s; all of it on reuse) |
| tmux `windows[].after` | before the window is booted (a live window is left alone); probes see the session + window `env` | tmux `readyTimeoutMs` (default 90s), per gate |
| tmux `windows[].readyOn.gate` | polled with the pane checks; must pass in addition to `url`/`text` | the window's readiness deadline |
| `webServer.ready` | after `url` / `waitForText`, also for a reused server | what is left of `readyTimeoutMs` |
| spec `preconditions.wait` | before the precondition commands; a gate that is not ready fails the run like a precondition named `wait <gate>` | 60s |
| `cairn wait` / MCP `cairn_wait` | on demand | 60s, or `--timeout` |

A spec's `preconditions.wait` writes `gate.started` (`name`, `budgetMs`, `scope`), `gate.attempt` (`attempt`, `ok`, `detail`; identical attempts are coalesced to one every 5s), and `gate.passed` / `gate.failed` (`attempts`, `durationMs`, `lastDetail`, `timedOut`, `cancelled`) to the run's `events.ndjson`, and sets the phase banner (`phase.changed` with the gate name as `item` and its budget). `cairn wait` narrates the same attempts on stderr. Services waits record `services.docker.readiness-check` / `services.tmux.ready-wait` events with the gate name and budget, and log each failed attempt at debug level.

### `cairn wait`

```bash
cairn wait mongo search                         # config gates, in order
cairn wait http://localhost:8080/health --timeout 2m --stable 2
cairn wait http://localhost:9200/ --status 2xx,401 --json
cairn wait tcp://localhost:5672 --every 500ms
```

Targets are waited in order and the wait stops at the first that is not ready. `--status` and `--any-response` apply to URL targets; `--timeout`, `--every` and `--stable` override every target's policy. `--config` / `--env` pick the registry and the environment whose scoped secrets gates may reference; a wait on URL and `tcp://` targets only does not read a config. Attempt narration goes to stderr; stdout carries `urn:cairntrace.dev:wait:v1` (`ok`, `gates[]` with `name`, `ok`, `attempts`, `durationMs`, `budgetMs`, `lastDetail`, `timedOut`, `cancelled`, plus `exitCode`, `error`, `config`). Exit codes: 0 ready, 1 not ready (failed, timed out or cancelled), 2 a `--config` that cannot be read, 4 invalid input (unknown gate or env, an invalid config, a bad flag). MCP: `cairn_wait {targets, config, env, status, anyResponse, timeoutMs, everyMs, stable}` — keep `timeoutMs` below your client's tool timeout.

### URL readiness needs 2xx/3xx

The readiness URL of `webServer` — its `url`, or the environment `baseUrl` it probes when the block sets neither `url` nor `waitForText` — and tmux `readyOn.url` used to count **any** HTTP answer as ready, a `503 Service Unavailable` from a proxy in front of a booting app included. They now need a 2xx or 3xx answer. Set `anyResponse: true` on the `webServer` block or the `readyOn` to keep the old rule (an app whose root answers 401 to anonymous requests, for example), or point the URL at a health route. The timeout error names the last status and the `anyResponse` fix, and a URL that keeps answering the same non-ready status for 10 seconds gets one warning (`readiness: <url> has answered 401 for 10s; readiness needs a 2xx/3xx answer …`) long before the timeout; a dev server that answers 503 while it warms up and then 200 does not. The port-conflict check of `webServer` (`reuseExisting`) still treats any answer as "something is listening", and a reused server must now also be ready within `readyTimeoutMs`.

## Reading service artifacts from a run

Runs that capture service evidence keep it inside the self-contained artifact
pack under `services/`: `services/manifest.json` describes the capture and
`services/tmux/<window>.log` contains each sanitized tmux window log. Use the
run-aware log commands so the evidence remains tied to the exact behavioral
run that produced it:

```bash
cairn logs latest --services
cairn logs latest --service web-api
cairn logs previous --service worker
```

When `ref` is omitted, service lookup uses `latest`. Cairntrace checks the
selected run first. If it has no run-local service pack (or no matching tmux
window), the command falls back to the legacy pane logs under
`~/.cairntrace/services` (or `CAIRN_SERVICES_LOG_ROOT`). This compatibility
fallback keeps older runs inspectable while new captures move into run
directories managed by the normal retention policy.

## Skipping and per-environment overrides

```bash
cairn run flows/x.yml --no-services           # skip the whole lifecycle
cairn run flows/x.yml --services-dry-run       # print the plan and exit; do not run specs
```

The printed plan keeps commands readable while replacing interpolated
environment and selected-vault secret values with `[redacted]`.

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
  remote:
    services:                # keep docker/seed phases, drop inherited local tmux windows
      tmux: false
```

A partial `services:` block deep-merges over the top-level one. An env-level `secrets:` block replaces the top-level one entirely. Inside a partial `services:` block, `tmux: false` removes only the inherited local tmux windows while keeping the docker and seed phases — for apps running remotely over a tunnel that still own provisioning and seeding.

## TinyVault seeding

`secrets.provider: tvault` resolves only the invocation's explicit
`secrets.keys`, `required`, and root-spec/imported-action placeholder names, then supplies that
scoped set to the seed command. It never exports a whole project or mutates
global `process.env`; publisher-only and TinyVault client-control variables
are removed from service children. The `tvault:` block supports direct
(`project`) or inheritance (`group` + `env`) mode. See [Secrets](/secrets) for
the status command and the `cairn secrets` diagnostic.

## Validation

`cairn config validate --json` validates the config file — the zod schema plus cross-field `.refine()` rules: unique window names, `readyOn` constraints (at least one of `url`, `text` or `gate`), gate definitions (exactly one probe each, no unknown references or cycles in `gates:`), and `tvault` provider requires a `tvault:` block with either `project` or `group`+`env`. Run it before relying on a services block in CI.

## See also

- [Configuration](/configuration) — the `services:` schema and env resolution
- [Secrets](/secrets) — the TinyVault integration the seed step uses
- [Stash](/stash) — `services.stash` persists session artifacts to fcheap
