# Changelog

All notable changes to cairntrace are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).
## [Unreleased]

## [1.40.1] - 2026-07-17

### Fixed

- **tmux services boot no longer loses `send-keys` to direnv/zsh startup.**
  After creating a window, cairn waits for a stable interactive shell, clears
  residual pane history (so `readyOn` text cannot match stale "listening"
  lines), then sends pre-commands and the main command. Pre-commands wait for
  the shell to return before the next `send-keys`, so a long `yarn build` is
  not stomped by `yarn start`.
- **tmux session reuse heals dead/missing windows.** A leftover session no
  longer short-circuits startup: missing windows are created, idle shell panes
  (command never started or process died) are re-launched, and panes already
  running a non-shell process are left alone.
- **teardown no longer runs `docker compose down` while reusing tmux.** Live
  dev-server panes need mongo/rabbit/postgres; tearing docker down while
  leaving the session alive was orphaning Go/Node services against dead ports.
  With `tmux.reuseExisting: false`, full teardown (tmux kill + docker down)
  still runs.

## [1.40.0] - 2026-07-16

## [1.39.0] - 2026-07-16

## [1.38.0]

Read honesty: a backend that could not observe the page used to answer with a
value that satisfied the assertion. Every absence-shaped outcome — "no console
errors", "no failed requests", "this text is absent", "zero elements match" —
could therefore be certified against a page nobody successfully read, and
because outcomes are evaluated after the steps already passed, no step failure
flagged it. **This release turns some currently-green specs red. That is the
fix working**: those specs were passing on an unread page. There is no
deprecation window, because a deprecation window for "we stopped lying to you"
is just a longer lie.

Field-verified against a real app (liftclub): `notText` and `noFailedRequests`
outcomes pass unchanged; the example suite is byte-identical before and after,
apart from two specs that were already red.

### Fixed

