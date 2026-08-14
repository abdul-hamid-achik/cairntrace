---
title: Troubleshoot Cairntrace Browser Tests
description: Diagnose Cairntrace cold-start gates, outcome failures, request errors, timeouts, contract mismatches, browser backends, secrets, performance, and flaky runs.
---

# Troubleshooting

Things go wrong with specs. Most failures have a known shape. This page groups them by symptom so you can find the fix without reading the full source.

## "Spec did not satisfy the cold-start contract"

The runner verified the spec against a fresh browser session and the spec broke. Common causes:

- **Missing login action.** The spec depends on being signed in but did not `import:` a login snippet. Add one to the spec root and start with `{ use: <login-action> }`.
- **Precondition drift.** A preconditions step ran but did not set the state the spec assumed. Run the preconditions manually and check the post-state.
- **Session resume stale.** You captured a session yesterday; today's app doesn't recognize it. Re-capture.

Run `cairn run <spec> --cold-start --format json` to see exactly which step fails first.

If the spec is green locally but locators miss in another environment, do not
loosen the contract. Export a [journey brief](/brief)
(`cairn export brief <spec> --from-run latest`) or open
`cairn_accompany_open` so a harness can choose WHERE while values stay
authored.

## "Outcome verifier rejected: text contains X"

The `text` verifier expected a substring that wasn't there. Often the app changed copy:

- Did the app change its UI strings? Either update the verifier or pin the spec to the previous copy via a fixture.
- Did the page redirect to a different surface? The verifier expects a literal string but the new surface has something else.
- Are you on the wrong page? The open step landed somewhere different than you assumed.

Equals/contains checks already normalize whitespace and ignore case by default,
so CSS `text-transform` alone should not cause this failure. If the outcome has
`caseSensitive: true`, verify that the rendered casing is intentional.

Inspect `screenshots/` (when artifacts are enabled) or run with `--headed` to see what the runner sees.

## "noFailedRequests = false"

A 4xx or 5xx in the network log tripped the always-on health check:

- The 200 OK you saw was for the navigation, but a follow-up fetch (analytics,
  telemetry, auth refresh) failed. Look at `network/failed_requests.ndjson`;
  `network/requests.ndjson` has the complete captured request stream.
- The cookie/session expired. Re-auth and retry.

If the failing request is a third party (analytics, telemetry), your spec is reporting on someone else's bug. Either fix the third party or accept the failure mode in the spec by relaxing `noFailedRequests: true` to a narrower outcome.

## "Timeout: step exceeded 30000 ms"

Step `timeoutMs` ceiling hit. Triage:

- Is this the first step? Hydration waits. Use `open: { path: "/...", waitUntil: networkidle }` instead of a separate `wait:`.
- Is this a form submission to a slow backend? Override per-step with `timeoutMs: 60000`.
- Is this on `localhost` and the dev server is slow to respond? Restart the dev server.

A blanket `timeoutMs: 600000` on every step is a code smell. Fix the slow step.

## Wait timed out with an empty `<main>` on a page that "should" have content

The signature: an authenticated header renders, `main` is empty in the failure
snapshot, and the same spec passes on re-run (or on the other backend). On the
agent-browser backend, both the `wait` predicate and the snapshot read the LIVE
document — two independent observers agreeing means the page really showed its
Suspense/loading fallback for the whole budget. This is streamed SSR failing to
commit (server-side stream abort, or hydration recovery starved by machine
load), not a driver misread. Triage in order:

1. Read `diagnostics/*.json` from the failing run: `readyState`,
   `suspenseBoundaries` (`pending` = server flush never arrived, `clientRendered`
   = a boundary errored server-side and fell back), and `landmarks` (which
   region is actually empty, and how empty).
2. Check machine load — orphaned browser trees from prior sessions are the
   classic culprit (`ps aux | grep agent-browser`). Kill stale ones.
3. A/B the backend: `cairn run <spec> --backend playwright` splits
   driver-vs-app in one command.
4. The failing run dir survives pruning (`retention.keepFailedRuns`) — attach
   it to the issue instead of describing it from memory.

Budgeted `text`/`notText`/`selector` waits are re-issued as fresh ≤5s
live-document slices, so a stale daemon-side wait can never eat the whole
budget; an exhausted wait's stderr records how many live polls ran.

## "Contract hash mismatch"

You're trying to run a spec whose `intent + outcomes` changed without re-stamping. Re-stamp:

```bash
cairn spec verify <spec> --stamp
```

