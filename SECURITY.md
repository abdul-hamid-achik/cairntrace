# Security

## Trust model

**Cairntrace specs are trusted code, just like a Playwright test file or a
shell script.** The spec author can:

- Read arbitrary files via `imports:` (including `~/.ssh/...`, `/etc/...`).
- Capture host `${env.X}` / `${secrets.X}` values into substituted YAML and,
  if those values end up in URLs / form values / page text, into the run's
  network and console artifacts.
- Execute arbitrary JavaScript in the browser context via the `script`
  verifier — limited only by what the page's same-origin storage allows.
- Upload arbitrary local files via `upload:` steps.
- Save / restore browser auth state to / from any path via `session.resume:`
  and the `cairn checkpoint capture-from-session` command.

If you would not run a spec author's TypeScript, do not run their YAML.

## The MCP surface widens the boundary

When `cairn mcp` is running, any process connected over stdio can invoke
`cairn_run`, `cairn_spec_heal`, `cairn_spec_scaffold`, `cairn_context`,
etc. **Those tools accept arbitrary paths.** A malicious MCP client can
therefore:

- Run a spec that reads any file the user can read
- Cause the agent to navigate the host browser anywhere
- Save the resulting browser state to disk via the spec

Treat the MCP server as you would `bash -i over a socket` — only connect
trusted MCP clients (your own editor or coding-agent setup). If you need
a hardened MCP, gate sensitive tools behind an env var or wrap them with
your own permission shim.

## Artifact contents

Run artifacts (`run.json`, `agent_context.md`, `network/*.ndjson`,
`console/*.ndjson`) include:

- Full request URLs (including query-string `?token=...` parameters)
- Network response headers
- Console messages (which may contain credentials if your app logs them)
- localStorage / sessionStorage snapshots (when captured)

The `RedactionConfig` in `spec.v1.ts` (`headers`, `queryParams`,
`storageKeys`, `values`) is declared but **not yet wired through to the
artifact writers**. Until v1.x lands the redaction pipeline, treat
`~/.cairntrace/runs/` as containing potentially sensitive material. Do
not commit it to git; do not paste run paths into public issues without
reviewing the content.

## What we hardened in v1.0

- `CheckpointStore.pathFor()` rejects names with traversal characters via
  `/^[a-z][a-z0-9-_]*$/i`.
- MCP tools that accept a checkpoint name validate it against the same
  regex.
- MCP `cairn_context` validates `runId` against a safe pattern (no `../`
  escapes from `~/.cairntrace/runs/`).
- `agent-browser` and `playwright` subprocess invocations use argv arrays,
  never shell strings — no command injection via spec values.
- YAML parsing uses `yaml@2.x` defaults which limit alias expansion
  (`maxAliasCount: 100`) — billion-laughs attacks don't blow up the parser.

## What is NOT hardened (by design, v1)

- Spec `imports:` resolution permits absolute paths and `~/`-relative paths,
  per the documented `~/cairntrace-workflows/<org>/actions/` pattern.
- Spec `session.resume:` accepts absolute paths.
- Spec `upload:` steps accept any local file path.
- `script` verifier runs unsandboxed JS in the page.

These are intentional. They reflect "spec author is trusted." If you want
tighter sandboxing for a multi-tenant CI setup, run Cairntrace per-tenant
in an isolated container and don't share the artifact directory.

## Reporting

This is a personal project; no formal disclosure process yet. If you find
something genuinely exploitable beyond the trust model documented above
(e.g., an MCP client could escalate further than the spec language already
allows, or a published JSON Schema could be poisoned), open a GitHub issue
or email the maintainer.