- **Failed reads no longer report a green verdict.** Every backend read that
  could not observe the page degraded to a falsy value — `""`, `0`, `[]` — and
  each of those satisfies an absence-shaped assertion. A wedged daemon made
  `console.errorsMax: 0` and `noFailedRequests` pass over a page whose console
  and network log were never read; because outcomes are evaluated after the
  steps already succeeded, no step failure flagged it and the green was the
  only thing the user saw. `getText`, `getCount`, `getConsole`, `getErrors` and
  `getNetworkRequests` now throw on a failed read. Verifiers already surfaced
  throws as failed outcomes (`OutcomeEvaluator`) and step failures
  (`Runner`'s `when:` guard), and the Runner's `console.ndjson` dump keeps its
  best-effort `safe()` wrapper — only the verdict paths changed.
- **Absence assertions see every match in a region, not just the first.**
  `region:` may legitimately match several elements — `notText`'s guard admits
  `count > 1` — but agent-browser's `get text` returned only match #1 while
  Playwright's `innerText()` threw a strict-mode violation on 2+. An absence
  assertion therefore reported "confirmed absent" for text sitting in match #2.
  Both backends now read every match and join it the way Playwright's
  `allInnerTexts()` does, so they hand the text verifiers an identical
  haystack. The Playwright path waits for the first match explicitly, since
  `allInnerTexts()` does not auto-wait the way `innerText()` did.
- **Unreadable agent-browser output is an error, not an empty result.**
  `parseEnvelope` returned `[]` on unparseable stdout, a missing key, or a
  non-array value, on the reasoning that "verifiers should never crash" — but
  every caller feeds an absence-shaped verifier, so `[]` was itself the crash,
  reported as a pass. A successful `--json` read always emits its key (an empty
  console is `{"data":{"messages":[]}}`, never blank stdout), so these shapes
  cannot occur on a read that happened. A genuinely empty result set still
  returns `[]`.
- **`examples/flows/02-row-count.yml` and `07-config-driven.yml` were red.**
  Both counted `role: row` unscoped and expected 3, but `role: row` expands to
  `[role=row], tr` and the demo table's `<thead>` row is a row by ARIA
  semantics too — the true count is 4. Both now scope to `in_region: tbody`,
  which is what "3 inventory rows" always meant.

## [1.37.0]

Liftclub field hardening: silent framework click drops now recover or fail at
the authored interaction, text contracts tolerate rendered CSS casing, aborted
suites retain their completed evidence, and browser artifact capture is bounded.

### Added

- **Per-click and per-spec `settleMs`.** Agent-browser post-click network-idle
  settling now resolves click override → spec override → project
  `browser.postClickSettleMs` → 5000ms; a resolved `0` skips the settle AND the
  link-delivery probe (the author is opting out of post-click waiting).
  Playwright and Playwright exports honor explicit click/spec values while
  retaining native waits when neither is set.
- **Intentional guest cold starts.** `coldStart: guest` acknowledges a public,
  sessionless spec while preserving the required `--cold-start` replay gate.
- **Interrupted-batch summaries.** SIGINT/SIGTERM writes a strict
  `run-batch-aborted:v1` summary at the artifact root before teardown, with
  completed `RunResult` objects in input order and pending counts.
- **Text matcher case control.** `caseSensitive` is available for text/notText
  equals/contains outcomes and text waits. Regex matchers remain raw and
  case-sensitive.

### Changed

- **Framework-safe batch clicks.** A batch remains one native invocation, but
  click sub-steps are paced by 100ms. Checkbox/radio/switch state is re-queried
  across framework rerenders (including mixed state) and verified in two stages:
  a ~500ms grace lets a slow async commit land before a single live-element
  recovery click, then a ~500ms settle confirms the result. A double-toggle
  (late authored commit plus the recovery both applying and flipping the
  control back) fails loudly instead of passing a flipped-back state, and the
  failure names the authored sub-step + phase. Missing or implicit batch
  command results are failures, never silent success.
- **Rendered text defaults.** Human-facing text waits and equals/contains
  outcomes now collapse whitespace and compare
  case-insensitively by default across both backends and Playwright exports.
- **Link delivery verification.** Link clicks are classified first: only a
  same-tab http(s)/relative nav link briefly watches for a URL or DOM mutation,
  and a still-present enabled one gets a single low-level mouse retry at its
  live center. External-effect links (`target="_blank"`, a `download`
  attribute, or a `mailto:`/`tel:`/`javascript:` scheme) never mutate the
  current document, so they are clicked exactly once and pass with a diagnostic
  note — no double-fired retry, no false failure. Ordinary buttons are never
  retried this way.
- **Retention counts interrupted runs.** Failed/errored runs keep their
  `keepFailedRuns` carve-out, but interrupted runs (missing/corrupt/statusless
  `run.json` left by a signal) now count toward the `keepRuns` window instead
  of being retained forever — the newest interrupted run is preserved up to the
  cap and older ones age out. `pruneRuns`/`cairn clean` also sweep stale
  `aborted-<ts>-<pid>.json` batch summaries under the same cap; `cairn clean
  --all` remains authoritative.
- **Documentation site refresh.** The landing page, navigation, metadata,
  social preview, manifest, and responsive theme were overhauled.

### Fixed

- Screenshot capture now has a 15-second hard deadline on agent-browser and
  Playwright, reports the likely missing-rendering-surface/display cause, and
  never publishes a partial PNG. A capture timeout is best-effort — it records a
  warning + missing-artifact note but does not fail the step, spec, or
  outcomes; it only marks the backend wedged so the remaining optional captures
  (console/network/trace/video) are skipped while outcome verifiers still run.
- `cairn run` now returns its documented shell exit status after lifecycle
  teardown. Contract mismatches are actionable and return 6 in single, batch,
  and heal paths; ordinary parse/runtime errors remain 2.
- JSON run output stays pure JSON; web-server diagnostics and tails remain on
  stderr even when scoped loggers were created before final logger config.
- Batch semantic-locator schema mistakes name the offending sub-step, and
  ambiguity diagnostics retain only the first three accessible candidates plus
  an omitted count.
- TinyVault key listing no longer requires unlocking secret values; CLI and MCP
  status paths expose key names only.

## [1.36.0]

Hardening from the 2026-07-12 empty-`<main>` incident: an agent-browser text wait
timed out on a streamed-SSR dashboard whose Suspense content never committed
(stream abort under machine-wide contention), and the failing run's artifacts were
destroyed by routine pruning before anyone could read them. The failure never
reproduced. Verdict: both live observers (in-page `wait --text` predicate and the
post-failure a11y snapshot) were correct — the page genuinely showed the fallback.
This release makes the next such incident survivable and self-diagnosing.

### Added
- **Sliced live-document waits (agent-browser).** Budgeted `text` / `notText` /
  `selector` waits are re-issued as fresh ≤5s subprocess slices until the spec
  budget is spent, instead of one daemon-side wait holding the whole budget. Each
  slice re-queries the live document, so no daemon-side wait state can go stale
  across a navigation or streaming-SSR commit for more than one slice, and a
  wedged child burns one slice (+grace) instead of `timeoutMs`+5s. Happy path
  unchanged: the first slice returns as soon as the condition holds. Load-state
  waits and waits without a spec budget keep the single invocation (`--load`
  observes only future transitions; re-arming per slice would miss the one it
  needs). Exhaustion stderr records the true total: `wait exhausted its <N>ms
  budget across <k> fresh live-document polls`.
- **`retention.keepFailedRuns` (default 10).** The newest N `failed`/`errored`
  runs per spec now survive pruning on their own quota, beyond `keepRuns` —
  routine pruning can no longer destroy the only evidence of a failure that has
  stopped reproducing. Failed runs already inside the `keepRuns` window count
  against the quota; statusless/corrupt `run.json` stays prunable. `cairn clean`
  honors it; `--all` still removes everything. The clean report gains
  `keepFailedRuns`.
- **Streaming-SSR forensics in failure diagnostics.** `captureDiagnostics` now
  records `readyState`, `suspenseBoundaries` (React streaming comment markers:
  `$?` pending server flush, `$!` errored → client-rendered fallback), and
  `landmarks` (header/main/footer presence, child count, visible text length).
  A wait timeout on a streamed page now distinguishes "stream still pending" /
  "stream aborted" / "committed but empty" from one JSON artifact.

### Changed
- The agent-browser adapter header documents the verified CLI version (0.31.1)
  and that the binary is resolved from `$PATH` unpinned — first thing to check
  when wait/snapshot behavior changes after an update.

## [1.33.0]

### Added
- **`cairn spec heal --verify` — verified transactional heal (SPEC §7.2).**
  Proposes selector-drift ops, applies them to the owning file, cold-start reruns
  the spec, and accepts only if the rerun passes (all outcomes pass). On failure
  the owning file is restored (rollback). Returns a `HealVerifyResult` with
  `verified`, `confidence` (high|low), `beforeRun`/`afterRun` run IDs,
  retained `evidence` (the after run dir), and the exact `replay` command.
  Mirrors glyphrun's `glyph repair --verify`. New `healVerify` +
  `HealVerifyResult` in Healer.ts; `HealOutput` gains `owningFile` (always
  populated when ops > 0); CLI `--verify` flag on `cairn spec heal`.



## [1.32.0]

### Added
- **`replay.json` exact-replay manifest (SPEC §7.3).** Every run now writes
  `replay.json` alongside `run.json`: the exact `cairn run <spec> --json`
  command, backend, environment, base URL, viewport, resolved capture policy,
  the redacted env/var KEY NAMES (never values), the cairn version, and the run
  id. An agent can reproduce a run bit-for-bit without re-reading the resolved
  spec; §7.2's "exact replay action" return can cite it directly. Mirrors
  glyphrun's `replay.json`. New `src/core/schema/replay.v1.ts`; `RunArtifactsSchema`
  gains an additive `replay` field; `ArtifactWriter.writeReplay`; wired into
  the runner (best-effort — a write failure never fails the run). Test asserts
  the manifest is written, parses against the replay.v1 schema, carries the
  replay command + backend + cairn version.

## [1.31.0]

### Added
- **`nextActions` on non-passing RunResults** (SPEC §7.1 verification contracts).
  The `cairn run` / `cairn_run` MCP result now carries an additive `nextActions`
  array on failed/errored runs — one actionable next step (command + reason +
  `safeToAutoRun`, always false) derived from the run's failure, mirroring
  glyphrun's convention so an agent gets a concrete `cairn run <spec> --json`
  rerun command instead of an ambiguous error. Passed runs omit it (byte-identical).

### Changed
- **MCP `structuredContent` is now Zod-validated before sending (SPEC §7.1).**
  Every tool result that was cast through `as unknown as Record<string, unknown>`
  now routes through its declared Zod schema's `.parse()` first, so wire-shape
  drift is caught at the boundary instead of silently sent. `cairn_spec_heal`
  now routes through the same `toHealResult` converter the CLI uses
  (`HealResultSchema.parse(toHealResult(out))`) — it was previously sending the
  raw `HealOutput`. New permissive `mcp.v1` schemas cover the discovery /
  config / services surfaces that had no declared schema. `BackendSchema` gains
  `mock` (the mock backend is a real `cairn run --mock` option the schema omitted).
## [1.29.1]

### Fixed
- **Off-viewport click guard double-subtracted the page scroll.** `get box`
  returns viewport-relative coordinates (verified against
  `getBoundingClientRect` on agent-browser 0.31.1), but 1.28.x's
  post-scrollIntoView confirmation subtracted `window.scrollY` from the box
  center anyway — flagging every legitimately-scrolled click as
  "stayed off-viewport" (deterministic, not flaky: liftclub's
  member_checkout plans grid sits below the fold, so the in-view button at
  viewport y≈460 with scrollY≈875 computed to center y=-415). Clicks near
  the page top ran at scrollY=0 where subtracting zero is harmless, which
  is why the bug hid in otherwise-green suites. The check now compares the
  viewport-relative center directly against innerWidth/innerHeight.
- **The confirmation is now a short poll with re-scroll, not a one-shot
  read.** CSS `scroll-behavior: smooth` animates scrollIntoView over
  several hundred ms, and async sections above the target can collapse
  when their data lands, yanking a centered target back out of view. The
  guard re-reads (and re-issues scrollIntoView) every 250ms for up to
  1.5s; the happy path still returns on the first read, and genuinely
  unreachable position:fixed targets fail after the budget as before.

## [1.29.0]

### Added
- **Config `browser:` block — project-level tuning for the verify-after-click
  guard.** 1.28.1's `verifyAfterClick` (5s networkidle settle folded into every
  click) shipped adapter-only with no way to configure it from a project:
  `AgentBrowserOptions.verifyAfterClick` existed but nothing plumbed it through
  `createBackend`. Dev servers that compile modules on demand (Nuxt/Vite SPA
  routes) routinely need >5s to go network-quiet after a login click even
  though the page is fine, which failed every authenticated-page click in such
  projects (observed: 33/40 liftclub specs dying at `submit_login` while their
  outcomes passed). `cairntrace.config.yml` now accepts:

  ```yaml
  browser:
    verifyAfterClick: true     # default: true
    postClickSettleMs: 20000   # default: 5000
  ```

  Resolved once per `cairn run` invocation (same scope as `webServer`/
  `services`) and applied to every backend the run constructs, including
  parallel batch workers. Prefer raising `postClickSettleMs` over disabling
  `verifyAfterClick` — the wedge protection stays.

