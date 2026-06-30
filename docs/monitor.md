# Process monitoring

`cairn run --monitor` samples the browser process tree (CPU/RSS) during a run via the external [monitor](https://github.com/abdul-hamid-achik/monitor) CLI. It turns "the spec got slow" into a measured, assertable fact. Monitor is optional and zero-cost when absent — every call degrades gracefully.

## The `--monitor` run flag

```bash
cairn run flows/heavy-dashboard.yml --monitor --format json
```

While the run executes, the runner samples `backend.browserPid()` on a schedule and writes `diagnostics/process.{md,json}` into the run directory. It also implicitly turns on under `MONITOR=1` for CI that wants it everywhere. Without `--monitor` (and without `MONITOR=1`), no sampling happens and the `process` verifier reports `skipped`, not `failed`.

`diagnostics/process.json` carries the sampler summary: `peakRss`, `meanRss`, `finalRss` (megabytes), `peakCpu`, `meanCpu` (summed tree CPU percent), and `samples` (count).

## The `monitor` step

Capture a process profile or a one-shot sample at a *specific point* in the flow — not just the run-wide summary.

```yaml
steps:
  - open: /heavy-dashboard
  - monitor: { action: profile, type: heap, assign: heapAfterLoad }
  - monitor: { action: snapshot, label: after-scroll }
```

- `action: profile` with `type: heap|cpu|goroutine|sample` captures a profile of the backend's browser process tree. With `assign`, the result is written to `monitor/<assign>.json` and registered as a named artifact, reusable via `${artifacts.<assign>.path}`.
- `action: snapshot` takes a one-shot sample, optionally labeled.

The `monitor` step targets `backend.browserPid()`, so it fails if no browser has spawned yet or `monitor` is not on `$PATH`. It is handled by the runner *before* adapter dispatch — it is not a backend interaction.

## The `process` verifier

Assert on the monitor-reported metrics collected by `--monitor`. Each matcher is `{ below | atLeast | equals }` and all present matchers must pass.

```yaml
verify:
  process:
    peakRss: { below: 500 }    # megabytes
    meanCpu: { below: 90 }      # summed tree CPU percent
```

RSS matchers compare against megabytes; CPU against summed tree CPU percent. The verifier reports `skipped` (not `failed`) when the run was not monitored, so a spec carrying a perf budget does not fail on every non-monitored run. Pair it with `--monitor` (or `MONITOR=1`) to actually enforce the budget.

## Binary configuration

The monitor client defaults to `monitor` on `$PATH` and can be overridden:

```bash
CAIRN_MONITOR_BINARY=/opt/monitor/bin/monitor cairn run flows/x.yml --monitor
```

Every call carries a short execa timeout so a wedged `monitor` invocation can never hang a run. Cairntrace never hard-depends on monitor being installed.

## When to use it

- **A spec regressed on time but outcomes still pass** — add `--monitor` and a `process` verifier to catch a memory leak the contract does not encode.
- **Investigating a slow SPA** — `monitor` steps with `assign` let you capture a heap profile right after load and right after a heavy interaction, then compare.
- **CI perf gate** — `MONITOR=1` + `process: { peakRss: { below: 500 } }` fails the build on a regression, not just on a threshold crossing in a dashboard.

## See also

- [Steps](/steps) — the `monitor` step in the step vocabulary
- [Verifiers](/verifiers) — the `process` verifier
- [Doctor & clean](/doctor) — the `monitor` availability check
- [Artifacts](/artifacts) — `diagnostics/process.json` and `monitor/` outputs