# MCP server

`cairn mcp` runs the same runner as the CLI as a stdio MCP server. Every CLI surface that is reasonable for an agent — `run`, `spec verify`, `explain`, `docs`, `doctor`, `context`, `diff`, `scaffold` — has a matching MCP tool. There are no per-agent code paths.

## Transport

- **stdio JSON-RPC** — the default. `cairn mcp serve` (or the older `cairn mcp` alias) listens on stdin/stdout.
- **HTTP** — `cairn mcp serve --transport http --port 4173` for harnesses that prefer HTTP. Path-based authorization tokens are not supported — keep it on loopback or use a reverse proxy with TLS.

Either transport speaks the same schema. Switching transport is a config flip, not a code change.

## Tool surface

Each `cairn_<name>` tool is a thin pass-through to the corresponding CLI command. JSON output is identical to the `--format json` CLI output for the same verb. Naming convention:

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_explain` | `cairn explain --format json` | current surface + vocabulary |
| `cairn_docs` | `cairn docs <topic>` | focused authoring guidance |
| `cairn_doctor` | `cairn doctor --format md` | environment health |
| `cairn_spec_verify` | `cairn spec verify <spec>` | schema + contract hash + dead links |
| `cairn_spec_stamp` | `cairn spec verify --stamp` | re-stamp contract hash on legitimate contract edits |
| `cairn_run` | `cairn run <spec>` | the runner; reads spec, writes artifacts |
| `cairn_context` | `cairn context latest --format md` | the post-mortem narrative |
| `cairn_diff` | `cairn diff <baseline> <run>` | DOM / network / console diff between two runs |
| `cairn_spec_scaffold` | `cairn scaffold <recorded-session>` | draft spec from a recorded session |

A tool that is not on this list does not exist. Adding one goes through the standard PR review, not as a per-agent sidecar.

## Read-only by default

Three of the nine tools (`cairn_explain`, `cairn_docs`, `cairn_doctor`) are pure read-only. The other six are mutating — they write spec changes, run the runner, scaffold new files. Harness-side access controls should reflect that:

- Allow the read-only three to any harness that needs them.
- Gate the mutating six behind a tool-permission allowlist.

## Confirm-gated mutating tools

Some projects want a typed "I really meant to run that" gate before the MCP tool fires. Configure per-tool in `cairntrace.config.yml`:

```yaml
mcp:
  perToolConfirm:
    - cairn_run
    - cairn_spec_stamp
```

When a tool is in the confirm list, the runner pauses for an interactive prompt asking `proceed? (y/N)` before executing. In headless MCP transports the prompt is a typed-args flag instead: `--confirm=true` on the tool call.

This is the same shape used by the monitor MCP server (`confirm: true` in the typed args). It is intentionally not OOB — a tool that mints a contract hash stamp or runs the full runner wants confirmation.

## MCP resources

Some MCP clients want to *browse* the spec tree, not just call tools. The server exposes two MCP resources when `mcp.resources.expose` lists them:

- `cairn://specs` — every spec file as YAML.
- `cairn://runs` — every run dir's `run.json`.

Resources are read-only. The schema is the same shape as the on-disk YAML / JSON, no translation step.

## Re-authentication, secret redaction

The MCP server inherits the redaction layer from the CLI. `mcp.redactSecrets: true` in config guarantees that artifact payloads never leak credentials back through MCP responses. The runner applies the redaction layer before serialization.

Secrets are never returned in tool responses, even when the resource is `cairn://runs` — only the post-redaction shape. If a harness needs raw artifacts, point it at the run dir on disk.

## Cookbook: setting up an MCP client

For Claude Code, Codex, OpenCode, or any other MCP-aware harness, the configuration is the same: register the `cairn` binary, point at stdio. Example for a generic MCP config:

```json
{
  "mcpServers": {
    "cairn": {
      "command": "cairn",
      "args": ["mcp", "serve"]
    }
  }
}
```

Pin the binary version in your setup script (e.g. `git checkout v1.25.0 && bun install && ln -sf "$(pwd)/bin/cairn" /usr/local/bin/cairn`). The first `cairn_explain` call you make will surface the current tool surface.

## See also

- [Distribution](/distribution) — how to install the CLI/MCP binary
- [Configuration](/configuration) — config keys including `mcp.*`
- [Agents](/agents) — recommended loop for harnesses
- [Overview](/overview) — what cairntrace is