## [1.25.1]

Two agent-browser reliability fixes that both manifested as silent no-ops.

### Fixed
- **`viewport:` was silently ignored under the agent-browser backend.**
  `AgentBrowserAdapter.setViewport` sent `agent-browser viewport <w> <h>`, but
  browser-settings mutators are namespaced under `set` — there is no bare
  top-level `viewport` command. The command exited 1 ("Unknown command:
  viewport"), `window.innerHeight` never changed, and because the Runner
  routed `setViewport` through its error-swallowing `safe()` helper, no error
  surfaced to the spec author — the `viewport.set` event was written
  unconditionally and looked identical to a success. The adapter now sends
  `set viewport <w> <h>`, and the Runner records `ok: true|false` (plus
  `error:` on failure) on the `viewport.set` event so a broken apply is
  visible in `events.ndjson` and diagnostics. The Playwright backend was
  never affected (it applies viewport directly via `page.setViewportSize`).
- **Off-viewport `click` silently no-op'd under agent-browser.** When a
  target sits inside a `position: fixed` container taller than the viewport
  (e.g. a modal footer button past `window.innerHeight`), `scrollintoview`
  cannot bring it into view (a fixed element's position doesn't change with
  document scroll), yet agent-browser's `scrollintoview`, `is visible`, and
  `click` all report success — the click never lands and
  `document.elementFromPoint` at the target returns `null`. `click` (only)
  now runs an independent post-scroll viewport-membership check via `get
  box` + `eval`, and fails the step loudly with a diagnostic when the
  target's center is confirmed outside the live viewport, instead of
  silently passing. The check is best-effort: an inconclusive result (older
  agent-browser version, parse failure) never blocks the action. `hover` /
  `fill` / `type` / `upload` and `by: selector` locators are unchanged for
  now — extending the check there is straightforward if warranted.

## [1.23.7]

The three follow-ups deferred from the v1.23.6 review.

### Fixed
- **`notText` no longer passes vacuously over a missing region.** When a
  specific region was targeted (`notText: { contains, region: "#typo" }`) but
  the region didn't exist, `getText` returned `""` and the absence check passed
  silently, masking a broken assertion. It now confirms the region resolves to
  an element first and fails clearly if it doesn't. *A spec asserting absence
  over a missing region will now correctly fail.*
- **`count: { role }` counts native semantic elements, not just explicit
  `[role]` attributes.** `role: row` now matches `<tr>` (and `button` → native
  `<button>`, `link` → `<a href>`, `heading` → `<h1>`–`<h6>`, etc.), so a count
  over a normal `<table>` works. This is a heuristic CSS expansion — for exact
  ARIA semantics use a `selector`. *Role counts that were silently returning 0
  on native markup will now return the real count.*

### Added
- **Playwright importer round-trip coverage** for the steps the exporter
  already emits: `type` (`pressSequentially`, with `delay`), selector waits
  (`waitForSelector` → `wait: { selector, state, timeoutMs }`), and `.nth(N)` on
  role/label/text locators (previously silently dropped, which targeted the
  wrong element).

## [1.23.6]

A correctness pass over the healer and verifiers. Some fixes tighten checks, so
a spec that was passing on a *wrong* result may now correctly fail — see notes.

### Fixed
- **`cairn spec heal --apply` could corrupt the spec file.** When the healer
  inserted a wait step, it used `addIn(["steps", N], …)`, which merged the new
  step *into* `steps[N]` as a complex mapping key instead of splicing a sibling
  — producing an unparseable file. It now splices a proper sibling seq item.
- **`noFailedRequests` missed transport-level failures.** It only flagged
  requests with a 4xx/5xx status, so an aborted / blocked / DNS-failed /
  connection-refused request (which never gets a status) passed silently, and
  the evidence falsely read "returned <400". Failed requests are now marked by
  the Playwright adapter and counted; genuinely-pending/streaming requests are
  not flagged. *A spec that was silently ignoring a failed request may now
  fail.*
- **`count: { text }` is rejected at parse time.** It was accepted but silently
  matched zero elements (an `atMost`/`equals: 0` always passed, an `atLeast`
  always failed). Counting by text needs the a11y tree; use the `text` verifier
  for presence or `script` for a real count. The Playwright importer now maps
  text-visibility assertions to a `text` verifier instead.
- **`httpJson` `equals`/`contains` are order-insensitive** for object keys (was
  a `JSON.stringify` compare that failed when the server emitted keys in a
  different order), and **`atLeast`/`atMost` reject non-numbers** instead of
  coercing them (`Number([])` was `0`, making a bound vacuously pass).
- **`script` verifier requires a boolean `ok`** on the browser path too (the
  node path already did) — a truthy non-boolean like the string `"false"` no
  longer counts as a pass.
- Playwright exporter flattens newlines in `step.id` / `when` / `use` comments
  so a crafted multi-line value can't inject lines into the generated test.
- Cleared the remaining `oxlint` warnings (`Array#sort` → `toSorted`, function
  scoping).

## [1.23.5]

### Fixed
- **Placeholder substitution no longer breaks when a resolved value contains
  YAML metacharacters.** Substitution previously rewrote the raw YAML *text*
  and re-parsed it, so a secret/env/var value containing `:`, `"`, `{`, `#`, or
  newlines could corrupt the document (e.g. a quoted `"${env.X}"` resolving to
  `a: b "c"` produced invalid YAML). Substitution now resolves into the parsed
  YAML **AST** — the YAML library owns serialization, so any resolved value is
  safe. Types are preserved via scalar style: an unquoted `${env.PORT}`
  re-infers its YAML type (number/bool/null) exactly as before, while a quoted
  `"${env.PORT}"` stays a string. Structural values (`a: b`, `[1,2]`) can no
  longer silently restructure a spec. Behavior is unchanged for existing specs.

## [1.23.4]

### Added
- **Warnings for clip/video misconfigurations that would silently produce
  nothing.** A run now emits an `artifact.video` warning event when
  `clipPoints` are configured but `artifacts.capture.video` is `never` (so no
  video is recorded and no clips can be cut), or when video is requested on a
  backend that can't record it (only the playwright backend does). The marquee
  "run → video → vidtrace clip" loop no longer fails silently.

### Changed
- **Config `${env.X:-default}` now falls back on an *empty* env var, not just
  an unset one** — matching shell `:-` semantics and the spec parser, so
  `cairntrace.config.yml` and specs resolve the same placeholder identically.

### Internal
- Added GitHub Actions CI (`bun run verify` on push/PR + a real-Chromium
  end-to-end smoke); previously verification ran only via local git hooks.
- Added backend step-shape guards (opt-in strict `MockBrowserBackend`
  validation, a recorder→`StepSchema` contract test, and per-step
  `PlaywrightAdapter` coverage) so step-shape and adapter-no-op bugs can't ship
  green.

## [1.23.3]

### Fixed
- **MCP server now disposes its signal handlers on close.** `buildMcpServer`
  registered process-level `SIGINT`/`SIGTERM` handlers but never removed them,
  so building many servers in one process (e.g. across a test run) accumulated
  listeners past Node's `MaxListeners` default and emitted a warning.
  Production was unaffected (one server per `cairn mcp` process), but the noise
  masked any real listener leak. Handlers are now named and removed when the
  server closes, via the SDK's `Protocol.onclose` hook (chained so the SDK's
  own teardown is preserved).

