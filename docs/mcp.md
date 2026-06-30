# MCP server

`cairn mcp` runs the same runner as the CLI as a **stdio MCP server**. Every CLI surface that is reasonable for an agent has a matching `cairn_<name>` tool that returns the same JSON shape as the CLI's `--format json`. There are no per-agent code paths.

## Transport

stdio JSON-RPC only. `cairn mcp` reads JSON-RPC from stdin, writes responses to stdout, and keeps its own logs on stderr (anything other than JSON-RPC on stdout would break the protocol). It is meant to be spawned by an MCP client.

There is no HTTP transport, no `serve` subcommand, and no `--port` flag. If you need HTTP, front the stdio server with a bridge — the server itself is stdio.

## Tool surface

29 tools, grouped by concern. Naming mirrors the CLI verb (`cairn_run` ↔ `cairn run`, `cairn_spec_verify` ↔ `cairn spec verify`). Every tool's `--format json` output is identical between transports, so an agent does not special-case which one is in use.

### Bootstrap & docs

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_explain` | `cairn explain --format json` | the full surface: commands, flags, exit codes, step + verifier vocabulary, rules. Call once at session start. |
| `cairn_docs` | `cairn docs [topic]` | focused authoring guidance by topic |
| `cairn_doctor` | `cairn doctor --format md` | environment health check |

### Spec authoring

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_spec_scaffold` | `cairn spec scaffold <name>` | draft a starter spec (optionally bound to a codemap orphan) |
| `cairn_spec_verify` | `cairn spec verify <spec>` | schema + contract hash + dead-link check (`stamp: true` re-stamps) |
| `cairn_spec_heal` | `cairn spec heal <spec>` | propose + optionally apply selector-drift fixes |

### Run & read

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_run` | `cairn run <spec>` | the runner; writes the artifact pack |
| `cairn_context` | `cairn context <run>` | the `agent_context.md` post-mortem (`latest`/`previous`) |
| `cairn_config_validate` | `cairn config validate` | validate `cairntrace.config.yml` |

### Sessions & evidence

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_checkpoint_list` / `_show` / `_delete` | `cairn checkpoint …` | manage resumable checkpoints |
| `cairn_stash_save` / `_list` / `_search` | `cairn stash …` | fcheap run-artifact stash + search |
| `cairn_clip` | `cairn clip <run-ref>` | cut vidtrace video clips from a run |

### Failure → code

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_investigate` | `cairn investigate <run-id>` | stash a failed run + vecgrep code candidates |
| `cairn_audit` | `cairn audit <spec>` | run with video + investigate |
| `cairn_annotate` | `cairn annotate <symbol>` | pin a note/data to a codemap symbol |

### Environment

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_secrets_status` | `cairn secrets` | TinyVault provider status + keys |
| `cairn_services_status` | `cairn services status` | services environment state (docker/seed/tmux) |

### Discovery (interactive authoring)

Nine stateful tools that keep one browser session alive across calls (auto-expire after 5 min of inactivity):

`cairn_discover_open` → `cairn_discover_snapshot` / `cairn_discover_inventory` → `cairn_discover_interact` / `cairn_discover_navigate` → `cairn_discover_suggest` → `cairn_discover_export` → `cairn_discover_close`. Use `cairn_discover_list` to check for active sessions. The one-shot CLI equivalent is `cairn discover <url>`. See [Discover & snapshot](/discover).

## Read-only vs mutating

The bootstrap/docs trio (`cairn_explain`, `cairn_docs`, `cairn_doctor`) and `cairn_config_validate`, `cairn_checkpoint_show`, `cairn_stash_list`, `cairn_secrets_status`, `cairn_services_status`, `cairn_discover_list`/`_snapshot`/`_inventory` are read-only. The rest are mutating — they write spec changes, run the runner, cut clips, stash artifacts, or annotate codemap.

Cairntrace ships **no built-in confirm gate**. If your harness wants a typed "I really meant to run that" gate, enforce it harness-side with a tool-permission allowlist: allow the read-only set freely, gate the mutating set behind an explicit approval. The server does not pause for interactive prompts.

## Secret redaction

The MCP server inherits the redaction layer from the CLI. Artifact content returned through tool responses is the same redacted shape that lands on disk — `Authorization` headers, cookies, bearer tokens, and anything matching a spec's `redaction:` block are scrubbed. If a harness needs raw artifacts, point it at the run dir on disk; the MCP transport never returns unredacted secrets.

## Cookbook: setting up an MCP client

For Claude Code, Codex, Cursor, OpenCode, or any other MCP-aware harness, register the `cairn` binary on stdio:

```json
{
  "mcpServers": {
    "cairntrace": {
      "command": "cairn",
      "args": ["mcp"]
    }
  }
}
```

Pin the binary version in your setup script (e.g. `git checkout v1.25.0 && bun install && ln -sf "$(pwd)/bin/cairn" /usr/local/bin/cairn`). The first `cairn_explain` call you make surfaces the current tool surface so the agent can bootstrap without guessing.

## See also

- [Distribution](/distribution) — how to install the CLI/MCP binary
- [Configuration](/configuration) — config keys (there is no `mcp:` block; transport is stdio-only)
- [Agents](/agents) — the recommended agent loop
- [Discover & snapshot](/discover) — the interactive discovery tool family
- [Overview](/overview) — what cairntrace is