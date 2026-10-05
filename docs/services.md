# Services

`cairn services` owns the multi-service environment a spec pool needs: docker, conditional data seeding, and tmux session management — all config-driven, started once before the pool and stopped after the last spec. `cairn services status` is the read-only check; the lifecycle itself runs automatically on `cairn run` unless disabled. `cairn services up` / `down` keep the stack running between runs when you explore against it.

## `cairn services status`

```bash
cairn services status
cairn services status --config ./cairntrace.config.yml --env local
cairn services status --config ./cairntrace.config.yml --project my-app
```

Reports the current state of the configured services environment (docker, seed freshness, tmux session) for one environment: `--env <name>` (default: the config's `defaultEnvironment`, else `local`) selects its effective `services` block, per-environment overrides applied. It also reports the config's `cairn services up` owner `lock`: `state` (`absent`, `held`, `unreadable`), who holds it, for which `env` and since when (`ageSeconds`). A lock held for this environment also gets a quick liveness look — with the environment's scoped secrets, like a run — and `stale: true` with the `problems` when the services it owns are not actually up; a phase it cannot see is listed under `unchecked` and trusted. `--project <name>` overrides the project name (default: from config); `--config <path>` picks an explicit config. It also lists each `services.tunnels` entry (recorded state, pid, whether the process runs) and the names a `services.provisioner` exports (never values). Output supports `--format json|yaml|md`.

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
- **`cairn services down [--config <path>] [--env <name>]`** is the full teardown. It runs the configured `teardown` commands in order, without the reuse skipping a run applies, so `docker compose down` runs when the config lists it. A `docker` phase that no teardown command stops gets a warning, because its containers keep running. Then it runs `tmux kill-session` if the session is still alive, and removes the lock. It also stops a stack a normal run left alive for reuse (no lock needed). While the lock is held for another environment it refuses with exit 4 and tears nothing down. A failing teardown command is reported with exit 2 (exit 8 when it is a `critical` entry or the provisioner's `down`); the rest still runs and the lock is still removed. Tunnels a state file names are stopped, and the provisioner's `down` runs last.
- **Under the run lock.** When the config takes `run: { lock }` (top level or in any environment), a live `cairn run` of the config (or of its `project:`, for a project-scope lock) owns the stack: `cairn services up`, `down` and `restart` (and `cairn_services_up|down|restart`) refuse with exit 4, touch nothing — no provisioner `down` under a live run's billable resource, no tunnel stopped, no window restarted — and name the owner (pid, environment, age, command line with `--var` keys only). Their result's `runLock` says what happened: `refused` (with `reason` and `owner`), `held` (the command took the lock for its own duration, so a `cairn run` started meanwhile refuses; the lock file names the holder, `command: services down`), `reclaimed` (the owner was gone: taken over as a run would, unless `staleAfterPidDead: false`) or `nested`. A run exports `CAIRN_RUN_LOCK` (its lock file) to every process it starts, so a `cairn services …` command that a suite hook or a `run:` step of that run calls runs under the run's lock (`nested`) instead of refusing. There is no `--force`: stop the run instead (Ctrl-C, or `kill <pid>`), which runs its own teardown, the provisioner's `down` included; once its process is gone the lock is reclaimed.

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
- **seed** — runs after docker is healthy. Freshness is tracked at `~/.cairntrace/services/<project>.seed.json` with a three-layer check (fingerprint + TTL + optional data-level command). A fresh-enough seed is reused; otherwise the seed command re-runs. Optional `postCommands` always run after that decision (skip or complete) — use them for lightweight fixture ensure scripts the bulk import does not ship (strings, or named objects with `when`, `continueOnError`, `timeout`; see [Seed transaction](#seed-transaction), which also covers `phases`, `commit` and `expectOutput`).
- **tmux** — a named session with one or more windows, each with its own `cwd`, `command`, `readyOn`, `after`, and `healthcheck`. `readyOn` can be `{ url }` (a 2xx/3xx answer, see [readiness gates](#readiness-gates)) or `{ text }`; either one is enough. `readyOn.gate` adds a gate that must also pass. `after: [gates]` delays booting the window until those gates pass (the database a worker connects to). By default Cairn boots every window before waiting for readiness. Set `waitForReadyBeforeNext: true` to boot in declaration order and wait for each window's `readyOn` before creating or starting the next; all windows share the single `readyTimeoutMs` deadline, and a dead/disappeared pane fails immediately. On reuse, missing windows are created and idle panes (shell prompt, no running service) are re-launched; busy panes are left alone. If docker was freshly started this run, the whole session is recreated so app processes reconnect to new containers. Cairn waits for the interactive shell before `send-keys` and clears pane history first so `readyOn` text cannot match stale scrollback.
- **artifacts** — saves bounded, redacted lifecycle, docker/provisioner command output, tmux, local Compose, and seed/post-command evidence inside each run while the services are still alive. A remote provisioner such as Chalupa retains its launch/tunnel transcript without probing an unrelated local Compose project. The block is optional and defaults to `when: on-failure`, all four sources, 2,000 lines and 512 KiB per source, and 8 MiB total per run. Set `when: always` while stabilizing a suite or `never` to disable it. Collection errors are recorded in `services/manifest.json` and never change the test verdict.
- **stash** — optionally saves session artifacts (tmux panes, docker logs, seed
  output) in the local file.cheap vault. It does not upload or replicate them.
- **teardown** — after the last spec. When tmux reuse is on (the default), cairn leaves the session alive and also skips `docker compose down` so infra the live panes need is not torn out from under them. With `tmux.reuseExisting: false`, full teardown runs (tmux kill + docker down). The same commands run when a phase fails mid-boot (failure cleanup). Each command leaves a `services.teardown.complete` / `services.teardown.fail` event (`index`, `exitCode`, `durationMs`) in the invocation journal, and its redacted output in `logs/services-teardown.log`.
- **teardown on SIGINT / SIGTERM** — the process is exiting, so cairn runs a synchronous teardown: it kills the tmux session it created, then waits up to `CAIRN_SERVICES_SIGNAL_GRACE_MS` (default 5000) for a boot command that is still running (docker, seed, readiness check, healthcheck, post-command) to exit. A terminal Ctrl-C reached that command too, and a provisioner that is cancelling its `up` holds its state lock until it exits, so a teardown started meanwhile would race it. cairn sends it no signal of its own, because a second signal turns a graceful cancel into a forced one. A command still running after the grace keeps running, as in 2.x, and the teardown proceeds. Then cairn runs the teardown commands that have not run yet, each capped at `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` (default 10000). The `tunnels` stay up while those commands run (a teardown command that dumps data through a tunnel still reaches it) and stop right before the provisioner's `down`, the order of a normal stop: teardown commands, tmux kill, tunnels, provisioner `down`. Teardown commands (normal, failure cleanup, signal path) run detached: in their own process group and session, with no terminal and their output in a private temp file, so the Ctrl-C or group SIGTERM that stops cairn does not kill a provisioner's `down` halfway, and one still running after cairn exits does not die on a closed pipe. A teardown command must therefore not prompt. When the signal lands while the normal teardown runs a command, cairn waits up to `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` for it and never starts a second copy while it is alive, because two copies of a provisioner's `down` race for its state lock; past the wait it is left to finish in the background (the event names its output file). If nothing of it is left (something killed its process group), cairn runs it again. Each step is recorded as a `services.teardown.signal` event (`kind: boot` with `exited`; or `index` with `status: completed | failed | timed-out | finished | in-flight | re-run`), with the output in `logs/services-teardown.log`. Raise both budgets for slow remote provisioners, for example `CAIRN_SERVICES_SIGNAL_GRACE_MS=180000 CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS=240000` when `up` / `down` create and destroy cloud machines, so the teardown starts after the cancelled `up` released its lock and `down` can finish. While this cleanup runs (with the suite's `after` hooks before it, and `run.finally` and the run lock after it), a second Ctrl-C, a SIGTERM or a SIGHUP is ignored: cairn prints `cleanup in progress (critical teardown pending); further Ctrl-C is ignored until it ends, send SIGKILL to force` before the slow part, and only SIGKILL stops it early. Every step is bounded, so it always ends.

## Service operations: restart, logs, supervision

A stack that outlives one run needs the small operations a Taskfile used to carry: restart one service, read its output since the restart, keep a tunnel up, bring a billable resource up and always take it down, rewrite a config file the services read. They are config, not scripts. Every key is optional; a config that uses none of them behaves as before.

```yaml
version: 1
environments:
  local: {}
services:
  provisioner:                       # a resource this run creates and must destroy
    up: "bun tools/create-sandbox.ts"
    down: { run: "bun tools/destroy-sandbox.ts", timeout: 10m }   # critical, onSignal: wait by default
    exports:
      REMOTE_HOST: "bun tools/sandbox-host.ts"                    # one value per command
  tunnels:
    - name: remote-db
      command: "ssh -N -L 27018:localhost:27017 ${env.REMOTE_USER}@$REMOTE_HOST"
      restart: always
      giveUpAfter: 5
      backoff: { initial: 1s, max: 30s }
      ready: "tcp://127.0.0.1:27018"
  files:
    - path: app/config.local.json
      json: { db: { host: "${exports.REMOTE_HOST}", port: 27018 } }
      restart: [api]                  # restart this window when the file changed
  tmux:
    session: myapp
    columns: 250                      # session size (default 250x50)
    rows: 50
    windows:
      - name: api
        command: "yarn api"
        readyOn: { text: "listening on" }
        restart: { policy: on-exit, backoff: 2s, max: 3 }
        healthcheck:
          command: "curl -sf http://localhost:3000/healthz"
          intervalSeconds: 10
          retries: 3
          onUnhealthy: restart        # or warn
```

**Order.** `provisioner` → `tunnels` → `docker` → `files` → `seed` → `tmux`. Teardown runs the other way: supervision stops, the teardown commands run, the tmux session is killed, the tunnels stop, and the provisioner's `down` runs last. A phase that needs an earlier one (a seed through a tunnel, a window reading a rewritten file) therefore always finds it up.

### `cairn services restart` and `cairn services logs`

```bash
cairn services restart api worker --stop-timeout 60s --ready-timeout 3m --json
cairn services logs api --since-restart --lines 100
cairn services logs api --wait "listening on \d+" --timeout 2m   # exit 0 on a match, 1 on timeout
cairn services logs api --follow
```

`restart <window...>` handles the windows one after the other. For each: Ctrl-C (a second one at 40% of `--stop-timeout`, default 30s), wait for the pane's process to exit — cairn never hard-kills a service, and a window that ignores Ctrl-C fails the restart with `stop-timeout` — clear the pane history, print a marker line `@@cairn-restart:<id>@@`, resend the window's `env`, `preCommands` (with `skipIf`) and `command`, and wait for `readyOn` of the **new** generation. `readyOn.text` is matched only below the marker, so stale scrollback never counts as readiness; a `readyOn.url` or `gate` is checked as for a boot. A failure stops the sequence and the remaining windows are reported `skipped`. It refuses, touching nothing (exit 4), when the session is not running, a name is not a window of the configured session, the window is missing from the live session, or a live `cairn run` is supervising the session (it keeps a `~/.cairntrace/services/tmux-supervisor.<session>.<hash>.json` marker while it does; let that run restart its windows, or restart after it ends): cairn never sends keys to a pane it did not configure. tmux targets are exact (`=session:=window`), so a session or window whose name merely starts with the configured one (`app-wt`, `web-worker`) is never touched. A pane counts as running while its shell has a foreground job, so a service started as `bash start.sh` gets its Ctrl-C.

`logs <window>` prints the captured pane (`capture-pane -J`, wrapped lines joined) after the invocation's redaction. `--since-restart` keeps what follows the last restart marker (the whole pane, and the result says so, when there is none); `--lines <n>` shows the last N (default 200); `--wait <regex> [--timeout 30s]` waits for a line (exit 0) or gives up (exit 1); `--follow` streams new lines until interrupted and takes text output only.

`services exec <window> -- <command>` does not exist on purpose. Typing into a pane that runs a service interleaves with its output, cannot report an exit status, and races the process. What it would be used for has a typed place: a `run:` step, a `teardown`/`finally` entry, a fixture, `services.files`, or `restart`.

Both commands support `--format json|yaml|md` (`urn:cairntrace.dev:services-restart:v1`, `urn:cairntrace.dev:services-logs:v1`). The events are `services.restart.start|stop|ready|fail|giveup`.

### Supervision (while a run is active)

Windows with `restart: { policy: on-exit, backoff?, max? }` are started again when their process exits (the pane falls back to an idle shell): after the `backoff` (a duration, or `{ initial, max, factor }`; default 1s doubling up to 30s), at most `max` times in a row (default 5; a window that stayed up 30 seconds starts counting again), then `services.restart.giveup` and a warning. `healthcheck.onUnhealthy` turns the healthcheck into a monitor for the whole run: the command runs every `intervalSeconds` after `startPeriodSeconds`, and after `retries` consecutive failures cairn warns (`warn`) or restarts the window with the same backoff and `max` (`restart`). Supervision starts after the boot and stops before the teardown. `cairn services up` starts the stack and exits, so nothing supervises it; use a run (or restart by hand) for that.

### Tunnels

`tunnels[]` entries are helper processes (an SSH or cloud tunnel). Each runs in its own process group with its output in `~/.cairntrace/services/<key>-tunnel-<name>.log`, and its pid, state and owner (the cairn process that started it) in `~/.cairntrace/services/<key>.tunnel.<name>.json`, where `<key>` is the project, the environment and a hash of the config file's path — two checkouts of one project, or two environments, never share or stop each other's tunnels. `ready` is a [readiness gate](#readiness-gates) (a `tcp://` target, a URL, a named gate) that must pass before the next phase; a tunnel that exits first fails the boot with its output. `restart: always` restarts an exiting tunnel while a run is active (after `backoff`, up to `giveUpAfter` consecutive times, default 5, then `services.tunnel.giveup`); `never` (default) reports the exit. A tunnel is stopped on every exit path: the end of the run, a failed boot, SIGINT/SIGTERM, and `cairn services down`; a copy a crashed earlier run left behind (same pid, same start time) is stopped before the new one starts, while one a **live** cairn process owns is never touched (the boot fails, naming its pid; `services down` reports it `skipped`). Only a running tunnel's own process (start time checked) is ever signalled: a pid that exited is never reused for a signal. Events: `services.tunnel.start|ready|exit|restart|giveup|stop|fail`.

### Provisioner

`provisioner` brings up a resource that costs money or is shared, and guarantees it goes away:

- `up` runs before every other phase (default budget 10 minutes, `timeout` to change it). `exports` are commands that each print **one** value (more or fewer lines is an error), run in order after `up`; every later phase, the webServer, hooks, suite hooks, specs and verifiers see them as environment variables (`NAME`), and `${exports.NAME}` works in `services.files`. A credential-named export (`TOKEN`, `SECRET`, `PASSWORD`, `KEY`, …) is registered for redaction; events carry only the export **names**. `PATH`, `HOME`, `SHELL`, `NODE_OPTIONS`, `LD_*` and `DYLD_*` cannot be exported. Tmux windows get the exports through the session environment (a credential-named export only reaches a session created with a new tmux server).
- `down` is mandatory (a provisioner without one does not validate) and defaults to `critical: true` and `onSignal: wait`. It is registered **before** `up` starts, so it runs on every exit path: after the normal run, after a failed `up`, after any later phase failed, and on SIGINT/SIGTERM (the signal path waits for it up to its `timeout`, 10 minutes by default). It runs through the same machinery as a critical teardown entry, last, after the tmux session and the tunnels. A `down` that fails or times out is **exit 8** (`cairn services down` too, and `cairn services up` when the cleanup of its failed boot could not complete it: the result's `teardown[]` names the entry and `events[]` holds the failed boot's events), and the failing entry is in the journal (`services.teardown.fail` with `critical: true, provisioner: true`). An `up` that failed, timed out or was cancelled before its `exports` ran still gets them evaluated (best-effort, each bounded by its timeout) so the `down` can find the resource; on SIGINT/SIGTERM during `up`, cairn forwards SIGTERM to it and waits up to the `down`'s own signal budget before the `down` runs.
- A provisioned environment never reuses a tmux session: its windows would only hold connections to a resource `down` destroys.
- `cairn services up` runs `up` and leaves the resource until `cairn services down`; a run with `--reuse-services` evaluates the `exports` commands again (nothing is created) so the run sees the values.
- Per environment: `environments.<name>.services.provisioner` merges key by key over the top-level one (the result must still have `up` and `down`; `cairn config validate` says when it does not); `false` removes it. A config may declare the provisioner (or any phase) only in the environment that owns it, with no top-level `services:` block at all. `tunnels` and `files` replace as lists (`false` removes them), and `docker: false` drops the docker phase.

### Files

`files[]` writes a file before the seed and the tmux phase, atomically (temp file, then rename). An existing file keeps its mode; a new one is created `600` (its content may hold an export or a secret) unless the entry sets `mode` (`"644"`, `"0640"`). A symlink is written through to the file it points at (a link whose target is missing is refused). `json` deep-merges an object into the file (objects merge, arrays replace, `null` removes a key; the indentation is kept) and an existing file that is not valid JSON, or not an object, is **never overwritten**; `text` replaces the content. String values may use `${exports.NAME}` (late-bound; an unknown name fails the write) and `${env.NAME}` (filled from the process environment when the config loads). A write that would not change the content is skipped, and each entry journals `services.files.write|unchanged|fail` with the configured path, `before`/`after` fingerprints (`hmac-sha256:` + 16 hex chars, keyed per run so a short secret in the content cannot be guessed from them; they compare within one run) and byte counts — never the content. `restart: [windows]` restarts those windows when the file changed and they were already running (a window this boot launched started with the new file).

## Seed transaction

```yaml
version: 1
environments:
  local: {}
services:
  seed:
    target: "${env.SEED_DATABASE}"       # part of the state key (free text)
    ttlSeconds: 21600
    commit: afterPostCommands
    expectOutput: { notMatches: ["COLLECTION ERROR", "[Ff]atal"] }
    phases:
      - { name: schema, run: "bun tools/migrate.ts" }
      - { name: import, run: "bun tools/import.ts", skipIf: { command: "bun tools/count.ts --min 1000" } }
      - { name: verify, run: "bun tools/check-seed.ts", always: true }
    postCommands:
      - { name: ensure-fixture, run: "bun tools/ensure-fixture.ts", timeout: 2m }
      - { name: heavy-index, run: "bun tools/index.ts", when: { suite: [full] }, continueOnError: true }
      - "bun tools/legacy-ensure.ts"     # a plain string keeps working
```

- **Phases** replace the single `command` (a seed has one or the other). A phase runs when `always` is set; otherwise it is skipped when a recorded success of the same command is still inside `ttlSeconds` (with no TTL a phase has no memory and runs), or when `skipIf` passes: a shell command (`skipIf: "<cmd>"` or `{ command }`, exit 0 = skip) or a gate (`{ gate: <name or inline> }`). Each outcome is persisted per project + environment + `target` in `~/.cairntrace/services/<project>.<env>.<hash>.seed-state.json`: a failed phase is recorded at once, so the next run repeats it. A run that failed on a phase is **resumed**: the phases that had succeeded in it are skipped next time (`resumed after a failed run`) and a run that gets through every phase clears that. A resume is used once and only while it can hold: a resumed phase with a `skipIf` must still pass it (`resumed …; skipIf passed`), a resume older than `ttlSeconds` (when set) is ignored, a phase only carried over by a resume is not carried into the next one, and a teardown — the failure cleanup, the signal path, `cairn services down` — drops it, so the next run repeats every phase. `cairn services status` shows each phase's last outcome and a pending resume. A changed command is a new phase. Events: `services.seed.phase.start|skip|complete|fail`.
- **`commit: afterPostCommands`** stamps freshness (a single-command seed's fingerprint/TTL record, or every phase's record) only after every post-command succeeded; a failed post-command leaves the seed un-stamped, so the next run seeds again (`services.seed.commit` says which). The default (`afterCommand`) is the 2.x behavior: stamped as soon as the seed command succeeded. A seed with `commit` or `target` keeps its record per environment and target too (the state key above); without them the record stays per project.
- **Post-commands** are strings or `{ name, run, when, continueOnError, timeout, expectOutput }`. `when: { suite, env }` (a name or a list; a `suite` condition never matches a run without `--suite`) skips the command with a `services.seed.postcommand.skip` event. `continueOnError` records the failure and goes on; a fatal failure after tolerated ones lists them all in its error, and with `commit: afterPostCommands` a tolerated failure still blocks the commit. `suites.<n>.seed.postCommands.skip` matches a **named** post-command by `name` and a plain string by its exact command text; an entry that matches nothing is still a warning.
- **`expectOutput: { notMatches: [regex] }`** fails a seed command, phase or post-command that exits 0 but prints a match (the error quotes the line; the freshness record is not stamped).

## Engine pin

```yaml
version: 1
environments:
  local: {}
requires:
  cairntrace: ">=3.1"        # semver range: >=, ^, ~, x-ranges, ||, hyphen ranges
runtimes:
  node:
    path: ./tools/node          # optional: the binary node scripts run with
    version: ">=22 <25"         # optional: it must satisfy this
```

A run, `cairn spec verify`, `cairn catalog`, `cairn services up|restart|logs|status`, every other command that loads the config, and every MCP tool refuse a config whose `requires.cairntrace` this cairn does not satisfy, with exit 4 and a message naming both versions. A teardown never waits on the pin: `cairn services down` warns and tears down. A range npm's `semver` rejects (`3.x.1`, `*-3`, `03.0.1`, `^3.0.01`) is invalid here too. `cairn doctor` (it reads the config from the working directory, or `--config <path>`) and `cairn config validate` report it too. `runtimes.node` picks the node binary of node scripts, `script` verifiers and transforms: `CAIRN_NODE` (environment) wins, then `path` (relative to the config directory), then the first `node` on PATH that satisfies `version`, then the highest install that does under nvm, fnm, volta, asdf, mise or Homebrew. A node that is missing or out of range is exit 4 before anything starts; the chosen binary is exported to children as `CAIRN_NODE`.

## Run policy (`run:`): lock, preflight, clean machine, belts

A wrapper script around `cairn run` usually does four things: it takes a lock so two suites do not fight over one stack, it refuses to start on a bad machine, it proves nothing survived, and it runs belt cleanup that must happen whatever the verdict. The config `run:` block declares all four, and the run engine enforces them for `cairn run` and for MCP `cairn_run` alike, so a bare `cairn run --env <name>` is as safe as the wrapper was. Every field is optional; a config without `run:` behaves as before.

```yaml
version: 1
environments:
  local: {}
gates:
  stack-reachable: { tcp: "127.0.0.1:8080" }
run:
  lock: { scope: config, staleAfterPidDead: true }   # or lock: true
  preflight:
    - name: engine posture
      json: docker/posture.json
      assert: .engine.mode == "durable" and .engine.workers >= 2
    - { secret: DEPLOY_TOKEN }
    - { command: "bun tools/check-quota.ts", expectExit: 0, timeout: 30s }
    - { gate: stack-reachable }
  verifyClean: [browsers, tmux, docker-project]
  finally:
    - "bun tools/collect-diagnostics.ts"
services:
  teardown:
    - { run: "bun tools/destroy-compute.ts", critical: true, timeout: 10m, onSignal: wait }
```

A top-level `run:` applies to every environment; `environments.<name>.run` merges over it key by key (lists replace, `lock: false` turns the lock off there).

**Order.** Config and secrets resolve, then: lock, `preflight`, `verifyClean` (before), services and webServer boot, the specs, teardown, the critical-teardown verdict, `finally`, `verifyClean` (after), and the lock is released last. A refusal in the first three phases stops the run with exit 4 before anything of cairn's starts.

- **`lock`**: `~/.cairntrace/locks/<label>.<hash>.run.lock.json`, created atomically (the finished file is hard-linked into place, so a reader never sees half a lock and two creators cannot both win) and holding the owner's pid, start time, redacted argv (`--var` keys only, never their values), invocation id, origin and environment. `scope: config` (default) is one lock per config file whatever the environment; `scope: project` is one per `project:` name across checkouts (a config without `project:` falls back to config scope). A live foreign owner refuses with exit 4 naming its pid, age and command line, and the `run.lock.refused` event says the same. A lock whose owner process is gone, or whose pid now belongs to a younger process, is stale: it is reclaimed with a warning (`run.lock.reclaimed`), unless `staleAfterPidDead: false`, which refuses until you remove the file. The lock is released on every exit path: the engine's own finally, the SIGINT/SIGTERM handler (last: after the run's still-running commands were ended, services stopped and `finally` ran) and a process `exit` hook. Two MCP invocations of one config in one server refuse the second (exit 4) instead of queueing. `cairn services up | down | restart` respect the lock too (see [Keeping services up](#keeping-services-up-cairn-services-up-down)). A policy guards one config: an invocation whose specs come from several configs where any declares `run:` (or one config whose environments give its specs different policies) is refused with exit 4, naming each config with a spec that resolves to it — run each config's specs in an invocation of their own, or pass `--config <path>` to run them all under one config (`--suite` alone does not help: a suite's specs still load their nearest config); a config that does not load refuses too.
- **`preflight`**: checks run in order and the first failure refuses the run (exit 4) with a message naming it (`preflight[2] "engine posture" failed: assert ... is false for docker/posture.json (.engine.workers = 1)`). `json` reads a file relative to the config directory and evaluates `assert`; `secret` needs the name to resolve to a non-empty value in the run's scoped environment (it never prints the value; with `secrets.provider: tvault` every `preflight[].secret` name, and every `${env.X}` a preflight `command` or a `finally` entry uses, is fetched from the vault); `command` runs a shell command in the config directory with the scoped environment (`expectExit` default 0, `timeout` default 60s; the process group is killed at the deadline); `gate` looks once at a named `gates:` entry (it never waits). Failure text is redacted, and observed JSON values under credential-like keys show as `[redacted]`. `when: { suite, env }` (a name or a list, as on seed post-commands) limits a check to those suites and environments: a `suite` condition never matches a run without `--suite`, a check left out is named in the log as skipped, and a failure keeps the check's own index (`preflight[3]`).
- **Assertion language** (`assert`): paths `.a.b[0]` (or `a.b`) against the JSON document; literals (numbers, `"strings"`, `true`, `false`, `null`); `==` `!=` `<` `<=` `>` `>=` (no type coercion; ordering needs two numbers or two strings); `in [..]`; `exists` (present and not null); `and` / `or` / `not` (also `&&` `||` `!`) and parentheses. A missing path is unequal to everything and unordered. It is a real tokenizer and parser, never `eval`; a syntax error is a `cairn config validate` error with its offset, and so is nesting deeper than 64 levels or more than 1024 tokens.
- **`verifyClean`**: asserts that nothing of this project survives, before the run (a dirty machine refuses it, exit 4) and after it (exit 9, listing what survived; nothing is killed). `browsers`: browser sessions the owned-session ledger names for this project (a pid only while it is still the process cairn learnt — same start time and command — and still looks like a browser cairn launches) plus agent-browser daemons of cairn run sessions (`<session>.pid` in agent-browser's state directory) whose working directory is inside the project; another project's browser, a discovery or user session, a process that merely mentions agent-browser and cairn's own ancestors are never flagged. `tmux`: the services tmux session. `docker-project`: containers labelled with the compose project (taken from `-p` / `--project-name` in `services.docker.command`, `COMPOSE_PROJECT_NAME`, else the docker working directory's name; name it explicitly with `{ docker-project: <name> }` when the command changes directory). `{ tmux: <session> }` names a session. A Docker daemon that is not running (or no docker CLI) counts as clean, with a warning: no container can be running; any other failure to query it counts as dirty (an unverifiable guarantee is not one). After the run, survivors get a short grace (`CAIRN_VERIFY_CLEAN_GRACE_MS`, default 3000) to finish exiting. Under `--reuse-services` the stack is `cairn services up`'s: `tmux` and `docker-project` are not checked, `browsers` still is.
- **`finally`**: commands run after the services/webServer teardown with `CAIRN_EXIT_CODE` (the code the run settled on, critical-teardown failures included, before the cleanliness check), `CAIRN_INVOCATION_DIR` (the journal directory), `CAIRN_ENV` and `CAIRN_CONFIG_DIR`. They are non-fatal: a failure is logged and journaled (`finally.finished` with its exit code) and never changes the exit code. A string or `{ run, timeout }` (default 60s). They also run after a failed boot, and not at all when the run was refused before anything started. On SIGINT/SIGTERM they run synchronously after the services teardown with `CAIRN_EXIT_CODE` 130 / 143 (output in `logs/finally-signal-NN.log`), each bounded by `CAIRN_SIGNAL_HOOK_TIMEOUT_MS` (default 10s) and all of them together by three times that: a window of their own, so suite `after` hooks that used up theirs never cost `finally` its run.
- **Critical teardown**: a `services.teardown` entry may be `{ run, critical: true, timeout, onSignal: wait }`. A critical entry that exits non-zero or times out fails the run with **exit 8**, which outranks every verdict: precedence is 8, then 9, then the run's own code, so a billable resource that did not stop is never hidden behind a red or green test. `timeout` bounds any entry of a `cairn run` (the process group is killed); `cairn services down` runs every entry as a plain command. `onSignal: wait` makes the SIGINT/SIGTERM path wait for the entry up to its timeout (10 minutes when none) instead of the short `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` cap; a critical entry that fails or is still running after the wait is recorded in the journal (the process exits 130/143 as always).
- **Exit codes**: 4 = a refusal before anything started (live lock, failed preflight, dirty machine before, specs from several configs); 8 = critical teardown failed; 9 = dirty state after the run. When a `run:` policy or a critical teardown applies, `cairn run` holds its `--json` / `--yaml` / md document until that verdict, so the document agrees with the process exit code: its `exitCode` is the invocation's, a spec that passed reads `status: errored` with `failure.phase: invocation`, and `invocationOutcome` (`exitCode`, `specsExitCode`, `error`, `runPolicy`) says why (`run.json` in the run directory keeps what the spec did). A SIGINT/SIGTERM that ends cairn before that verdict prints the documents of the iterations that finished, with `invocationOutcome.exitCode` 130 / 143 (their top-level `exitCode` stays the specs'). MCP `cairn_run` and `cairn_run_status` return the same document. The journal summary carries `runPolicy` (`lock`, `criticalTeardown`, `dirty`, `finallyFailed`), and the journal events are `run.lock.acquired|reclaimed|refused|released`, `preflight.started|passed|failed`, `cleanliness.clean|dirty`, `finally.started|finished`, `invocation.bailed`.

**`cairn run --bail`** (MCP `bail`) stops scheduling the remaining specs after the first failed or errored one. They are reported as skipped, never as results: `BatchRunResult.skipped[]` (`{ spec, reason: "bailed", bailedBy }`) and `summary.skipped` (not part of `total`), plus the `invocation.bailed` event. Specs already running finish, teardown runs as usual, and the exit code follows the usual precedence over the specs that ran (the skipped ones do not count), so it is never lower than the same batch without `--bail`. With `--repeat` / `--matrix`, later iterations do not start. A spec refused by the environment policy does not trip it.

**Owned browser sessions.** Every browser session cairn starts is recorded in `~/.cairntrace/sessions-ledger/` (session name, backend, invocation, owner pid, browser pids) and removed when the browser closed cleanly. `cairn doctor --orphans [--kill] [--yes] [--json]` lists the sessions whose cairn process is gone but whose browser survives (`urn:cairntrace.dev:doctor-orphans:v1`; exit 0 none, 1 some). `--kill` ends them after a confirmation on a terminal; a structured or non-interactive run needs `--yes`. A learnt pid is recorded with its start time and command, and only a process that is still that one (and still looks like a browser cairn launches: the agent-browser daemon, Playwright's browsers, `--enable-automation`) is listed — and checked again right before it is signalled — so a recycled pid, the desktop Chrome or another tool's browser is safe; an entry whose owner has been gone for 7 days is dropped without being resolved. `--only <session|pid,...>` limits the listing and the kill to those sessions / pids (Studio passes exactly what its confirmation showed).

## Suites (`cairn run --suite`)

A wrapper script usually keeps a table from a suite name to spec paths, then adds what differs per environment: commands to run before and after, vars, which seed steps to skip. The config `suites:` registry declares it once, and `cairn run --suite <name> [--env <env>]` (MCP `cairn_run { suite }`) runs it through the same engine as any run. With no spec path to walk up from, the config is the `cairntrace.config.yml` found from the working directory, else `--config <path>` (none found is exit 4). The keys are in [Configuration](/configuration#suites-suites).

```yaml
version: 1
environments:
  local: {}
  staging: {}
suites:
  checkout:
    specs: [flows/checkout, flows/smoke/login.yml]
    order: [login]
    bail: true
    processEnv: { ENGINE_MODE: "${env.ENGINE_MODE:-durable}" }
    labels: { cohort: "${env.ENGINE_MODE:-durable}" }
    env:
      staging:
        bail: false
        before: ["./tools/warm-cache.sh"]
        after: ["./tools/collect-diagnostics.sh"]
        hookTimeoutMs: 120000
        seed: { postCommands: { skip: [staging-only-fixture] } }
```

- **Order of a run.** Config and secrets resolve, the run policy's lock and preflight pass, services and the webServer boot, then the suite's `before` hooks run once, then the specs, then the suite's `after` hooks (services still up), then teardown.
- **Hooks.** Suite hooks are config: they run under MCP without `cairn mcp --allow-hooks`, which gates only the `before`/`after` a `cairn_run` request carries. `before` hooks stop the run on failure or timeout (exit 2). `after` hooks run on every exit path once the before phase began (red specs, a failed before hook, a cancel, a SIGINT/SIGTERM — then synchronously, bounded like `run.finally`), get `CAIRN_EXIT_CODE`, and never change the exit code. `CAIRN_EXIT_CODE` is the specs' verdict: a critical teardown (8) or a dirty machine (9) settles after the teardown, which runs after these hooks — `run.finally` sees the settled code — and on a signal it is 130 / 143. Both are killed with their process group at `hookTimeoutMs` — the wait for them ends there even when the runtime never reports the exit, and a hook whose exit the runtime loses is settled from the process table — run in the config directory, and are journaled as `suite.hook.started` / `suite.hook.finished` with a live log `logs/hook-suite-<phase>-NN.log`. `suite.started` and `suite.finished` (with `hooksFailed`) bracket them in `events.ndjson`.
- **Process env.** `processEnv: { NAME: value }` (and `env.<name>.processEnv`, merged over it by name) is exported to every process of the run: `run.preflight` commands, the services phases (provisioner, tunnels, docker, seed and its post-commands), suite hooks, specs, their commands and verifiers; `${env.NAME}` in the config and the specs resolves to it. Values may use `${env.X}` and `${vars.X}` and resolve after the vault's secrets are in; an entry whose `${env.X}` is unset (no `:-default`) is not exported, with a warning, so it never hides the caller's own variable. `PATH`, `HOME`, `SHELL`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `TVAULT_*` and what cairn sets itself (`CAIRN_SUITE`, `CAIRN_SUITE_VAR_*`, `CAIRN_EXIT_CODE`, `CAIRN_INVOCATION_DIR`, `CAIRN_RUN_LOCK`, …) are refused by the schema. Only names reach the log, the dry-run plan, `suites list` and the catalog; values are redacted like any scoped secret.
- **Labels.** `labels: { key: value }` (and `env.<name>.labels`) are stamped on every run of the suite, before `suite=<name>` and your own `--label` (later wins), so `cairn stats --group-by <key>` cohorts work without a wrapper; `cairn stats --invocation <id>` keeps the runs of one invocation.
- **Next to flags.** Every run is labelled `suite=<name>` (`cairn stats --group-by suite`; a `--label suite=…` of yours wins). `--parallel` beats the suite's `parallel`; `--bail` adds to its `bail` and `--no-bail` (MCP `bail: false`) turns it off, while `env.<name>.bail` replaces it in one environment; `--var` beats suite vars — in the specs and in the hooks' `CAIRN_SUITE_VAR_<NAME>` alike — which resolve once the vault's secrets are in (a suite var whose `${env.X}` is still unset is not passed, so it never blanks the config var of that name; `requires.vars` is checked then); `--tag` narrows the selection; `--select-only` lists what would run. `--before` / `--after` keep their per-iteration / per-spec meaning.
- **Seed post-commands.** `seed.postCommands.skip` drops the named post-commands from this run's seed phase (`--services-dry-run` lists them and the narration counts them); an entry that matches none warns. `env.<name>.seed.postCommands.skip` adds an environment's own skips on top, so a skip that only makes sense where a post-command exists (an environment-only fixture) does not warn in the others; `cairn config validate` checks those against that environment's post-commands.
- **Exit codes.** 2: `--suite` next to a spec path that is not one of its specs (its own narrow it), or a before hook failed; 4: unknown suite, or a reference that names no spec; 7: `requires` refused the environment. `cairn config validate` also refuses two suite vars that reach hooks as the same `CAIRN_SUITE_VAR_<NAME>` (`a-b` and `a_b`).

### Replacing a Taskfile's suite switch

A Taskfile that picks specs with a `case` on `SUITE`, flips a path before the run and collects numbers afterwards becomes config plus one command:

```yaml
# cairntrace.config.yml
version: 1
environments:
  local: {}
  staging: {}
run:
  lock: true
suites:
  nightly:
    specs: [flows/nightly]
    bail: true
    env:
      staging:
        before: ["./tools/set-engine.sh next"]
        after: ["./tools/collect-diagnostics.sh"]
metrics:
  - name: queue_depth
    scope: invocation
    command: ./tools/queue-depth.sh
    parse: { json: $.depth }
```

```bash
cairn run --suite nightly --env staging     # was: task test SUITE=nightly ENV=staging
cairn stats --metric queue_depth.delta --group-by suite
```

The lock, the spec list, the per-environment commands and the numbers are all declared; nothing is copied into a script.

## Metrics probes (`diagnostics/metrics.json`)

The config `metrics:` list replaces an `--after` collector that measured something before and after a run. The engine samples each probe around every spec (`scope: spec`, the default) or around each iteration's specs (`scope: invocation`):

- `command` + `parse` (`{ json: <path>, reduce? }` or `{ regex, group?, unit? }`) runs a shell command in the config directory with the run's scoped environment; `http` + `json: { path, reduce? }` sends a GET with optional `headers` and `auth: { bearer | basic }`. In an `http` probe `${secrets.X}`, `${env.X}` and `${vars.X}` resolve at every sample, and an unset one fails that sample. A `command` is not expanded: the shell sees `${vars.X}` literally (`cairn config validate` warns), so pass a value through the run's environment instead.
- `sample: [before, after]` is the default; `every: <duration>` (at least 250ms) adds periodic samples while the scope runs. Ticks stop when the scope ends: the timer is cleared and an in-flight probe is killed.
- Every sample is bounded by `timeout` (default 10s, at most 5m), its process group killed at the deadline. A failure is recorded with a short redacted reason, warned once per metric and journaled (`metric.sampled` with `error`); it never changes the verdict.

Results: `<runDir>/diagnostics/metrics.json` (`urn:cairntrace.dev:metrics:v1`) holds `before`, `after`, `delta`, `failures` and, for `every`, `series` with min, max, mean and the samples (at most 500). The flat numerics `<name>.before`, `<name>.after`, `<name>.delta` (and `.min`, `.max`, `.mean`) are merged into `diagnostics/report.json` after the `--after` hooks, keeping whatever a collector wrote, so `cairn stats --metric <name>.delta` reads them (`cairn stats` takes non-negative numbers; a negative delta stays in `metrics.json`). Invocation-scope rows are also written to `<journalDir>/metrics.json` and to every run of that iteration, stamped with the `--repeat` / `--matrix` iteration. Resolved secrets, tokens and header values never reach artifacts: an HTTP source is named by origin and path (or the config template without its query).

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

`--services-dry-run` never reads the vault: it resolves which secret names a real run would ask `tvault` for (`secrets.keys` / `secrets.required`, the `${env.X}` / `${secrets.X}` names of the spec, its actions and the `run:` policy, the environment's `auth:` names for a `use: login` flow) and prints them as a `secrets:` line, names only. No `tvault` process is started, not even `--version`, so a plan is safe to print on a machine without vault access; `secrets.required` is not checked, and a suite's `requires.vars` is not judged (a var the vault provides cannot be known).

The printed plan keeps commands readable while replacing interpolated
environment and selected-vault secret values with `[redacted]`. It lists every
phase of the environment's effective block: the environment, the suite and the
names of its `processEnv`, the provisioner's `up` / `down` (and whether
`down` is critical) and its export names, each tunnel with its `ready` gate,
docker, each file, the seed with how many post-commands run, which ones the
suite skips and which ones a `when` leaves out, tmux, how many teardown entries
there are and how many are critical, and the `services up` lock line. An
environment without services prints a line saying so. `cairn docs run-policy`
lists the same knobs as a wrapper-to-config table.

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

A partial `services:` block deep-merges over the top-level one; without a top-level block, an environment's `services:` stands alone (only that environment boots them — a provisioner for the one environment that pays for a machine, say). An env-level `secrets:` block replaces the top-level one entirely. Inside a partial `services:` block, `tmux: false` removes only the inherited local tmux windows while keeping the docker and seed phases — for apps running remotely over a tunnel that still own provisioning and seeding.

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