## [1.23.2]

A review-and-fix pass over the v1.12–v1.23 DX/UX work. All fixes; no CLI/schema
surface changes.

### Fixed
- **Tvault secret values could leak unredacted into artifacts.** The artifact
  redactor only scrubbed env values whose *key* matched a sensitive-name
  heuristic (`token`, `secret`, `password`, …). Vault secrets with ordinary
  key names — `MONGO_URI`, `DATABASE_URL`, `STRIPE_*`, `SMTP_URL` — were
  injected into the environment but never registered for redaction, so their
  plaintext could appear in `spec.resolved.yml`, `run.json`, `report.html`,
  `agent_context.md`, and `events.ndjson`. Every value pulled from the vault is
  now registered with the redactor regardless of key name.
- **`type` step was a silent no-op under the Playwright backend.** The
  `PlaywrightAdapter` had no `type` branch in `runStep` or the batch path, so a
  `type` step reported a green pass while typing nothing (and the Playwright
  exporter dropped it). It now uses `locator.pressSequentially(...)`, and an
  exhaustiveness guard makes any future unhandled step fail loudly instead of
  passing.
- **`--env` did not reach the seed/services phase as `CAIRN_TVAULT_ENV`.**
  Services (docker/seed/tmux) start before secret injection, so under
  `cairn run --env dev` they resolved `${env.CAIRN_TVAULT_ENV:-local}` to
  `local` and could seed/migrate against the wrong environment's database.
  `CAIRN_TVAULT_ENV` is now set from `--env` at the very top of `cairn run`.
