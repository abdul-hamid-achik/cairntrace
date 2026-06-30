---
title: Troubleshooting
description: Common failure modes and what they mean.
---

# Troubleshooting

Things go wrong with specs. Most failures have a known shape. This page groups them by symptom so you can find the fix without reading the full source.

## "Spec did not satisfy the cold-start contract"

The runner verified the spec against a fresh browser session and the spec broke. Common causes:

- **Missing login action.** The spec depends on being signed in but did not `import:` a login snippet. Add one to the spec root and start with `{ use: <login-action> }`.
- **Precondition drift.** A preconditions step ran but did not set the state the spec assumed. Run the preconditions manually and check the post-state.
- **Session resume stale.** You captured a session yesterday; today's app doesn't recognize it. Re-capture.

Run `cairn run <spec> --cold-start --format json` to see exactly which step fails first.

## "Outcome verifier rejected: text contains X"

The `text` verifier expected a substring that wasn't there. Often the app changed copy:

- Did the app change its UI strings? Either update the verifier or pin the spec to the previous copy via a fixture.
- Did the page redirect to a different surface? The verifier expects a literal string but the new surface has something else.
- Are you on the wrong page? The open step landed somewhere different than you assumed.

Inspect `screenshots/` (when artifacts are enabled) or run with `--headed` to see what the runner sees.

## "noFailedRequests = false"

A 4xx or 5xx in the network log tripped the always-on health check:

- The 200 OK you saw was for the navigate, but a follow-up fetch (analytics, telemetry, auth-refresh) failed. Look at `network/network.har`.
- The cookie/session expired. Re-auth and retry.

If the failing request is a third party (analytics, telemetry), your spec is reporting on someone else's bug. Either fix the third party or accept the failure mode in the spec by relaxing `noFailedRequests: true` to a narrower outcome.

## "Timeout: step exceeded 30000 ms"

Step `timeoutMs` ceiling hit. Triage:

- Is this the first step? Hydration waits. Use `open: { path: "/...", waitUntil: networkidle }` instead of a separate `wait:`.
- Is this a form submission to a slow backend? Override per-step with `timeoutMs: 60000`.
- Is this on `localhost` and the dev server is slow to respond? Restart the dev server.

A blanket `run.timeoutMs: 600000` is a code smell. Fix the slow step.

## "Contract hash mismatch"

You're trying to run a spec whose `intent + outcomes` changed without re-stamping. Re-stamp:

```bash
cairn spec verify <spec> --stamp
```

If the contract changed *intentionally*, this is correct. If it changed by accident, `git diff <spec>` to find what changed and revert.

## "Browser backend unavailable"

The CLI couldn't connect to `agent-browser` or Playwright. Common causes:

- The chosen backend isn't on `$PATH`. Run `cairn doctor --format md` to see which it expects.
- The browser version doesn't match the playwright version. Run `npx playwright install chromium`.
- The agent-browser service isn't running. Start it per its docs.

## "Sealed environment: env X is reserved"

You tried to override a reserved env var like `PATH` or `HOME`. The runner refuses. Workaround: rename the variable in your spec, e.g. `${env.MY_API_PATH}`.

## "Redaction layer rejected your config pattern"

Your `cairntrace.config.yml > redaction.patterns` has a regex that doesn't compile. The runner fails at parse-time so it doesn't ship a broken redactor.

Test the regex in isolation:

```bash
node -e 'new RegExp(process.argv[1])' "authorization: .*"
```

Then fix the pattern and retry.

## "Evaluator failed because no consent"

`type: 'script'` outcomes sometimes prompt the user before running. In `--json` / `--yaml` modes, prompts are off by design. In interactive modes, the prompt is a typed-args flag (`--confirm=true`).

If you never want a prompt, set `mcp.perToolConfirm: []` (the default).

## Performance: the spec takes minutes to run

- Too many network captures? Set `artifacts.network: on-failure` instead of `always`.
- Too many screenshots? Set `artifacts.screenshots: on-failure`.
- Cold-start spinning up several services? Set `services.docker.reuseExisting: true`.
- `wait: { load: networkidle }` waiting for an SPA with persistent polling? Switch to `load` and add `slowMo` per step.

## Behavior: the spec is flaky

- It passes 9 of 10 times. The flake is usually animation timing. Add explicit waits on the affected transitions (`wait: { selector: "[data-testid='cart-count']", state: visible, timeoutMs: 2000 }`).
- It passes only when you're watching. Likely a screenshot-vs-DOM-state race. Read the contract; tighten the verifier to the DOM state, not the screenshot.
- It passes only when a dev server is running. Stop testing the dev server — test the staging environment.

## Common misconfigurations

- Forgot to set `run.out`. Artifacts land in `./run/` and the CLI's working directory, not your project's test output dir.
- Set `artifacts.screenshots: 'always'` for a spec that takes 200 steps. Disk fill. Set it to `'on-failure'` until you know what you're capturing.
- Two specs share a session resume name but expect different sessions. Resume names are project-scoped; namespace them per-spec.

## Getting help

If none of the above fits:

1. Run `cairn doctor --format md` — surfaces environment-level issues first.
2. Read `agent_context.md` from the failing run dir — gives the runner's narrative of what went wrong.
3. Look at `diagnostics/failure.md` — the structured failure summary.
4. File an issue with the failing run dir attached as a `.tgz`. Reports without the artifact pack are hard to triage.

## See also

- [Authoring](/authoring) — the discipline that prevents most of these failures
- [Steps](/steps) and [Verifiers](/verifiers) — the typed vocabularies
- [Configuration](/configuration) — config keys and their validation
- [Distribution](/distribution) — install paths and version pinning
