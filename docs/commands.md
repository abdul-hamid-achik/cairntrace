# Commands

The `cairn` CLI surface beyond the core run/spec/authoring commands. Each page below documents one command family — flags, flow, and when to reach for it. Every command supports `--format json|yaml|md` and has a stable JSON schema; no interactive prompts on `--json`/`--yaml` paths.

## Maintenance

- [Doctor & clean](/doctor) — `cairn doctor` probes the environment; `cairn clean` prunes old run directories.

## Page inspection

- [Discover & snapshot](/discover) — `cairn discover` / `cairn snapshot` return the accessibility tree and locator inventory for a live page.

## Sessions

- [Checkpoints & login](/checkpoint) — `cairn login` captures a session by hand; `cairn checkpoint` manages resumable checkpoints.

## Evidence

- [Stash](/stash) — `cairn stash` persists run packs to fcheap for search and sharing.
- [Clip](/clip) — `cairn clip` cuts named clips from a run video via vidtrace.
- [Process monitoring](/monitor) — `--monitor` samples the browser process tree; the `monitor` step and `process` verifier assert on it.

## Failure → code

- [Investigate & audit](/investigate) — `cairn investigate` / `cairn audit` stash a failed run and surface code candidates via vecgrep.
- [Annotate](/annotate) — `cairn annotate` pins cairntrace findings to codemap symbols; `--auto-annotate` does it per run.

## Environment

- [Secrets](/secrets) — `cairn secrets` checks the TinyVault secrets provider.
- [Services](/services) — `cairn services status` and the config-driven docker/seed/tmux lifecycle.

## The core commands

The run/spec/authoring surface is documented elsewhere and is not duplicated here:

- [Quickstart](/quickstart) — `cairn run`, first spec.
- [Steps](/steps) / [Verifiers](/verifiers) — the typed vocabularies.
- [Snippets](/snippets) — `imports:` / `use:`.
- [MCP](/mcp) — `cairn mcp serve` and the `cairn_*` tool family.

Run `cairn explain --format json` (or MCP `cairn_explain`) for the machine-readable current surface, including every flag.

## See also

- [Overview](/overview) — what cairntrace is
- [Configuration](/configuration) — config keys the commands read
- [Troubleshooting](/troubleshooting) — common command failure modes