- **`${env.X:-default}` defaults containing `/` (URLs/paths) were not
  substituted in specs**, and substituted values that themselves contained
  `${...}` were re-expanded (cross-secret splicing, or a crash on a
  value-borne `${vars.X}`). Both are fixed by a single balanced-brace scanner
  that resolves each placeholder once and never re-scans a resolved value.
- **Discovery recorded schema-invalid `scroll` steps.** The step recorder
  emitted `{ scroll: { down: N } }`, which the strict schema rejects — it threw
  on the agent-browser backend and produced unparseable exported specs. Now
  emits `{ scroll: { direction, px } }`.
- **Services orphaned docker/tmux/seed on a partial-startup failure.** A
  later-phase failure (e.g. a tmux window that never becomes ready) left earlier
  phases running with no teardown. `startServices` now tears down what it
  started before propagating. Readiness and seed-freshness checks are also
  time-bounded now (they previously ran with no timeout and could hang a run
  forever).
- **Discovery browsers were orphaned on SIGINT/SIGTERM.** Session backends were
  created inline and not tracked by the signal-teardown machinery; the shutdown
  hook only fired an un-awaited async close. It now calls `terminateSync()` on
  each session backend so the agent-browser daemon + Chrome are killed on
  Ctrl-C.
- **Reviewing a discovery session could reap it mid-export.** Read-only ops
  (`_suggest`, `_export`) didn't refresh the session TTL, so a long review pause
  let the idle sweep close the session and lose all recorded steps. These ops
  now refresh activity.
