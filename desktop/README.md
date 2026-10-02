# Cairntrace Studio

The desktop console for [Cairntrace](../README.md): author, run, watch, and
forensically inspect behavioral browser specs without leaving one window.

Studio is a **thin console over the `cairn` CLI**. It owns no runner logic of
its own: every action spawns the same `cairn` binary an agent would use
(`--format json` on stdout, `--log-format json` on stderr), and every screen
renders artifacts the runner already wrote (`run.json`, `events.ndjson`,
`outcomes/*.md`, `screenshots/`, `report.html`). If the CLI's behaviour
changes, Studio follows automatically.

## What it does

| View          | Purpose                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Runs**      | The artifact-root history: every run, newest first, filterable by status/spec/text/labels (label keys and values discovered from `run.json`), a labels column, and optional grouping by invocation (each group links to its invocation). Rows are one Tab stop: arrow keys move, Enter opens the run. Only run-shaped directories count (the CLI's `RUN_DIR_PATTERN`); `_invocations/` and other folders are ignored. In-flight rows show liveness (heartbeat / pid / quiet / dead). Pinned runs carry a **pinned** tag (when and why in the tooltip) and an edge mark. A spec the environment policy refuses gets **no run directory**, so it never lists here (it shows in Live and Invocations) and there is no `refused` status filter; should a refused record ever be written, it gets its own violet, dashed style, never the failure red, with the refusal as its detail. |
| **Run detail**| One run's whole directory, **failure first**: a failed/errored run opens on a Failure panel (failing step id/kind/label + error, its screenshot, the `diagnostics/<step>.json` summary — url, title, visible buttons/links/inputs — outcome expected/actual from `outcomes/*.md`, the failed precondition output from `logs/` or the event tail, the failed hook output from the invocation journal, links to `services/*`). Hooks are read from the run's invocation journal (`_invocations/<id>/`), where the runner writes them: the run's own `--after` hooks and the `--before` hooks of its iteration, with their `logs/hook-*.log`. Tabs: Overview, Steps, Outcomes, Teardown, Preconditions, Gates, Fixtures, Hooks, Services, Video & trace, Logs (`run.log`, `logs/*`), Artifacts, Events, Console, Network, Compare (Teardown, Gates and Fixtures only when the run has them; see **Verification evidence** below for what they show, and for the expect / capture entries in Steps and the datasource tables and poll attempts in Outcomes). A per-spec history strip (last 20 statuses/durations) and refused/pin/stash/publish/retention/label badges sit under the title. A **refused** record (none is written today; forward compatible) would open on a refusal box (environment, reason, the spec's `requires`) instead of a failure panel. Overview has an **Evidence** panel: the stash (status, reason code and what it means, members left out with the `stash.include` hint, secret findings, TTL/expiry, tags, file count/size/content hash from `stash-receipt.json`), the published package (`publish-receipt.json`: artifact ref, expiry, size; a failed re-publish newer than the receipt shows as the failure, and a package past its `expiresAt` shows **publish expired** in warning tone with nothing to open; **Open in file.cheap** when the receipt has a stable https web URL, labelled with the host when it is not file.cheap) and retention (pinned or not). **Pin** / **Unpin** run `cairn pin <runDir> [--reason=…] --json` / `cairn unpin <runDir> --json` (the reason prompt is optional; restored stashes cannot be pinned). **Publish to file.cheap** asks in a native dialog (a sanitized private package, kept `retention.publish.retentionDays` days, default 7), runs `cairn publish <runDir> --json`, then shows the receipt or the `artifact.publish` failure reason. While the upload runs the button reads **Publishing…** and stays disabled (also across re-renders), and main refuses a second publish of the same run. The tabs are an ARIA tablist (Left/Right/Home/End); "back" returns to the view that opened the run (Runs, Live, or the invocation). |
| **Specs**     | List/read/edit specs; save runs `cairn spec verify` and shows its findings (including contract-hash refusals, exit 6); stamp hashes behind a confirm; run, run headed, cold-start run, and `cairn spec heal` (dry run or `--apply`); scaffold new specs. Discovery skips the artifact root, run-dir copies, `spec.resolved.yml` / `run.yaml`, and `runs/` / `exports/` / `playwright-export/` / `reports/` at the project root; deeper folders with those names are skipped only when they hold cairn output (run folders, `_invocations/`, `spec.resolved.yml`, `run.json`, `.cairn-export.json`), so an authored `flows/exports/` still lists, matching what `cairn run flows/` runs. Run, Run headed, Cold-start run and Heal disable while a configured suite lock exists (heal re-runs the spec). The spec list is a listbox: arrows move, Enter opens. Each spec shows its `requires` (environments with opt-in variables, mutates). A **run on** picker chooses the environment for Run / Run headed / Cold-start run / Heal (default: what the CLI resolves — Settings env, the spec's `environment:`, `defaultEnvironment`, `local`); when the environment policy would refuse the spec there, a warning says why and Run asks once. **⌘R** (Run Focused Spec) takes the same path: the picked environment, the warning, the unsaved-edits question. Save re-reads `requires` and its opt-ins from what it wrote, so the warning follows the file on disk. It never blocks: the CLI decides, and a refused run ends as `refused` (exit 7) — with no run directory, so its Live card offers no Open evidence. |
| **Live**      | Runs started from the app and runs started *outside* it (a terminal `cairn run`, an agent), grouped by invocation when the runner journals one ("spec 3/7", planned list, ETA from local p50 history, pid, origin: CLI / MCP agent + client / Studio, liveness, and a Details link to the Invocations view). Each card: a phase banner (`phase.changed`/`run.heartbeat`, e.g. `precondition quiesce · 4m 12s of 25m 0s`; while a readiness gate waits, `gate api-health (precondition) — GET …/health → 503 (want 2xx|3xx) · 12s of 2m 0s · attempt 6`; during teardown, `teardown 1/2 clear_order · run ./clear.sh`), gate rows next to the preconditions and hooks, fixture rows (each verb's status, `dry-run` on a shared environment with its reason, the non-secret outputs), `i/N kind label` step rows with the error inline (an expect step's verdict, `expected …; got …`, instead of the error; a `run` step's output tail), outcome "verifying…" rows with progress (a poll's `attempt 4/~31` leads) and, once settled, `polled · 7 attempts in 2.70s`, a Teardown section (item, status, `CAIRN_RUN_STATUS` it saw, error), the latest screenshot, output tabs for every announced log (`log.opened`, tailed incrementally), the event stream, and stash/retention badges. Incremental: pushes repaint only changed sections once per frame; panes follow the bottom and offer "jump to latest" when scrolled up. Finished runs keep tailing ~10s for late stash/retention events, and longer (up to 10 min) while the run's process is still alive, so a slow auto-stash upload still shows its badge. A stash saved with post-save failures or secret findings shows as a warning, not a green "stashed"; a failed stash names its reason code (`fcheap-missing`, `auth`, …), and the tooltip lists everything the event carried (left-out members, TTL, tags). A refused run (exit 7, `run.refused`, or a batch whose every spec was refused) shows a refusal box, not a failure, and no Open evidence (the CLI's `refused_…` run id names no directory); Re-run repeats the run's overrides (environment, headed, cold start). An invocation group whose every planned spec was refused, or that exited 7, reads `refused`, not `failed`. No layout jumps: the phase banner always holds one line (idle text between phases); when it is too narrow only the phase and item shorten, while the elapsed time against the budget and a "no heartbeat for …" warning stay visible (the full line is its tooltip, and a stale phase gets its own style); the elapsed clock has a fixed width, the screenshot sits in a fixed-ratio frame from the start, and log panes have a fixed height. |
| **Invocations** | One row per `cairn run` process (a terminal, an agent through MCP, or this app), newest first, finished ones included, read from `<artifactRoot>/_invocations/*/invocation.json`. The list (an ARIA listbox: arrows move, selection follows focus) shows status, origin, start time, elapsed, `done/planned`, and liveness (heartbeat → pid → mtime). The detail shows the current phase (`phase.changed` / `run.heartbeat` from the journal's `events.ndjson`, read with the offset reader), the invocation error or abort signal, the planned specs with their status (`passed`, `running`, `pending`, `not run`, `interrupted`) and **Open run** links into Run detail (a refused spec shows its refusal reason, and the result line counts refused specs). An invocation the environment policy refused entirely (every planned spec refused, or exit 7) reads **refused** in the list and the head, not a red `failed` (the runner journals `failed` for a refused single spec and `passed` for an all-refused batch); `done/planned` counts refused specs as settled. The journal summary has no refused count, so Studio derives it (`total − passed − failed − errored`) and, in the detail, also from the `run.refused` events, and tabs tailing `logs/narration.log`, `logs/services-*.log`, and `logs/hook-*.log` (auto-follow; a finished invocation loads each tab once, when shown). A **Gates & fixtures** list under the plan shows the journal's `gate.*` waits (services, web server: attempt, last answer, verdict) and suite / seed `fixture.*` verbs (skipped-as-fresh and dry-run reasons in the tooltip), and the banner names a waiting gate like Live does. **Stop** is described below. |
| **Stashes**   | file.cheap archives via `cairn stash list --format json` (tool `cairntrace` by default, tag filters), `cairn stash info`, and **Restore & open**: `cairn stash restore <id> --to <fresh temp dir>`, then the restored run opens in the normal Run detail / Compare. A stash whose run is still in the artifact root links back to it (its `stash-receipt.json`): secret findings, members left out, pinned, and the receipt's lines in Info; fcheap's own `custom.secrets_found` flag also shows as a warning. Every action shows its CLI line with a copy button. |
| **Sessions**  | Discovery and accompany sessions an agent (or `cairn discover`) runs, read from `<artifactRoot>/_sessions/*/session.json` — the config's `artifactRoot` (or `~/.cairntrace/runs`) where the CLI and MCP write journals, never Studio's artifact-root override — newest first: kind, origin (CLI / MCP agent + client), status, start URL, age, and liveness judged by main (`live`, `idle past TTL`, `process gone`, `stale`; from the pid, `lastActivityAt` and `ttlMs`). The detail tails the journal's `events.ndjson` with the offset reader: an action timeline (ok/error, URL changes, network mutations such as `PATCH /api/answers 204`, recorded / removed steps), a large preview of the latest screenshot with clickable thumbnails (Follow latest returns to the newest), the selected action's accessibility snapshot (`snapshots/NNN.txt`) and network log (`network/NNN.json`), both collapsible and loaded when opened, the recorded steps (`step.recorded` minus `step.removed`), the draft (`draft.spec.yml`) with a diff since the previous `draft.updated` (when Studio saw that version; otherwise the steps the latest one added), and the exports (`export.written`) with their verify findings; an export whose file moved since (promoted, renamed) reads **moved** and offers no Promote. **Export draft** re-exports a session the agent already exported: `cairn discover export --from-session=<journal> --intent=… --outcomes=<file> [--path=<its last export>] --json` with the intent and outcomes session.json kept from that export, passed explicitly so the dialog shows exactly what is written (Studio never invents a contract, so the first export stays the agent's `cairn_discover_export`; the button is disabled until then, and for accompany sessions). When it would rewrite an existing file, a native dialog names the file and shows the contract first. **Promote…** on an exported draft runs `cairn spec promote <draft> --expect-content-hash=<sha256> --json` after a native dialog that shows the intent and every outcome with its `verify:` parameters (compact YAML; a parameter longer than 400 characters is cut and marked). The dialog pins the draft's exact text: if the file changes while it is open, nothing is promoted and Studio says so. A refusal shows the CLI's message whole, and **Promote anyway (--force)…** (which asks again) appears only when the refusal is the missing or stale green `cairn spec finish`; the result lists the CLI's warnings (rebased paths, a forced promote). Only a CLI that does not know the command or flag (commander's own "unknown command/option" as its first line) reads as an older cairn. |
| **Catalog**   | `cairn catalog --json`: what the project already has, for people authoring specs. A search box ranks rows with `--query` (debounced; Enter runs it now) and an environment picker passes `--env`; tabs (an ARIA tablist) switch between actions (inputs, steps, uses, last green run, a copyable `use:` snippet with the required vars), vars grouped per environment (credential-looking values only ever read **masked**; a `${vars.…}` snippet), verifiers (fixture contract, uses with missing/unknown keys), environments (policy, services, secret key names), flows (drafts tagged, `requires`, actions, last run) and checkpoints (health, scope, problem). **Datasources**, **Gates** and **Fixtures** tabs come from the catalog payload when the CLI reports those kinds, else from the config summary main sends with the project (only when the config declares them; filtered by the search text; the environment picker resolves each environment's datasource overrides); they render even when `cairn catalog` fails, with copyable `verify:` / `preconditions.wait` / `fixtures:` snippets. Files reveal in Finder, flows open in Specs, runs open in Run detail. |
| **Cohorts**   | `cairn stats --group-by`: pass rate, duration p50/p95, harvested domain metric, and baseline deltas for A/B labels (a refused column would appear for a cohort with refused runs; `stats.v1` has no refused count today, so it stays hidden); the group-by field suggests the label keys found in `run.json`. |
| **Docs**      | The authoring reference read live from the binary: `cairn docs <topic>` plus the full `cairn explain` surface (commands, step kinds, verifiers, rules). |
| **Environment**| `cairn doctor` checks, the config cairn discovered for the open project, **environments & policy** (each environment's baseUrl, trait `owned`/`shared`/`protected`, mutations allow/deny, description, and — when the config declares services — its `services up` owner lock (held/stale, by whom, pid, since) from `cairn services status --env <name> --json` with **Services up** / **Services down** buttons that run `cairn services up|down --env <name> --json` after a native dialog naming the current lock owner; refused while a suite lock is held or a run/heal Studio started uses that environment — both checked again after the dialog — and one command per environment at a time. While one runs, Run and Heal on that environment are refused: `services up` writes its lock only after the boot, so a run started meanwhile would boot and later tear down its own copy; a run whose environment cannot be told before it starts (no `--env`, no spec `environment:`, no `defaultEnvironment`) counts as any), services, **datasources, gates & fixtures** (one row per environment × datasource with its kind, redacted target, details — database, mode, guard, namespace, auth kind, header names — and state `inherited` / `override` / `disabled` / `this env only`; the gates registry with probe, target, policy and who waits on it — services, the web server, specs whose `preconditions.wait` names it; the fixtures registry with kind, scope, verbs, ownership, output names and the live state per environment folded from `~/.cairntrace/fixtures/<project>.ledger.jsonl` the way `cairn fixtures status` folds it; the panel is left out when the config declares none of them), browser-state checkpoints (env, baseUrl, created, expiry with the TTL in its tooltip, health `ok` / `expired` / `unscoped` (captured before checkpoints recorded a scope; still resumable) / `missing` — read when `cairn checkpoint list --json` reports them, "—" until then), and retention/clean controls (the prune dialogs say pinned runs are kept, and name the uploads when `retention.archiveToStash` or `retention.publish.enabled` makes `cairn clean` archive or publish every run it prunes; main then confirms that upload in a native dialog, and Cancel prunes nothing). |
| **Settings**  | cairn binary override (a file not named `cairn…` is confirmed in a native dialog), artifact-root override (never `/`, your home folder, or a parent of it; a folder typed by hand rather than picked with Browse… is confirmed), default run options (backend, env, headed, cold-start, monitor, parallel, labels, vars), **launch safety** per project (launch template + suite lock files), **interface** (density, screenshot max width, live tail poll, refresh Runs on finish), recent projects. |

The topbar shows the resolved `cairn --version` and warns (⚠) when the `cairn`
on PATH and this checkout's `bin/cairn` report different versions.

### Event vocabulary and liveness

`lib/events.js` is the one describer + reducer for `events.ndjson` (run dirs
and invocation journals), shared by the main process and the renderer. It
speaks the runner's vocabulary — `step.failed`, `step.finished{skipped}`,
`outcome.passed|failed|skipped`, `run.passed|failed|errored`, `precondition.*`,
`services.*`, `artifact.*` — plus the additive v1 contract (`phase.changed`,
`run.heartbeat`, `outcome.started|progress`, `log.opened`, `hook.*`,
`invocation.*`). Everything new is optional: older run directories render
exactly as before. Unknown types render as `type · key=value …`, never as a
bare label. `test/events.test.js` runs every line of the runner's goldens
(`src/core/schema/__fixtures__/events/`) through it.

A run without `run.json` is classified by, in order: a `run.heartbeat`
younger than 45s (running); the owning pid from the heartbeat or the
invocation journal, checked with `kill(pid, 0)` (alive → running/quiet,
gone → dead); and only when neither exists, the old mtime windows (5 min
running, 30 min detected).

### Launch safety

Per project (Settings → launch safety):

- **Launch template** — e.g. `task run FLOW={spec} ENV={env} -- {cairnArgs}`.
  When set, every Run button spawns it instead of `cairn run`. The template is
  tokenized (quotes supported) and run **without a shell**; shell operators are
  rejected. Placeholders: `{spec}` (project-relative path), `{specs}` (one
  argument per spec standalone, space-joined when embedded as in
  `FLOWS={specs}`), `{specName}`, `{env}`, `{cairnArgs}` (Studio's `cairn run`
  flags minus the specs, and minus `--env` when `{env}` is used),
  `{projectDir}`. Studio still tails the artifact root, so Live works the
  same. Saving a new or changed template asks for confirmation in a native
  dialog, because the template replaces `cairn run` for every Run.
- **Suite lock files** — paths (files or directories) relative to the project.
  While any exists, the main process refuses every run and heal Studio would
  start (there is no override), the Specs view disables those buttons, the other
  entry points (Live and Run detail Re-run, ⌘R) show the refusal with the lock
  owner, and the topbar shows "suite in progress" with the owner (a JSON/plain
  lock file's content, or `owner`/`owner.json`/`owner.txt`/`info`/`pid` inside
  a lock directory). Removing a lock file from the list, or resetting Studio's
  settings, while that lock is held asks for confirmation in a native dialog.

Unset, Studio spawns `cairn run` directly, exactly as before.

### Evidence and environment policy

Studio implements the wave-2b contract without owning any of it: every
action is a `cairn` command, every state comes from what the CLI wrote, and
every field is optional (an older run renders exactly as before).

- **Stash** (`artifact.stash` events, `stash-receipt.json`): status
  `saved` / `saved_with_failures` / `error`, the error `reason` code
  (`fcheap-missing`, `save-failed`, `auth`, `too-large`, `timeout`,
  `secrets-blocked`, `unknown`) with a plain-language meaning, `excluded`
  members, `secretsFound`, `ttl` / `expiresAt`, `tags`, and the receipt's
  `contentHash` / `fileCount` / `sizeBytes`. One describer
  (`lib/events.js` `stashLines` / `stashBadge`) feeds the badge tooltips,
  the Evidence panel, and the Stashes view.
- **Publish** (`publish-receipt.json`, `artifact.publish`): `run:publish`
  confirms in a native dialog the renderer cannot answer, spawns `cairn
  publish <runDir> --json`, and returns the receipt or the failure reason.
  **Open in file.cheap** goes through `run:open-published`: main reads the
  web URL from the run's own receipt and opens it only under the CLI's own
  receipt rule (`isStableHttpsUrl`: https, a host, no credentials, no query
  string or fragment — `lib/evidence.js` `safeWebUrl`); the renderer never
  supplies the URL. One publish per run at a time (`run:publish` refuses a
  second while one is in flight). An `artifact.stash` / `artifact.publish`
  event carrying another run's `runId` (the retention pass recording the
  runs it pruned) never counts as this run's stash or publication. A
  receipt's `runIndexSkipped` (`unsupported` / `too-large` /
  `build-failed`) reads "not listed in the console" with its meaning.
- **Sensitivity** (`artifact-manifest.json` `sensitivity`: `redacted`,
  `safe`, `sanitized`, `secret-bearing`; `artifact.trace` events): the
  Evidence panel's "what leaves the machine" block counts the files by
  label and names the ones a publication never sends (sanitized traces,
  secret-bearing files); the Video & trace tab and the file list tag them,
  with the meaning in the tooltip (`lib/events.js` `SENSITIVITY` /
  `sensitivitySummary`). `artifact.trace` events read as trace saved
  (format, sensitivity), dropped (over `artifacts.capture.traceMaxBytes`)
  or failed (reason).
- **Pin** (`run.json` `pinned: {at, reason?}`): `run:pin` / `run:unpin`
  accept only finished runs inside the artifact root, and pass the reason as
  one argv entry joined to its flag (`--reason=…`, control characters
  removed, at most 200 characters).
- **Refused** (status `refused`, exit 7, `run.refused`, `refusal: {reason,
  env, requires, code?}`): its own tone (`refused`, violet and dashed) in
  every status dot, tag, history cell and log line; never a failure panel. A
  refused spec gets no run directory: an app run shows it from the exit code
  and the JSON document's `refusal` (never adopting its synthetic
  `refused_…` runId, which names nothing on disk — nor any document with
  `synthetic: true`, which also marks a spec that errored before its run
  started, and no "Open run" for a journal run entry marked `synthetic`),
  and an invocation from
  the journal's summary and its `run.refused` event (matched to its
  planned spec by index, else path), which settles that plan entry without
  ending the journal's live phase.
  Runs, Run detail, the history strip and Cohorts style a refused record
  should one ever be written (forward compatible).
- **Environment policy** (`environments.<name>.policy`, spec `requires`):
  `lib/policy.js` mirrors the CLI's rules — refuse when `requires.env` is
  present and the environment is not listed (or only behind opt-in variables
  that are not `1`/`true`), when `requires.mutates` meets `mutations:
  deny`, or when a `protected` environment is not listed. The Specs view only
  warns. Opt-in variables are answered by main with booleans
  (`spec:read` / `spec:write` `optIns`); their values never reach the
  renderer. Like the CLI, `1` / `true` match in any case; main reads the
  spawn environment, then the project's dotenv files the way Bun loads them
  for cairn (`.env.local` over `.env.<NODE_ENV|development>` over `.env`;
  no `.env.local` when NODE_ENV is `test`). A launch template's own
  environment is not visible to it.

### Verification evidence: datasources, polls, gates, teardown, fixtures

Studio renders the wave-4 contract from what the runner wrote; every field
is optional, and a run without them renders exactly as before.

- **Datasource / value / http / table / network evidence**
  (`outcomes/<id>.raw.json` `{kind, source?, request, observed, attempts?,
  polledMs?}`): main normalizes it (`lib/dataEvidence.js`) into the source
  the verifier read — by its descriptor (`mongo app_db · compose service
  mongo · db shop · read-only`, a Temporal namespace and API, an http
  baseUrl), never a connection string —, key facts (count, status, bytes,
  candidates / matching), the observed rows as a table (Mongo documents,
  Temporal executions or a described workflow's activities, an http or value
  array, the table verifier's grid, matching requests) or the observed value,
  and the request. The runner bounds observations (≤20 rows, ≤4KB per row, a
  `truncated` flag): the table says `showing 20 of 57 documents`, or that
  rows were cut, and how many fields past the 12-column cap are left to the
  raw sidecar, which stays one click away. Studio itself lists at most 50
  rows; a longer file (a captured table, a hand-made one) says
  `showing the first 50 of 100 rows (Studio lists at most 50 …)` instead of
  blaming the runner. Cells and previews mask secret-looking keys at any
  depth (`password`, `apiToken`, `Set-Cookie`), but not keys that only
  describe one (`tokenCount`, `cookieConsent`, `accessTokenExpiresAt`).
- **Poll attempts**: `attempts: [{at, ok, summary}]` as a timeline (verdict,
  offset from the first attempt, summary). The runner keeps the first 5 and
  the last 15; with the count from `outcome.passed|failed` `attempts` (or an
  SDK poll's `attemptCount`), the gap is marked where attempts were dropped
  and later attempts keep their real numbers. The outcome summary reads
  `35 attempts · 34.0s`; without an attempt log, the outcome's `outcome.progress`
  lines are the timeline.
- **Expect / capture steps**: `expects/NNN_<id>.json` (and `expect.passed|failed`
  when the file is missing) under the step in Steps — status, assertions,
  expected / actual, attempts, the observed value — and together under
  **Step expectations** in Outcomes; a failed expect opens the Failure panel.
  `captures/<assign>.json` shows under its step as `${captures.<assign>}`
  with the value (a table when it is one); a capture whose name looks like a
  credential (`apiToken`, `csrfToken`) shows `••••••`, since the runner
  writes captured page text as is. A runner whose `step.started`
  says kind `step` for an expect step still reads as `expect`.
- **Run steps**: kind and label (`run ./seed.sh → seeded`) in Steps and
  Live; a failed run step's error keeps its output tail's lines.
- **Gates** (`gate.started|attempt|passed|failed`): the Gates tab (scope,
  verdict — ready / not ready / timed out / cancelled, or cut off when the run
  ended mid-wait —, attempts, budget, every / stable, the coalesced attempt
  log), the phase banner while one waits, and a Failure panel for the
  `preconditions.wait` gate that errored the run (`wait <gate>`).
- **Teardown** (`teardown.started|finished`, or run.json `teardown` when the
  runner records it): the Teardown tab and Live section (item, kind and label,
  status, duration, the `CAIRN_RUN_STATUS` it saw, the signal it ran on,
  error); a **teardown N failed** badge, because a failed teardown keeps the
  verdict unless the spec sets `failRun: true` (then the Failure panel says so).
- **Fixtures** (`fixture.ensure|reset|verify|teardown`, `<runDir>/fixtures.json`):
  the Fixtures tab (adapter, scope, each verb's status with its reason —
  `fresh: ensured …`, `shared environment` —, ensured at, teardown, outputs),
  a **fixtures dry-run** badge when a shared environment turned mutating verbs
  into dry-runs, and the project ledger's live state in Environment, folded
  like `cairn fixtures status` (per instance for a run-scoped fixture; a
  reset-only fixture is live after an ok reset; a released adopted fixture
  reads `released`).
  Outputs are the non-secret values the runner exposes as
  `${fixtures.<name>.<key>}`; Studio masks any whose key or value still looks
  like a credential (a password/token/secret key, URI userinfo, `Basic` /
  `Bearer` values, a JWT), in the reducer and in main.
- **Config registries**: main summarizes `datasources:` (with
  `environments.<n>.datasources` merged the way the runner merges them: a
  partial entry over the top-level one, `false` disables it, a URI override
  drops an inherited docker transport), `gates:` and `fixtures:` from the
  config parsed **without** `${env.X}` substitution: references stay
  references (`${secrets.STAGING_MONGO_URI}`) with any `:-default`
  redacted like a literal (`${env.MONGO_URI:-mongodb://***@localhost/app}`,
  `${secrets.X:-••••••}`), literal connection strings are masked
  (`mongodb://***@db1:27017/reports?…`), credentials are named only by kind
  (`basic`, `bearer · ${secrets.API_TOKEN}`), header values and fixture
  commands / documents stay out, and gate command lines lose the credential
  shapes Studio knows: URI and `user:pass@host` userinfo, `--password=x` /
  `--password x` (any `--*password*` / `--*token*` / `--*secret*` /
  `--*api-key*` flag), `-p x` / `-px` when `-p` is a password (the
  segment has `-u` / `--username`, or runs mongosh, mysql, sshpass, …;
  never a port-shaped value), redis-cli `-a x`, `-u` / `--user user:pass`,
  `Authorization:` / `Cookie:` / `X-Api-Key:`-style headers, quoted JSON
  credential keys and `*PASSWORD=x` assignments. The scrub is pattern-based:
  a credential passed as a bare positional argument still shows.
  `project:inspect` no longer sends the parsed config document (`raw`) to
  the renderer at all, since its env-substituted values may be credentials,
  and each environment's env-substituted `baseUrl` goes out redacted.

### Authoring: sessions, drafts, catalog

Studio follows an agent while it authors a spec, without owning any of it:

- **Session journals** (`<artifactRoot>/_sessions/<sessionId>/` under the
  config's `artifactRoot` or `~/.cairntrace/runs`, where the CLI and MCP
  write them — Studio's artifact-root override only moves `cairn run`
  output; never a run-shaped folder): `session.json` (identity, start URL as requested,
  status `open` / `expired` / `closed` / `exported`, `lastActivityAt`,
  `ttlMs`, `setup`, `exportedTo`), `events.ndjson` (`session.opened`,
  `action.performed`, `step.recorded`, `step.removed`, `snapshot.captured`,
  `draft.updated`, `export.written`, `session.closed`), `screenshots/NNN.png`,
  `snapshots/NNN.txt`, `network/NNN.json` and `draft.spec.yml`. The CLI
  redacts them; Studio only reads them (screenshots stream as
  `cairn-artifact://` tokens). Liveness: an `open` journal whose pid is gone
  reads **process gone**, one idle past its TTL **idle past TTL**; every other
  status is ended. Retention keeps the newest 50 sessions and any a draft
  references, so an older journal can disappear while it is shown.
- **Drafts** live in the config's `authoring.draftsDir` (default
  `flows/_drafts`); folders and files starting with `_` are skipped by
  `cairn run <dir>`, and the Specs view never lists a journal's own
  `draft.spec.yml` (`_sessions/` is skipped). **Promote…** applies the
  CLI's draft rule first (inside `authoring.draftsDir`, or a `_` file or
  folder below the config dir), then asks in a native dialog the renderer
  cannot answer, showing the draft's intent and every outcome with its id,
  description and `verify:` parameters, because the stamp locks that
  contract. The dialog's text is pinned by its sha256 and the draft is read
  again after the click: a draft the agent rewrote meanwhile is refused, not
  promoted unseen. Then `cairn spec promote <draft> --json` moves it out of
  the drafts folder and stamps it, and the result offers **Open in Specs**.
  Studio passes the shown text's hash as `--expect-content-hash`, so the
  CLI refuses (exit 4) any other content on its own read too, even with
  `--force`.
- **Export draft** never names a contract of its own: the first export of a
  session comes from the agent, which writes `intent` / `outcomes` into
  session.json; Studio re-exports with exactly those (through a temporary
  outcomes file it removes afterwards).
- **Catalog** and **services** are plain `cairn catalog` / `cairn services`
  calls; renderer-typed values (the query, an environment name) travel as one
  argv entry joined to their flag (`--query=…`, `--env=…`), and an
  environment name must look like one.

### Stopping an invocation

The Invocations view offers **Stop** only while a journal says `running` and
its process is alive; a finished invocation never shows it. Stop sends
**SIGINT**, which cairn handles like a terminal interrupt: the current spec
stops, cleanup runs, and the journal turns `aborted`. The renderer only asks;
the main process (`invocation:stop`) decides, and refuses unless all of these
hold:

- the journal's status is `running`, its pid is alive, and it has a
  `startedAt` (the runner always writes one);
- the pid matches the pid encoded in the invocation id, and is neither 1 nor
  Studio itself;
- `ps -o pgid=,etime=,command= -p <pid>` (no shell) shows a cairn process:
  the executable is `cairn` (`…/bin/cairn` or the compiled binary), or an
  interpreter (bun, node, a shell) whose script is, after the interpreter's
  own flags. A path with spaces is accepted when it names an existing file;
- its subcommand is `run` or `mcp` (the only ones that write journals) and
  agrees with the journal's `origin` (`cli` → `cairn run`, `mcp` →
  `cairn mcp`);
