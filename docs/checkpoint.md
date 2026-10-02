# Checkpoints & login

Browser-state checkpoints let a spec resume an already-authenticated session instead of replaying a login every run. `cairn login` captures a session by hand; `cairn checkpoint` manages the saved checkpoints. Together they satisfy the cold-start contract's "captured checkpoint" path.

## Where checkpoints live

`~/.cairntrace/checkpoints/<name>.json` — cookies, local storage, and IndexedDB serialized by `CheckpointStore`. A spec references one by name:

```yaml
session: { resume: admin }
```

The runner loads the checkpoint into the backend before the first step, so the spec starts already signed in. The checkpoint is replay state, not a live session — re-capture when the app stops recognizing it.

### Scope: baseUrl, env, ttl

Captures also write `<name>.meta.json` next to the state: the `baseUrl` the state belongs to, the `env`, `createdAt`, the state file's `stateSha256` and, with `--ttl`, `ttl` and `expiresAt`. It never holds cookies or storage. The `baseUrl` is the environment's `baseUrl` with `--env`; without it, the origin of the page the session ended on (for `cairn login`, where the login finished, not the `--url` start page, which may be an identity provider on another domain). `--env` is the reliable scope.

MCP `cairn_checkpoint_capture` writes the same metadata (`capturedBy: "discovery"`): the discovery session's environment `baseUrl`, else the origin of the page it is on, the `env` when `cairn_discover_open` named one, and an optional `ttl` input. MCP `cairn_checkpoint_list` / `cairn_checkpoint_show` report the same `health`, `staleMeta` and scope fields as the CLI.

The metadata describes one exact state file. A tool that rewrites `<name>.json` without it (`agent-browser state save`, a precondition that mints a fresh state) leaves metadata whose `stateSha256` no longer matches: it is ignored, the checkpoint reads as `unscoped` and still resumes, and `checkpoint list --json` marks it `staleMeta: true`. Re-capture with `cairn login`, `capture-from-session` or `cairn_checkpoint_capture` to scope it again.

A run checks the checkpoint after the spec's preconditions (a precondition may create or refresh the state file it resumes) and before any browser work. It refuses a `session.resume` checkpoint that is missing, expired, or captured for another origin than the run's `baseUrl`: the run is `errored` with a failed `session.resume` step and `failure.phase: "session"`, and its next action points at `cairn checkpoint list --json`. `--mock` runs check it too, although the mock backend never loads the file. A checkpoint that fails to load (`loadState`) fails the same step instead of being ignored, so steps never run signed out. Checkpoints captured before this metadata existed have no scope (`unscoped`) and still resume. `cairn spec verify` reports a missing, expired or other-origin checkpoint as a warning finding (`checkpoint-missing`, `checkpoint-expired`, `checkpoint-base-url-mismatch`): checkpoints are host-local, so CI usually has none.

## `cairn login <name>`

The interactive capture path. Opens a headed browser at `--url`, lets you authenticate by hand, then saves the resulting state into a checkpoint.

```bash
cairn login admin --url https://app.com/login
cairn login admin --url https://app.com/login --wait-for text:Dashboard
cairn login admin --url https://app.com/login --wait-for url:/dashboard --timeout 120000
```

| Flag | Effect |
|---|---|
| `--url <url>` | page to load (required) |
| `--wait-for <signal>` | finish on `text:<...>` or `url:<...>` instead of waiting for ENTER |
| `--timeout <ms>` | max wait when `--wait-for` is set (default `300000`) |
| `--env <name>` | the environment the checkpoint is for; its `baseUrl` scopes the checkpoint (an unknown name exits 4) |
| `--config <path>` | explicit `cairntrace.config.yml` for `--env` |
| `--ttl <duration>` | lifetime (`30m`, `12h`, `7d`, `2w`); resume refuses the checkpoint afterwards |

Without `--wait-for`, the command prompts you to press ENTER once you have finished signing in. The browser uses a stable session name (`cairn-login-<name>`) so you can re-attach if cairn is killed mid-flow.

On success it prints the checkpoint path and the `session: { resume: <name> }` line to copy into your spec.

## `cairn checkpoint`

Manage saved checkpoints.

```bash
cairn checkpoint list --json          # every checkpoint with its health and scope
cairn checkpoint show admin           # inspect a checkpoint (JSON/YAML/MD)
cairn checkpoint delete admin         # remove a checkpoint
cairn checkpoint capture-from-session admin --session my-ab-session
```

### `capture-from-session`

Saves the state of an *existing* agent-browser session as a named checkpoint — the non-interactive capture path. Useful when you already have a logged-in agent-browser session and want to promote it to a resumable checkpoint without re-running a login.

```bash
cairn checkpoint capture-from-session admin --session my-ab-session
```

`--session <ab-session>` is required — it is the `agent-browser --session` value to read state from. `--env`, `--config` and `--ttl` scope it like `cairn login`; without `--env` the scope is the session's current origin.

`cairn checkpoint list --json` reports each checkpoint's `health` — `ok`, `expired` or `unscoped` — plus `env`, `baseUrl`, `createdAt`, `ttl` and `expiresAt` when recorded, and `staleMeta: true` when metadata exists but no longer matches the state file.

## Cold-start contract: which path to pick

Every spec must replay from a fresh browser session. Checkpoints are one of three ways to satisfy that:

1. **Login action** — `imports: [actions/login.yml]` + `steps: [{ use: login_admin }]`. Best when the login is reproducible and cheap.
2. **Captured checkpoint** — `session: { resume: <name> }` (captured with `cairn login` or `capture-from-session`). Best when login is slow, MFA-gated, or stateful.
3. **Preconditions** — `preconditions: { commands: [{ run: "..." }] }`. Best when the state is seedable via a script.

A spec that runs only because your dev session is logged in does not run. Always verify with `cairn run <spec> --cold-start` before committing.

## When a checkpoint goes stale

A checkpoint past its `--ttl`, or captured for another environment's origin, fails the run before its browser starts. One the app stopped recognizing earlier (rotated cookie, server-side expiry) still fails on the first step that needs the session. Re-capture:

```bash
cairn login admin --url https://app.com/login --wait-for text:Dashboard --env local --ttl 12h
```

Then re-run. If the app rotates sessions faster than you can re-capture, switch to a login action — the contract is "log in fresh each run," which is exactly what the cold-start contract wants.

## See also

- [Steps](/steps) — the `checkpoint` step (save state mid-flow) and `session: { resume }`
- [Troubleshooting](/troubleshooting) — "Spec did not satisfy the cold-start contract"
- [Authoring](/authoring) — the cold-start contract in detail