- **Failed discovery steps were exported as if they had succeeded.** Export now
  excludes steps that did not execute successfully and reports how many were
  dropped.
- **`cairn spec verify --stamp` stripped hand-authored quoting.** Stamping
  re-serialized the whole spec in PLAIN style, mangling `"${vars.X}"` /
  `"${secrets.X}"` quotes and comments. It now updates only the `contractHash`
  node via the YAML Document API, preserving the rest of the file.
- **Discovery hardening:** concurrent operations on one session are now
  serialized (no interleaving on the shared browser), open sessions are capped
  to bound process/FD usage, user-declared services `teardown` commands run on
  the signal path, and a requested clip that can't be cut because vidtrace is
  missing now records a diagnostic instead of being silently dropped.

## [1.23.1]

### Fixed
- **`--env` flag now propagates to `CAIRN_TVAULT_ENV`** — when `cairn run --env dev`
  is used with `secrets.provider: tvault` in group/env mode, the tvault env
  was resolved from `${env.CAIRN_TVAULT_ENV:-local}` in the config. Since
  `--env` only set the cairn env name (for baseUrl/vars), but not
  `CAIRN_TVAULT_ENV`, tvault always resolved to `local` regardless of the
  `--env` flag. This meant dev-pinned secrets (e.g. `MONGO_URI`) were never
  injected. Now `--env <name>` sets `CAIRN_TVAULT_ENV=<name>` automatically,
  unless the caller explicitly set `CAIRN_TVAULT_ENV` to decouple the two.

