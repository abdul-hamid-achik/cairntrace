---
title: Delegated runners
description: Run a cairn invocation on another machine through a runner command while the local process keeps the journal, run directories, exit code and cancel (contract urn:cairntrace.dev:delegate:v1).
---

# Delegated runners

An environment can run somewhere else. With `environments.<name>.runner`, `cairn run --env <name>` (and MCP `cairn_run`) still validates the selection, writes the invocation journal, owns the exit code and handles Ctrl-C locally, but hands the execution to a command you provide: the **runner**. The runner starts the same invocation on another machine (a CI box, a VM, a container host), streams that invocation's events back and copies its run directories into the local artifact root.

Because the local `cairn` process keeps the invocation, everything that reads it works unchanged: Studio's live view, its Stop and Cancel buttons, `cairn logs --invocation … --follow`, `cairn stats`, `cairn_run_status`, `cairn_run_cancel`, JUnit and the `--json` document.

Cairntrace knows nothing about where the runner sends the work. The runner implements one stable, versioned contract: **`urn:cairntrace.dev:delegate:v1`**. Cairn never takes the runner's word for a result: the exit code is checked against what the stream and the copied run directories show (see [Exit codes](#exit-codes)).

## Configure a runner

```yaml
version: 1
environments:
  local:
    baseUrl: http://localhost:8080
  remote:
    baseUrl: http://localhost:8080        # what the remote side uses; informational here
    services: false                       # required when it would inherit services
    runner:
      command: [bun, tools/remote-run.ts, --pool, "${vars.pool}"]
      cwd: .                              # relative to the config directory (default)
      env: { REMOTE_REGION: eu-west, REMOTE_TOKEN: "${secrets.REMOTE_TOKEN}" }
      timeoutMs: 14400000                 # 4h hard deadline (default: none)
      idleTimeoutMs: 600000               # cancel after 10 min without a stream line (default: none)
      cancelGraceMs: 180000               # default: 3 minutes after SIGINT
    run: { lock: false }                  # the runner manages its own capacity
vars: { pool: default }
suites:
  smoke: { specs: [flows/smoke] }
```

```bash
cairn run --suite smoke --env remote
```

| Key | Meaning |
|---|---|
| `command` | The runner's argv. Never a shell string. `${env.X}`, `${secrets.X}`, `${vars.X}`, `${config.dir}` and `${baseUrl}` resolve when it is spawned |
| `cwd` | Working directory, relative to the config directory |
| `env` | Extra environment for the runner. Values resolve like `command`. `CAIRN_DELEGATE_*` and `CAIRN_INVOCATION_*` are reserved |
| `timeoutMs` | A hard deadline for the whole runner. At the deadline cairn cancels it like a Ctrl-C and the invocation exits 2 |
| `idleTimeoutMs` | The longest the events stream may stay silent. Every line counts, remote heartbeats included (a followed remote journal beats every 15 s). Past it cairn cancels the runner like a Ctrl-C and the invocation exits 2 (diagnostic `idle`). Without it, cairn only warns once after 5 minutes of silence |
| `cancelGraceMs` | How long a cancel waits after SIGINT, so the runner can stop the remote invocation and copy what it produced. Default 180000 |

An environment with a runner may not own a `services:` block. That includes a block it inherits through `extends`: set `services: false`. The top-level `services` and `webServer` apply to the local environments only. `cairn config validate` lists the delegated environments under `delegatedEnvironments`.

