# Checkpoints & login

Browser-state checkpoints let a spec resume an already-authenticated session instead of replaying a login every run. `cairn login` captures a session by hand; `cairn checkpoint` manages the saved checkpoints. Together they satisfy the cold-start contract's "captured checkpoint" path.

## Where checkpoints live

`~/.cairntrace/checkpoints/<name>.json` — cookies, local storage, and IndexedDB serialized by `CheckpointStore`. A spec references one by name:

```yaml
session: { resume: admin }
```

The runner loads the checkpoint into the backend before the first step, so the spec starts already signed in. The checkpoint is replay state, not a live session — re-capture when the app stops recognizing it.

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

Without `--wait-for`, the command prompts you to press ENTER once you have finished signing in. The browser uses a stable session name (`cairn-login-<name>`) so you can re-attach if cairn is killed mid-flow.

On success it prints the checkpoint path and the `session: { resume: <name> }` line to copy into your spec.

## `cairn checkpoint`

Manage saved checkpoints.

```bash
cairn checkpoint list                 # list all saved checkpoints
cairn checkpoint show admin           # inspect a checkpoint (JSON/YAML/MD)
cairn checkpoint delete admin         # remove a checkpoint
cairn checkpoint capture-from-session admin --session my-ab-session
```

### `capture-from-session`

Saves the state of an *existing* agent-browser session as a named checkpoint — the non-interactive capture path. Useful when you already have a logged-in agent-browser session and want to promote it to a resumable checkpoint without re-running a login.

```bash
cairn checkpoint capture-from-session admin --session my-ab-session
```

`--session <ab-session>` is required — it is the `agent-browser --session` value to read state from.

## Cold-start contract: which path to pick

Every spec must replay from a fresh browser session. Checkpoints are one of three ways to satisfy that:

1. **Login action** — `imports: [actions/login.yml]` + `steps: [{ use: login_admin }]`. Best when the login is reproducible and cheap.
2. **Captured checkpoint** — `session: { resume: <name> }` (captured with `cairn login` or `capture-from-session`). Best when login is slow, MFA-gated, or stateful.
3. **Preconditions** — `preconditions: { commands: [{ run: "..." }] }`. Best when the state is seedable via a script.

A spec that runs only because your dev session is logged in does not run. Always verify with `cairn run <spec> --cold-start` before committing.

## When a checkpoint goes stale

`cairn run --cold-start` fails on the first step with a session that the app no longer recognizes (expired token, rotated cookie, changed domain). Re-capture:

```bash
cairn login admin --url https://app.com/login --wait-for text:Dashboard
```

Then re-run. If the app rotates sessions faster than you can re-capture, switch to a login action — the contract is "log in fresh each run," which is exactly what the cold-start contract wants.

## See also

- [Steps](/steps) — the `checkpoint` step (save state mid-flow) and `session: { resume }`
- [Troubleshooting](/troubleshooting) — "Spec did not satisfy the cold-start contract"
- [Authoring](/authoring) — the cold-start contract in detail