## [1.23.0]

### Added
- **Tvault secret shadowing warning** — when `secrets.provider: tvault` is
  configured, `cairn run` now warns if any tvault secret key is already set
  in the process environment with a *different* value (e.g. from bun's
  automatic `.env` loading). Previously, stale `.env` credentials silently
  shadowed tvault values with no diagnostic, causing authentication failures
  that were hard to trace. The warning names the affected keys and suggests
  removing them from `.env` or unsetting them.

## [1.22.0]

### Added
- **`${env.X:-default}` fallback syntax** — spec placeholders now support
  shell-style default values when an env var is missing or empty:
  `${env.MISSING:-fallback}`. Defaults can themselves contain runtime
  placeholders like `${run.token}`. Empty-string env vars trigger the
  fallback, not just undefined ones.

## [1.21.0]

### Added
- **Discovery sessions** — interactive page exploration and spec authoring
  via `cairn discover open/navigate/interact/snapshot/export`. Create a
  stateful browser session, navigate, take accessibility snapshots, perform
  actions (click, fill, hover, type, scroll, press), and export recorded
  steps as a spec YAML file.

## [1.16.0]

### Added
- **`eval` step type** — a page-context JavaScript escape hatch that runs
  arbitrary JS in the browser via `backend.evaluate()` and optionally captures
  the JSON-serializable return value as `evals/<assign>.json`. Captured values
  are spliced into later steps via `${evals.<name>.value.<field>}`. Use it for
  state setup and internal-state assertions that no UI affordance can reach
  (seed a Vuex/Redux/Pinia store, read `localStorage`, assert on a computed
  property). Exactly one of `js` (inline) or `file` (path to a .js file) is
  required; optional `args` is passed as the single argument to the wrapped
  function; `assign: name` writes `{ value: <return> }` to `evals/<name>.json`
  (after redaction). Opaque to `heal` — there is no locator to repair. The
  backend primitive (`BrowserBackend.evaluate()`) already existed across all
  three adapters; this is a schema + runner + docs + tests effort.
- **`evals/` artifact directory** — eval step return values are written as
  `evals/<assign>.json` alongside `downloads/`, `transforms/`, `requests/`.
- **`${evals.<name>.value.<field>}` runtime placeholder** — mirrors
  `${requests.<name>.body.<field>}`; resolves into any string field of later
  steps. Unknown names/paths render as empty string.
- **`artifact.eval` event type** — emitted in `events.ndjson` when an eval
  step captures a value.
- **`ArtifactRef.kind: "eval"`** — eval artifacts appear in `RunArtifacts.evals`,
  evidence files, `agent_context.md`, and `report.html` artifact links.
- **`evals` in `VerifierContext`** — script verifiers can access captured eval
  values via `ctx.evals` / `${evals.*}` fixture interpolation.

### Changed
- **`healSpec` skips eval steps** — returns `no-heal-possible` with a clear
  "eval steps are not healable — escape hatch" message instead of attempting
  locator-based repair.
- **`collectUnresolvedRuntimeRefs`** now scans for `${evals.<name>...}` refs
  in addition to `${artifacts.*}` and `${requests.*}` — outcomes depending on
  a never-produced eval value are reported as blocked, not failed.
- **`resolveFixtureMap`** resolves `${evals.*}` placeholders in script verifier
  fixtures.

## [1.15.0]

### Added
- **Per-run codemap auto-annotation (pass + fail)** — `cairn run --auto-annotate on-run`
  emits one codemap annotation per run with run context: `{ specName, contractHash,
  runId, status, outcomes, failedVerifier }`. The `contractHash` lets codemap
  consumers invalidate stale green badges when the spec's contract changes. This
  generalizes the existing `on-investigate` annotate seam from failure-only to
  bidirectional (pass + fail), closing the loop with future impact-driven spec
  selection. (CODEMAP-INTEGRATION.md item B.)
- **`annotate.autoAnnotate: on-run`** config mode — the enum now accepts
  `on-run | on-investigate | never` (previously `on-investigate | never`).
- **`--auto-annotate <mode>`** CLI flag on `cairn run` — overrides config
  `annotate.autoAnnotate`; accepts `on-run` or `never`.