- that process started no later than the journal did (a pid the OS reused
  for a newer process fails this).

**What the signal reaches.** When cairn leads its own process group (a job
started from an interactive terminal, or a run Studio launched), Studio
signals that whole group, exactly as Ctrl-C in its terminal does, so a
running `--before` / `--after` hook stops with it. Otherwise the group belongs
to whatever launched cairn (an agent host, a non-interactive shell), and only
the cairn pid gets SIGINT: cairn still stops and cleans up, but the
subprocesses of a running compound hook (`sleep 60; echo done`) can outlive
it. The confirmation dialog says which of the two applies.

Then it asks in a native dialog the renderer cannot answer, runs every check
again (the process may have ended, or the journal finished, while the dialog
was open), and only then signals. There is no SIGKILL escalation: if cairn
does not exit, stop it from its terminal. A process whose command line is
`cairn mcp` (or whose journal says origin `mcp`) is an agent's MCP server;
the dialog says so, because SIGINT stops that whole server (every run it
drives, and the agent's cairn tools until it restarts).

### Keyboard and accessibility

Every list is one Tab stop with arrow-key navigation: the sidebar (Up/Down,
Home/End; the current view carries `aria-current`), the Runs table and the
spec list (Enter/Space open), the invocation and session lists (selection
follows focus; Enter moves into the detail), and every tab strip (Run detail,
output panes, Catalog kinds, the session draft: Left/Right). Keyboard focus shows an accent ring (`:focus-visible`); icon-only
buttons (filter chips, tree toggles, history cells, jump-to-latest) carry
`aria-label`s; log panes are focusable `role="log"` regions that stay quiet
for screen readers. Every relative time ("3m ago", absolute time on hover)
is a `time.rel-time` refreshed by one 15s clock, so the same moment reads the
same in every view. Empty states say what to do next: no cairn binary or no
project (a notice with Set cairn binary… / Open project…), no runs, no
matching runs (Clear filters), no specs (New spec…), nothing running, no
invocations, no sessions, no stashes, nothing in a catalog tab (Clear search).


### Artifact root resolution

Same order as the CLI: Settings override → config `artifactRoot` →
`~/.cairntrace/runs`. The CLI keeps a relative config `artifactRoot` as-is and
resolves it against its working directory (not the config file's directory);
Studio spawns every `cairn` with the open project as cwd, so a relative value
resolves against the project directory. The config is read like the CLI
loader reads it: `${env.X}` / `${env.X:-default}` substitution, YAML merge
keys, and `${config.dir}` (the config file's directory), so
`artifactRoot: ${config.dir}/runs` lands where cairn writes.

## Run it

```bash
bun run desktop:install   # once: installs electron + electron-builder under desktop/
bun run desktop:start     # launch the app
bun run desktop:smoke     # headless boot harness: boots a hidden window, waits for
                          # the renderer to report ready, prints one JSON line, exits
```

`desktop:smoke` is the gate before shipping: it proves the window, the
context-isolated preload bridge, the IPC surface, and every view script parse
and mount (it fails if any view is missing, which is how a script with a syntax
error gets caught).

## Gates

```bash
bun run desktop:test       # node:test over desktop/lib, the argv/spawn contracts,
                           # ipc.js with a stubbed electron (test/ipc.test.js; its
                           # authoring contract test drives the repo's own
                           # bin/cairn: export a fabricated journal, then promote,
                           # skipped without bun), and the renderer mounted in
                           # happy-dom (test/*.dom.test.js)
bun run desktop:typecheck  # tsc --checkJs: main process (tsconfig.json), then the
                           # renderer (tsconfig.renderer.json)
bun run lint               # repo-wide oxlint, includes desktop/
bun run format:check       # repo-wide oxfmt, includes desktop/
```

CI runs `desktop:test` + `desktop:typecheck` (see `.github/workflows/ci.yml`);
the smoke harness needs a display and the Electron binary, so it stays a local
gate. To boot it without touching your own Studio settings, point it at a
scratch user-data folder (its `settings.json` can name a project):

```bash
cd desktop && ./node_modules/.bin/electron . --smoke --user-data-dir=/tmp/studio-smoke
```

**Typecheck scope.** `tsconfig.json` covers `main.js`, `preload.js`,
`ipc.js`, `windows.js`, `lib/**`, and the node-only tests. The renderer has
its own program, `tsconfig.renderer.json`: every `renderer/**/*.js` file with
`checkJs`, the DOM lib, and **no** Node types (a renderer script that reaches
for `require` or `process` fails to typecheck). `renderer/globals.d.ts`
declares the shared globals: `window.Studio`, `window.cairn` (the preload
bridge), and `CairnFormat` / `CairnEvents` / `CairnPolicy` (typed from
`lib/format.js` / `lib/events.js` / `lib/policy.js`). `Studio` has no index signature: every member the
renderer shares across files (dom.js, state.js, components.js, panes.js,
markdown.js) is declared, so a misspelt member or a wrong argument fails,
and dom.js / state.js / components.js publish their members through a
`Partial<StudioGlobal>`-typed object, so an implementation that drifts from
its declaration fails too. Only `Studio.live`, `Studio.invocationsView`,
`Studio.sessionsView` and `Studio.catalogView` (view helpers exported for
tests) are `any`. Both programs run with
`strict: false`, so null checks are not enforced; the DOM tests cover what
that leaves out. The tests that load renderer scripts into a DOM
(`dom.test.js`, `state.test.js`, `*.dom.test.js`, `dom-env.js`) are in
neither program, so they are not typechecked.

**DOM tests.** `test/dom-env.js` installs happy-dom, loads the renderer
scripts in `index.html` order, and stubs `window.cairn` with handlers that
call the same `lib/` readers ipc.js uses (`listRuns`, `readRunDetail`,
`listInvocations`, the offset readers) over temp artifact roots built from
the runner's goldens and `test/fixtures/`. `views.dom.test.js` mounts Runs,
Run detail (failed run: failure panel, hooks tab), Live (phase banner, step
rows, log tails), Invocations, Specs, Stashes, Cohorts, and Settings;
`app.dom.test.js` boots the whole shell as a first run (no cairn, no project);
`authoring.dom.test.js` mounts Sessions over a real journal (timeline,
screenshots, snapshot, steps, the draft diff as new events arrive, export
and promote flows), Catalog over a `cairn catalog --json` payload, and the
Environment view's services up/down controls;
`evidence.dom.test.js` covers the wave-2b contract (pinned/refused rows,
the Evidence panel, publish and pin flows, refused Live cards and plan
entries, environment policies, checkpoint scope, the Specs policy warning,
stash receipts, refused cohorts; the tests built on a refused run
directory are labelled forward compatible, since the CLI writes none, next
to tests on the real exit-7 payload and refused journal) with events built
inline, because every
`.ndjson` fixture must validate against the runner's strict events.v1;
`verification.dom.test.js` covers wave 4 (Run detail over a run directory
with datasource evidence, expects, captures, a fixture ledger, gate /
teardown / fixture events: the Failure, Outcomes, Steps, Gates, Teardown
and Fixtures tabs; a Live card through a gate wait, an expect failure, a
polled outcome and teardown; the Invocations gates & fixtures list;
Environment and Catalog over the config registries), and every one of
those tests plants a credential that must never reach the structured views
(`verification.test.js` does the same for lib/, and
`fixtures/events-gates-teardown.ndjson` is a strict events.v1 stream with
gates, an expect step, a polled outcome, fixtures and teardown).
Compare DOM nodes by identity (`assert.ok(a === b)`): on failure,
`assert.equal` inspects both values, and inspecting a happy-dom node walks
the document synchronously and hangs the test process.


## Architecture

```
desktop/
  main.js        window lifecycle, menu, single-instance lock, --smoke harness
  preload.js     contextBridge allowlist (invoke channels + push channels)
  ipc.js         every ipcMain.handle; validates every renderer argument
  windows.js     secondary report.html windows
  lib/           pure, testable core — no Electron imports
    cli.js       binary discovery, argv builders, NDJSON decoding, spawn+kill
    runs.js      artifact-root indexing, run detail, bounded artifact reads
    specs.js     config discovery, spec discovery, YAML summaries
    live.js      run-directory discovery + events.ndjson tailing (lingers
                 ~10s after run.json for late stash/retention events)
    watcher.js   polls the artifact root for runs started outside the app,
                 tails their events.ndjson (and invocation journals), reports
                 liveness, and keeps draining a finished run while its
                 process lives (bounded)
    events.js    the event describer + run-model reducer (also a renderer script)
    invocations.js  _invocations/<id>/invocation.json journals (origin, client,
                 logs), liveness, ETA, and the Stop (SIGINT) safety checks
    launch.js    launch templates (no shell) + suite lock detection
    stash.js     `cairn stash` argv, stash-id validation, restored-run lookup
    evidence.js  `cairn publish` / `pin` / `unpin` argv, publish receipts,
                 https-only web URLs, run.json `pinned`
    dataEvidence.js  outcome raw evidence → tables / attempts, expects/,
                 captures/, fixtures.json, the project fixture ledger fold
    registries.js  config datasources (per environment) / gates / fixtures,
                 redacted, from the unsubstituted config
    authoring.js session journals (`_sessions/<id>/`: listing, liveness, the
                 files a renderer may read), `discover export` / `spec
                 promote` / `catalog` / `services up|down|status` argv,
                 draft resolution, the promote and services dialog texts
    policy.js    environment policy: requires/policy normalizing, the refusal
                 rules, refusal text (also a renderer script)
    media.js     the cairn-artifact:// protocol (opaque tokens, byte ranges)
    settings.js  the settings store (userData/settings.json)
    format.js    shared formatters (also loaded by the renderer as a script)
  renderer/      classic <script> files, no bundler, no innerHTML anywhere
    globals.d.ts window.Studio / window.cairn / CairnFormat / CairnEvents /
                 CairnPolicy types
    panes.js     follow panes, output tab strips, offset-reader log tails
                 (shared by Live and Invocations)
    views/       one script per view (runs, run-detail, specs, catalog, live,
                 invocations, sessions, stashes, stats, docs, environment,
                 settings)
  test/          node:test suites over lib/ (temp-fixture artifact roots) and
                 the renderer in happy-dom (dom-env.js, *.dom.test.js)
```

Design rules that keep it honest:

- **Sandboxed renderer.** `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`. The preload exposes channel allowlists only.
  External opens are restricted to `http(s)`; "Open in file.cheap" opens
  only the https URL main reads from the run's `publish-receipt.json`, and
  publishing (an upload) is confirmed in a native dialog first.
- **No renderer argument is trusted.** A project directory the renderer names
  must be the active project, a recent one (added only through the native
  Open dialog), or Studio's default; anything else is refused. Reads stay
  inside that project, the resolved artifact root, stash restores this session
  created, and files the user explicitly picked (open dialog, files handed to
  the app, the YAML spec a run record names). An absolute run reference must
  be a run folder inside the artifact root or a restore; a renderer-supplied
  artifact path must resolve inside its run directory (`lib/runs.js
  safeJoin`); spec writes are `.yml`/`.yaml` files inside the project;
  `fs:reveal`/`fs:exists` refuse anything else. A session journal is named by
  its id (or its exact `<artifactRoot>/_sessions/<id>` folder under the
  config's root) and only its own text/image files are read; `spec:promote`
  takes an existing `.yml`/`.yaml` draft inside the project that passes the
  CLI's draft rule. These are path checks, not symlink resolution: a
  symlink inside the project is followed. The project config reaches the
  renderer without its parsed document (env-substituted values may be
  credentials); its datasources / gates / fixtures are summarized from the
  unsubstituted text, redacted. `fixtures:ledger` takes only the project:
  the file is `<project>.ledger.jsonl` in the CLI's ledger folder for the
  config's `project:` (default `cairntrace`), refused unless that is a plain
  name, and its outputs come back masked.
  `settings:update` only takes validated run/ui defaults (a value starting
  with `-` is refused, so it cannot smuggle a flag into `cairn run`); the
  cairn binary, artifact root and launch template go through their own
  handlers and native confirmations.
- **Not a sandbox against command execution.** Specs can declare
  `preconditions.commands` and the project config can declare services, and
  Run executes them by design. A compromised renderer that edits a spec in the
  open project and runs it can run commands as you, as you can yourself. The
  boundary keeps it from reading or writing outside those roots, and from
  re-pointing Studio at another binary, folder or launcher, or lifting a held
  suite lock, without your confirmation in a native dialog.
- **Media by token, never by path.** Videos stream through
  `cairn-artifact://media/<token>` (registered in `main.js`, range requests
  for seeking); main issues a token only after validating the run directory
  and relative path, and the handler serves nothing else. Binary artifacts
  (video, traces, zips, anything with NUL bytes) are never decoded as text:
  Playwright trace zips open with `bunx playwright show-trace` (or are
  revealed in Finder), agent-browser Chrome-trace JSON gets a Perfetto hint.
- **Spawned children die with their tree.** `lib/cli.js execCairn` runs each
  cairn in its own process group and escalates SIGTERM → SIGKILL on deadline or
  cancel, because cairn spawns browsers/docker/tmux whose inherited pipes would
  otherwise keep a "cancelled" run alive.
- **macOS GUI PATH.** Finder-launched apps get a near-empty PATH, so
  `augmentedEnv()` adds `/opt/homebrew/bin`, `/usr/local/bin`, `~/.bun/bin`,
  `~/.local/bin`, `~/.volta/bin`, and friends before resolving `cairn`.
- **No bundled copy of the truth.** Docs, vocabulary, verify results, stats,
  and diffs all come from the CLI at call time (cached briefly in the main
  process), so the app can never disagree with the installed cairn.

## Packaging

```bash
bun run desktop:dist      # unpacked mac app under desktop/dist/
bun run desktop:dist:dmg  # zip target (unsigned; identity: null)
```

The packaged app resolves `cairn` from PATH or the Settings override; in a
source checkout it also falls back to `<repo>/bin/cairn`.

## Brand assets

`build/icon.svg` is the app-icon rendition of the product mark — the same
cairn geometry as `docs/public/favicon.svg`, scaled ×16 onto the deep-green
tile. `build/icon.icns` / `build/icon.png` are generated from it (Electron
`capturePage` at 1024px → `sips` resize into an iconset → `iconutil -c icns`);
electron-builder picks them up from `buildResources`. The renderer topbar
inlines the mark as SVG and keeps the wordmark as text so it stays crisp at
any zoom. The UI accent is the brand emerald (`#34D399`), so selection, focus,
and primary actions read as the same product as the docs site.