If the contract changed *intentionally*, this is correct. If it changed by accident, `git diff <spec>` to find what changed and revert.

## "Browser backend unavailable"

The CLI couldn't connect to `agent-browser` or Playwright. Common causes:

- The chosen backend isn't on `$PATH`. Run `cairn doctor --format md` to see which it expects.
- The browser version doesn't match the Playwright version. Run `bunx playwright install chromium`.
- The agent-browser service isn't running. Start it per its docs.

## "Sealed environment: env X is reserved"

You tried to override a reserved env var like `PATH` or `HOME`. The runner refuses. Workaround: rename the variable in your spec, e.g. `${env.MY_API_PATH}`.

## "My secret still appears in artifacts"

The redaction layer scrubs any object key matching the built-in sensitive-key heuristic (`authorization`, `cookie`, `token`, `secret`, `password`, `api_key`, `code_verifier`, `otp`, `credential`, …), the `Authorization`/`Cookie`/`Set-Cookie` header lines, credential-bearing query params, and any literal value you list in the spec's `redaction:` block. Use `redaction.headers`, `redaction.queryParams`, or `redaction.storageKeys` for product-specific names; matching is case-insensitive. If a secret still leaks, its key does not match the heuristic and you did not configure its name or literal value:

```yaml
redaction:
  values: ["AKIA...your-literal-key..."]
```

Vault (tvault) secrets are registered automatically and scrubbed regardless of key name. Redaction is literal-value replacement, not regex — add the full secret string to `redaction.values`.

This applies to Cairntrace-authored text and structured JSON. Audit also
post-processes supported vidtrace text formats, but it does not rewrite
producer-owned binary files: screenshots/videos may show whatever the page
renders, downloads/transforms preserve their source bytes, and browser traces
or extracted frames can embed page state. If the leak is in one of those
artifacts, remove that run from any shared location, narrow the capture policy,
and rerun after hiding or replacing the sensitive UI/data.

## Performance: the spec takes minutes to run

- Too many network captures? Set `artifacts.capture.network: on-failure`
  instead of `always`.
- Too many screenshots? Set `artifacts.capture.screenshots: on-failure`.
- Cold-start spinning up several services? Set `services.docker.reuseExisting: true`.
- `wait: { load: networkidle }` waiting for an SPA with persistent polling? Switch to `load` and add `slowMo` per step.

## Behavior: the spec is flaky

- It passes 9 of 10 times. The flake is usually animation timing. Add explicit waits on the affected transitions (`wait: { selector: "[data-testid='cart-count']", state: visible, timeoutMs: 2000 }`).
- It passes only when you're watching. Likely a screenshot-vs-DOM-state race. Read the contract; tighten the verifier to the DOM state, not the screenshot.
- It passes only when a dev server is running. Stop testing the dev server — test the staging environment.

## Screenshot capture reports no rendering surface

Screenshot commands have a 15-second hard deadline. On a headed macOS run,
`no rendering surface` commonly means the display is asleep or the desktop
session cannot composite a frame; wake the display and rerun. On a headless
runner, confirm Chromium can create a compositing surface. The run records the
failure under `diagnostics/` instead of waiting indefinitely or publishing a
partial PNG. A capture timeout is best-effort: it does not fail the step, spec,
or outcomes — it only marks the backend wedged so the remaining optional
captures (console/network/trace/video) are skipped while the outcome verifiers
still run. If the page is genuinely wedged it fails on its next interaction.

## Common misconfigurations

- Forgot to set `artifactRoot`. Artifacts land in `~/.cairntrace/runs` by default, not your project's test output dir.
- Set `artifacts.capture.screenshots: always` for a spec that takes 200 steps.
  Disk fill. Set it to `on-failure` until you know what you're capturing.
- Two specs share a session resume name but expect different sessions. Resume names are project-scoped; namespace them per-spec.

## Getting help

If none of the above fits:

1. Run `cairn doctor --format md` — surfaces environment-level issues first.
2. Read `agent_context.md` from the failing run dir — gives the runner's narrative of what went wrong.
3. Read the failed step's `diagnostics/<step-ordinal>_<step-id>.json` when it
   exists — it contains the structured page state captured at failure.
4. File an issue with the failing run dir attached as a `.tgz`. Reports without the artifact pack are hard to triage.

## See also

- [Authoring](/authoring) — the discipline that prevents most of these failures
- [Steps](/steps) and [Verifiers](/verifiers) — the typed vocabularies
- [Configuration](/configuration) — config keys and their validation
- [Distribution](/distribution) — install paths and version pinning