A runner environment never runs a spec locally. An invocation whose specs resolve to a runner environment and to any other one (a spec's own `environment:` without `--env`), in whatever order, is refused with exit 4 before anything starts: run them separately, or pass `--env <runner env>` to send them all to the runner. No path runs a spec of a runner environment in a local browser: `cairn run` delegates it, and heal, investigate, discovery and accompany sessions refuse it.

## What runs where

| Phase | Local `cairn` | Runner / remote side |
|---|---|---|
| config, engine pin, `--suite` resolution, `requires.env` / `mutates` policy, `--select-only` | yes | its own `cairn` repeats them for its own environment |
| scoped secrets (`secrets.provider`) | yes (for preflight checks and `${secrets.X}` in the runner) | its own |
| `run.lock` | yes, scoped to the delegated environment: it never blocks the local environments' runs or `cairn services`. Turn it off with `environments.<name>.run.lock: false` when the runner manages its own capacity | its own |
| `run.preflight` | yes (scope checks with `when: { env }`) | its own |
| `run.verifyClean` | no: nothing of the run is local | its own |
| services, webServer, browser, suite `before` / `after` hooks, metrics, fixtures, `--before` / `--after` | no | yes |
| `run.finally` | yes, after the runner exited, with `CAIRN_EXIT_CODE` | its own |
| journal, exit code, cancel, JUnit, the result document | yes | — |

`runtimes.node` is not enforced locally for a delegated environment: node scripts run on the remote side. `--stamp-if-green` and `--auto-annotate` are not applied to a delegated invocation.

A spec the local environment policy refuses never runs anywhere for that invocation. It is reported `refused` locally, the request lists it under `refused`, and `cairnArgs` carry the explicit list of the other specs (next to `--suite <name>` they narrow the suite, which keeps its hooks, vars and labels).

## The contract (v1)

### What cairn hands the runner

The runner is spawned in a process group of its own, with:

| Variable | Value |
|---|---|
| `CAIRN_DELEGATE_REQUEST` | Path of the request, a JSON file (mode 0600) |
| `CAIRN_DELEGATE_EVENTS` | Path of the events stream file the runner appends to |
| `CAIRN_DELEGATE_CONTRACT` | `urn:cairntrace.dev:delegate:v1` |
| `CAIRN_INVOCATION_ID`, `CAIRN_INVOCATION_DIR` | The local invocation and its journal directory (read-only for the runner) |
| `CAIRN_ARTIFACT_ROOT` | The local artifact root |
| `CAIRN_ENV`, `CAIRN_BASE_URL`, `CAIRN_CONFIG_DIR` | As for a suite hook |

It also gets the invocation's scoped environment (as a suite hook does) and `runner.env`. stdout and stderr go to a file that cairn copies, redacted, into `<journal>/logs/delegate.log`. They are never a pipe that could block the runner. They are shown with `--verbose`.

The request (`DelegateRequestSchema` in `src/core/schema/delegate.v1.ts`):

```json
{
  "$schema": "urn:cairntrace.dev:delegate:v1",
  "version": 1,
  "cairnVersion": "3.1.0",
  "invocationId": "2026-10-03T10-00-00-000Z_4242_abc123",
  "createdAt": "2026-10-03T10:00:00.000Z",
  "env": "remote",
  "configPath": "/work/project/cairntrace.config.yml",
  "configDir": "/work/project",
  "suite": "smoke",
  "specs": ["flows/smoke/login.yml", "flows/smoke/search.yml"],
  "planned": [{ "index": 1, "spec": "flows/smoke/login.yml" }, { "index": 2, "spec": "flows/smoke/search.yml" }],
  "options": { "var": ["mode=fast"], "label": ["round=7"], "backend": "playwright" },
  "resolved": { "vars": { "mode": "fast" }, "labels": { "suite": "smoke", "round": "7" }, "bail": false, "parallel": 1 },
  "cairnArgs": ["run", "--suite", "smoke", "--var", "mode=fast", "--label", "round=7", "--backend", "playwright", "--label", "cairn.delegate=2026-10-03T10-00-00-000Z_4242_abc123"],
  "artifactRootLocal": "/home/me/.cairntrace/runs",
  "journalDirLocal": "/home/me/.cairntrace/runs/_invocations/2026-10-03T10-00-00-000Z_4242_abc123",
  "eventsPath": "/tmp/cairn-delegate-x1y2z3/events.ndjson",
  "timeoutMs": 14400000,
  "idleTimeoutMs": 600000,
  "cancelGraceMs": 180000
}
```

- `specs` and `planned[].spec` are relative to the config directory, so they mean the same files in a checkout on another machine.
- `planned` lists the runs the runner must settle. When the local environment policy refused a spec, its entries move to `refused` (`[{ index, spec, reason }]`, present only then), so `planned` indexes may have gaps.
- `options` holds the portable run options exactly as the caller gave them. `resolved` holds what the local resolution made of them.
- `cairnArgs` are the arguments of the remote `cairn` command, without `--env` (the runner picks the remote environment) and with `--label cairn.delegate=<invocationId>`. That label finds the remote journal and links the copied runs back (`cairn stats --invocation <local id>` matches it). When the local policy refused a spec, `cairnArgs` name the other specs explicitly (`run flows/a.yml --suite smoke …`: spec paths next to `--suite` narrow it), so the remote side never runs a refused spec. Run `cairnArgs` as given: they are what makes the copied runs this invocation's.
- `runToken` is present only when the caller pinned `--run-token`.
- A runner must ignore fields it does not know. v1 changes only additively.

### What the runner writes: the events stream

`CAIRN_DELEGATE_EVENTS` is a file, not a pipe: append one JSON object per line and never truncate it. Every line is an [events.v1](/artifacts) event:

- the remote invocation journal's own lines (`invocation.started`, `suite.*`, `hook.*`, `services.*`, `run.lock.*`, `preflight.*`, `phase.changed`, `run.refused`, `metric.sampled`, `invocation.finished`, …);
- `invocation.run.started` `{ index, spec, runId }` and `invocation.run.finished` `{ index, spec, runId, status, synthetic?, durationMs? }`, one pair per planned run;
- `invocation.summary` `{ invocationId, status, summary }` once the remote invocation settled;
- optionally the runner's own `delegate.progress` `{ message, phase? }` lines ("provisioning the machine", "copying results"). They are narrated like cairn's own and move the local phase.

**You do not have to produce these by hand.** On the remote machine, `cairn logs --invocation <ref> --follow --relay` prints exactly this stream for one journal and exits 0 when it settled (2 when its process died). `<ref>` can be `label:cairn.delegate=<invocationId>`: the newest journal with that label, waited for with `--follow` — at most `--wait-timeout` (default 10m; `0` waits without end), then exit 2. Pipe it into the file:

```bash
ssh worker "cd /srv/project && cairn logs --invocation label:cairn.delegate=$ID --follow --relay --wait-timeout 10m" >> "$CAIRN_DELEGATE_EVENTS"
```

The relay validates every line, and a bad line never stops it:

- A line that is not JSON, not an events.v1 event, or longer than 1 MiB becomes an error `delegate.diagnostic` (`malformed-line`, `invalid-event`, `line-too-long`) and is skipped. An event type this cairn does not know is a warning (`unknown-event`). A known event with fields this cairn does not know is relayed without them.
- `delegate.*` is cairn's own namespace: a runner may write only `delegate.progress`. Any other `delegate.*` line is refused (`invalid-event`), as is an event whose relative path (`path`, `logPath`, `screenshot`…) is absolute or climbs out with `..`.
- **Re-streaming from the start is safe.** An exact repeat of a line is dropped (the last 50 000 distinct lines are remembered). Run lines repeat by state: a run that settled never goes back to running and keeps its first status (a later, different status is a `status-mismatch` error). A connection that dropped mid-line leaves a torn line glued to the first re-streamed one: the relay drops the torn head (a `malformed-line` warning) and relays the whole event after it. The derived `invocation.run.*` lines `cairn logs --relay` prints carry the same timestamps on every replay.
- Remote heartbeats and `log.opened` lines are dropped (they describe the other machine). The remote `invocation.started` / `invocation.finished` become `delegate.remote.started` / `delegate.remote.finished`. Everything else lands in the local journal with `delegated: true`.
- The remote invocation is the one the stream named (its latest `invocation.started`). Its `invocation.finished` and `invocation.summary` count only when they carry that invocation id.
- A remote run of a spec the local policy refused is a `refused-run` error and is not relayed. A run reported `passed` with `synthetic: true` is recorded errored (`synthetic-pass`): a pass needs a run directory.

### What the runner places: run directories

Every run the stream reports finished must end up as `<artifactRootLocal>/<runId>/`, a copy of the remote run directory:

- copy everything else first, then `run.json`, then `artifact-manifest.json`, so a reader that sees the manifest sees a complete run;
- keep modification times (`latest` / `previous` order by directory mtime);
- mirror while the invocation runs if you want Studio's run view to be live (every 10–15 s is plenty), and once more at the end.

cairn never rewrites a copied run directory: its `run.json` is the remote cairn's own record, so its `runDir` and `invocation` name the other machine. The local journal's `runs[]` and the result document's `runDir` point at the local copy, which every relative artifact path resolves against. Studio and `cairn logs <runId> --follow` judge a copied run's liveness by the local invocation that lists it, never by the remote pid in its heartbeats.

When the runner exited, cairn checks every run the stream named (**v1 conformance**):

| Check | Diagnostic |
|---|---|
| a finished run has `run.json` there, of that run id | `missing-run-dir` (error) |
| its `run.json` carries `labels["cairn.delegate"]` = the local `invocationId` (the remote `cairn` adds it when it runs `cairnArgs`) | `foreign-run` (error) |
| the directory was not under the local artifact root before the runner started | `stale-run` (error) |
| its `run.json` status is the one the stream reported (`run.json` wins) | `status-mismatch` (error) |
| a run that started and never finished has a `run.json` (its status is taken from it) | `unfinished-run` (error without one) |
| every planned run was settled, beyond what the remote summary reports refused or skipped (when the runner claimed a result: exit 0 or 1) | `missing-run` (error) |
| the directory has `artifact-manifest.json` | `incomplete-run-dir` (warning) |

A run whose directory is missing, foreign or stale is recorded errored, whatever the stream said, and the result document gets an errored stand-in for it: another invocation's run.json is never handed over as this one's.

### Exit codes

The runner exits with the remote invocation's exit code. cairn treats it as a claim and settles on the most severe code the evidence shows, with an `exit-mismatch` diagnostic saying why whenever it is not the runner's:

| Situation | Exit |
|---|---|
| The runner exits 0 and every planned run was settled by a run directory of this invocation, every `run.json` agrees with the stream, every relayed run passed, the remote invocation's own `invocation.finished` / `invocation.summary` (same invocation) passed, and the stream had no error | 0 |
| …a run directory is missing, foreign or stale, a run never finished, a report contradicts the evidence (`status-mismatch`, `synthetic-pass`, `refused-run`), or a planned run was never settled | 2 |
| …the remote invocation did not pass | its code (its summary's `exitCode`; else 1 for `failed`, 2 otherwise) |
| …a relayed run failed or errored | the runs' code (1 or 2) |
| …a stream line was malformed, invalid or too long | 2 |
| The runner exits 1 and a relayed run (or the remote invocation) failed | 1 (planned runs `--bail` stopped do not change it) |
| …but nothing relayed failed (or a run directory is missing, foreign or stale, or a report contradicts the evidence) | 2: an infrastructure failure is never a red test |
| The runner exits 2–9, 130 or 143 | that code (never lowered) |
| Any other exit code (`invalid-exit-code`) | 2 |
| The runner died of a signal cairn did not send (`runner-signal`) | 2 |
| The runner could not be started (`spawn-failed`) | 2 |
| `runner.timeoutMs` passed (`timeout`) or `runner.idleTimeoutMs` of silence (`idle`) | 2 |
| A cancel (Ctrl-C, SIGTERM, Studio Stop or Live Cancel, `cairn_run_cancel`) | 130 (143 for SIGTERM) |
| `--strict-requires` and the local policy refused a spec, runner exit 0 | 7 |

Every spec refused locally by the environment policy means nothing is delegated (exit 7). The result document always carries `invocationOutcome` with a `delegate` block (`remoteInvocationId`, `runnerExitCode`, `runnerSignal`, `diagnostics`). The first 100 diagnostics are journaled and the first 20 narrated; the rest are counted (`suppressed`).

### Cancel

Ctrl-C, SIGTERM, Studio's Stop and Live Cancel buttons (both send cairn SIGINT) and MCP `cairn_run_cancel` all reach the runner the same way:

1. SIGINT to the runner's **pid only** (`delegate.cancel.requested`). The helpers it already runs in its process group (an ssh connection following the remote stream, an rsync mirroring run directories) keep running, so it can use them to cancel remotely and copy the results back;
2. up to `cancelGraceMs` for it to exit, while cairn keeps relaying the stream and beating the journal's heartbeat;
3. SIGTERM to the runner's whole process group (`delegate.cancel.escalated`), 10 s later SIGKILL to the group;
4. the last lines are read, the run directories checked (`delegate.cancel.finished`, `delegate.finished`), the journal marked aborted, `run.finally` run, the lock released. The process exits 130 / 143. After the runner exited, whatever it left in its group gets SIGTERM.

On SIGINT the runner should cancel the remote invocation, copy what it produced, stop its helpers and exit 130. Because only the runner's pid gets SIGINT, `command` must be the runner itself or a wrapper that passes SIGINT on: `exec` the runner from a shell script (a shell waiting for a foreground child runs its trap only when that child ends), and prefer `bun runner.ts` / `node runner.js` over package-manager wrappers. A second Ctrl-C does not escalate (send SIGKILL to cairn to abandon the wait; the runner keeps cancelling on its own).

Studio's Live **Cancel** of a delegated run sends SIGINT and does not SIGKILL cairn while it waits for the runner (a safety-net SIGKILL comes only after `cancelGraceMs` + 75 s); quitting Studio sends SIGINT too, and cairn finishes the cancel on its own.

### Journal and Studio

The local journal (`<artifactRoot>/_invocations/<id>/`) is an ordinary invocation journal plus:

- `invocation.json` `delegate`: `{ contract, command (redacted), pid, remoteInvocationId, remoteStatus, exitCode, signal, cancelled, timedOut, idle, diagnostics }`, and `runs[]` pointing at the local copies;
- `events.ndjson`: `delegate.started`, `delegate.remote.started|finished`, `delegate.progress`, `delegate.diagnostic`, `delegate.cancel.requested|escalated|finished`, `delegate.finished`, and the relayed events (`delegated: true`);
- `logs/delegate.log` (the runner's output, redacted) and `delegate/request.json` (the request, masked).

Studio labels the invocation **delegated**; its Stop button and the Live Cancel button send SIGINT, which cancels the runner. `cairn_run_status` returns the same `delegate` block. `cairn logs <runId> --follow` on a copied run follows the local owner, not the remote heartbeat.

### Dry run

`--services-dry-run` and `--select-only` on a delegated environment print the plan and spawn nothing: the runner argv, `runner.env` names (never values), the timeouts and the request with secrets masked (`--var` values under credential-like keys, registered secret values). JSON consumers get it as `delegate` on the document.

## Writing a runner

A checklist for an orchestrator that runs the invocation on a machine it manages:

1. Read `CAIRN_DELEGATE_REQUEST` and check `$schema` is `urn:cairntrace.dev:delegate:v1`. Ignore fields you do not know.
2. Take capacity (a slot, a machine). If none is free, append a `delegate.progress` line and wait, or exit 4.
3. Put the project on the remote machine (same layout, so `specs` resolve), with a cairn at least `cairnVersion` (or the version the config's `requires.cairntrace` pins).
4. Deliver secrets the remote run needs through your own channel. Never write them into the events stream or a run directory.
5. Start `cairn <cairnArgs…> --env <remote env>` there, in the project directory, with `cairnArgs` exactly as given: they carry the `cairn.delegate` label every copied `run.json` must have, and the explicit spec list when the local policy refused something.
6. Follow it: `cairn logs --invocation label:cairn.delegate=<invocationId> --follow --relay --wait-timeout 10m`, appended to `CAIRN_DELEGATE_EVENTS`. Reconnect on a dropped connection; re-streaming from the start is safe. Write nothing else into the file but your own `delegate.progress` lines (never other `delegate.*` events).
7. Mirror `runs/<runId>/` into `artifactRootLocal/<runId>/` periodically and at the end: `run.json` and `artifact-manifest.json` last, mtimes kept. Copy only this invocation's runs; never point the stream at a run directory that is already there.
8. On SIGINT (it reaches your pid only): cancel the remote invocation, wait for it, keep the follower running until the remote journal settled, do the final mirror, stop your helpers, then exit 130. Finish within `cancelGraceMs`; after it your whole process group gets SIGTERM, then SIGKILL.
9. Release capacity on every exit path.
10. Exit with the remote invocation's exit code (from its `invocation.summary`, or the remote command's own). Exit 2 for an infrastructure failure of your own, never 1: 1 means a test failed, and cairn turns a 1 that no relayed run backs into 2.

A skeleton (TypeScript on Bun; `remote` is whatever your infrastructure gives you):

```ts
import { appendFileSync, readFileSync } from "node:fs";

const request = JSON.parse(readFileSync(process.env.CAIRN_DELEGATE_REQUEST!, "utf8"));
if (request.$schema !== "urn:cairntrace.dev:delegate:v1") process.exit(2);
const events = process.env.CAIRN_DELEGATE_EVENTS!;
const progress = (message: string) =>
  appendFileSync(events, `${JSON.stringify({ ts: new Date().toISOString(), type: "delegate.progress", message })}\n`);

const slot = await remote.acquireSlot();                       // your capacity
let cancelled = false;
process.on("SIGINT", () => { cancelled = true; void remote.cancelRun(slot); });  // the follower keeps streaming
try {
  progress(`slot ${slot.name}: shipping the project`);
  await remote.ship(slot, request.configDir);
  const run = remote.start(slot, ["cairn", ...request.cairnArgs, "--env", "worker"]);
  const follow = remote.stream(slot, ["cairn", "logs", "--invocation",
    `label:cairn.delegate=${request.invocationId}`, "--follow", "--relay", "--wait-timeout", "10m"]);
  follow.onLine((line) => appendFileSync(events, `${line}\n`));
  const mirror = setInterval(() => remote.mirror(slot, request.artifactRootLocal), 15_000);
  const code = await run.exitCode();
  await follow.done();
  clearInterval(mirror);
  await remote.mirror(slot, request.artifactRootLocal, { final: true });  // run.json + manifest last
  process.exitCode = cancelled ? 130 : code;
} catch {
  process.exitCode = 2;                                        // infrastructure, never 1
} finally {
  await remote.releaseSlot(slot);
}
```

`src/testing/fakeDelegateRunner.ts` in the repository is a complete reference runner for tests: it replays a recorded stream and copies run directories the way the contract asks, and it can misbehave on purpose (dropped lines, foreign run directories, a reconnect that tears a line, a helper in its process group) to show what cairn does about it.

## See also

- [Configuration](/configuration#delegated-runner-runner) — the `runner` key
- [Commands](/commands) — `cairn logs --relay`
- [Services](/services#run-policy-run-lock-preflight-clean-machine-belts) — the run policy a delegated invocation keeps
- [Artifacts](/artifacts) — events.v1 and the run directory layout
