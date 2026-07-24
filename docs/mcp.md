---
title: MCP Server for Browser Testing
description: Connect AI coding agents to Cairntrace MCP tools for browser-spec discovery, authoring, verification, replay, healing, and evidence retrieval.
---

# MCP server

`cairn mcp` runs the same runner as the CLI as a **stdio MCP server**. Every CLI surface that is reasonable for an agent has a matching `cairn_<name>` tool that returns the same JSON shape as the CLI's `--format json`. There are no per-agent code paths.

## Transport

stdio JSON-RPC only. `cairn mcp` reads JSON-RPC from stdin, writes responses to stdout, and keeps its own logs on stderr (anything other than JSON-RPC on stdout would break the protocol). It is meant to be spawned by an MCP client.

There is no HTTP transport, no `serve` subcommand, and no `--port` flag. If you need HTTP, front the stdio server with a bridge — the server itself is stdio.

## Tool surface

35 tools, grouped by concern. Naming mirrors the CLI verb (`cairn_run` ↔ `cairn run`, `cairn_spec_verify` ↔ `cairn spec verify`). Every tool's `--format json` output is identical between transports, so an agent does not special-case which one is in use.

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
| `cairn_stash_save` / `_list` / `_info` / `_restore` / `_search` | `cairn stash …` | validated file.cheap v0.30 save, discovery, inspection, restore, and search |
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

The bootstrap/docs trio (`cairn_explain`, `cairn_docs`, `cairn_doctor`) and `cairn_config_validate`, `cairn_checkpoint_show`, `cairn_stash_list`, `cairn_stash_info`, `cairn_secrets_status`, `cairn_services_status`, `cairn_discover_list`/`_snapshot`/`_inventory` are read-only. The rest are mutating — they write spec changes, run the runner, restore or stash artifacts, cut clips, or annotate codemap.

Cairntrace ships **no built-in confirm gate**. If your harness wants a typed "I really meant to run that" gate, enforce it harness-side with a tool-permission allowlist: allow the read-only set freely, gate the mutating set behind an explicit approval. The server does not pause for interactive prompts.

`cairn_stash_info` and `cairn_stash_restore` declare MCP output schemas.
Malformed file.cheap responses are rejected before they reach
`structuredContent`. Operational failures return `isError: true` with a stable
error code and a next-step hint. A restore that wrote bytes but failed hash
verification also preserves its normalized receipt under
`structuredContent.restore`; do not treat that target as trusted.

## Secret redaction

The MCP server inherits the CLI's text/JSON redaction layer. Structured tool
responses and text evidence use the same redacted shape written to disk:
registered literal secrets, sensitive keys, Authorization/Cookie header lines,
and common token-bearing query parameters are scrubbed. Tool results can still
contain paths to producer-owned binary artifacts. Screenshots, videos,
downloads, transforms, and trace archives are not content-redacted and may
contain secrets or personal data. Audit post-processes vidtrace text formats
through the redactor, but extracted frames/images remain uninspected. Treat a
run-directory path as access to sensitive evidence; do not make it available
to an untrusted MCP client.

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