- **`maybeAutoAnnotateRun`** exported from `annotate.ts` — wired into both
  `runSingle` and `runBatch` paths, best-effort (silently skipped if codemap
  isn't installed).

## [1.14.1]

### Fixed
- **tvault availability checks** in `doctor`, `secrets`, and the MCP server used
  `tvault version` (a non-existent subcommand). tvault expects `tvault --version`.
  The old call always failed, so tvault was misreported as unavailable even when
  installed.

## [1.14.0]

### Added
- **Services lifecycle block** — `cairn run` can now own the full multi-service
  environment lifecycle via the `services:` config block:
  - **Docker**: `docker compose up -d` with `reuseExisting` detection,
    `readinessCheck` command, and `healthcheck` (command + startPeriod + interval
    + timeout + retries).
  - **Conditional seed**: runs once, then skips if fresh (three-layer check:
    fingerprint + TTL + optional `freshnessCheck`). State tracked at
    `~/.cairntrace/services/<project>.seed.json`.
  - **tmux session management**: creates sessions from scratch with session-level
    `options`, `env` (via `tmux set-environment`), `defaultShell`, per-window `env`,
    `preCommands`, `readyOn` (URL or text), and per-window `healthcheck`.
  - **Teardown**: reverse order (tmux kill → docker down).
  - **fcheap session stash**: optionally stash session artifacts (tmux panes, docker
    logs, seed output) to fcheap via `services.stash`.
  - **tvault integration**: `secrets.provider: tvault` injects vault secrets into
    the seed command's env (first time `getTvaultEnv()` is called from the run path).
  - **`--no-services`** CLI flag to skip the entire lifecycle.
- **`cairn config validate`** command — validates `cairntrace.config.yml` structure
  (zod schema) and cross-field rules (unique window names, readyOn constraints, tvault
  provider requires tvault block). Supports `--config`, `--format json|yaml|md`.
- **`cairn_config_validate` MCP tool** — mirrors the CLI command.
- **`services` doc topic** — `cairn docs services` returns full documentation for the
  services lifecycle, healthchecks, and fcheap session stash.
- **HealthcheckSchema** — Docker-style healthcheck semantics for docker and tmux
  windows (command, startPeriod, interval, timeout, retries).
- **`docker.readinessCheck`** — shell command run after `docker compose up` completes.
- **SeedStateStore** — seed freshness tracking at
  `~/.cairntrace/services/<project>.seed.json`.
- **lefthook** pre-commit hooks (typecheck, lint, format:check, knip, tests).
- **knip** configuration for unused exports/deps detection.
- **Coverage enforcement** — 80% minimum threshold in vitest config.
- **Shared helpers exported from `webServer.ts`** — `runShell`, `probeOnce`, `sleep`,
  `spawnProcess` for reuse by `services.ts`.

### Fixed
- **`script` verifier no longer rejects numeric/boolean `fixtures` values with a misleading error.**
  `verify.script.fixtures` previously required string values (`z.record(string, string)`). Spec
  authors routinely supply numbers/booleans — most often through `${var}` interpolation (e.g. an
  expected row count of `0`, which YAML parses as a number). Because `ScriptVerifierSchema` is one
  member of the **strict** `VerifierSchema` `z.union`, a single non-string fixture value made the
  whole `script` member fail to parse, and Zod then surfaced the *sibling* members' rejection of
  the unmatched `script` key as:

  ```
  Unrecognized key(s) in object: 'script'
  ```

  i.e. a valid-looking spec read as *"the `script` verifier isn't supported."* This was easy to
  misdiagnose as a parser/schema "cold-init" defect (it appeared intermittent because it depended
  on whether a given spec's fixture values happened to be strings or numbers).

  `fixtures` now accepts `string | number | boolean` and stringifies each value, so verifiers still
  receive `Record<string, string>`. Objects/arrays are still rejected as genuine errors, and the
  `exactly one of run | file` rule is unchanged.

  - Authors no longer need to defensively quote numeric interpolations
    (`expectedRowCount: "${vars.count}"`); `expectedRowCount: ${vars.count}` works.

### Investigation note
- An earlier hypothesis blamed a TDZ / circular-import in `src/core/schema/*` causing union members
  to be dropped at construction. This was **refuted**: the schema dependency graph is an acyclic
  DAG, `VerifierSchema`/`StepSchema` build with all members, and the defect did not reproduce
  against source. The true cause was the strict-union error masking a fixture type mismatch (above).

### Tests
- Added `src/core/schema/verifier.v1.test.ts` covering string/number/boolean fixtures, object/array
  rejection, and the `run`/`file` exclusivity rule.

## [1.12.0]
- Video capture (`artifacts.capture.video`), fcheap stash integration, `investigate`/`audit`,
  codemap + TinyVault integration, doctor checks. (See release notes.)
