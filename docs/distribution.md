# Distribution

Cairntrace is **not published to npm or GitHub Packages.** The supported install path is cloning the repo and running from source with Bun — there is no build or compile step. Pin to the latest release tag or use `main` for the latest.

## What gets distributed

- **The CLI binary**, `./bin/cairn` — a Bun shebang launcher. No `node_modules` install required for end users when shipped with `--standalone`.
- **The MCP server**, `./bin/cairn mcp` — same binary, different mode.
- **Spec examples**, `examples/` — meant to be copied, not edited.

What does NOT get distributed:

- The `node_modules/` tree (when shipped without `--standalone`).
- Any `dev` dependency (TypeScript, Oxlint, Vitest, Knip).
- Project-local `~/.cairntrace/` caches or run dirs.

## Pinning a version

```bash
git clone https://github.com/abdul-hamid-achik/cairntrace
cd cairntrace
git checkout v1.25.0
bun install
./bin/cairn --version
```

The CLI's `--version` reads `package.json` at runtime, so `./bin/cairn --version` always matches the checkout's `package.json` version. Pinning is a single `git checkout` and avoids version drift across teammates.

## HEAD / main workflow

For active collaboration, track `main` and rebase often:

```bash
git fetch origin
git rebase origin/main
bun install
./bin/cairn run examples/specs/hello.yml --format md
```

The canonical local gate is `bun run verify` (typecheck + lint + format check + knip + tests). There is no separate `dev` script that runs the spec suite with mock data — `bun run verify` is it.

## Symlink-on-PATH convenience

The point of `./bin/cairn` is symlinking it onto `$PATH`:

```bash
ln -s "$(pwd)/bin/cairn" /usr/local/bin/cairn
cairn --help
```

This lets spec authors invoke `cairn run my-spec.yml` from any project without baking the path. Teams that put specs under `~/work/specs/` all point at the same binary this way.

## What "standalone" means

`./bin/cairn --standalone` (when added in a future release) ships the binary with the runtime compiled in, so end users do not have to `bun install` at all. Until then, `bun install` is required once per machine. The dependency is small (Bun + Playwright + a handful of Node-style modules).

## Versioning policy

SemVer tags are the release record. The pre-1.0 series used `0.x.y`; post-1.0 uses `1.x.y`. All `v1.x.y` tags are Cairntrace v1; do not rewrite old tags just to make the visible numbering look cleaner.

## What this means for agent harnesses

An agent harness (Claude Code, Codex, OpenCode, …) should:

- Pin to a specific tag (`v1.25.0`) in any setup script.
- Verify the version with `./bin/cairn version` after install.
- Run `cairn_explain` (or `cairn explain --format json`) once on first contact to get the current CLI surface.
- Re-pin only on a deliberate upgrade.

If your harness ships a spec authorship toolkit, the version of the toolkit should match the cairntrace version it was tested against. There is no per-agent code path inside cairntrace — the toolkit is the layer above.

## See also

- [Configuration](/configuration) — config schema, env resolution, redaction
- [MCP](/mcp) — what the MCP server does and how to enable confirm-gated mutating tools
- [GitHub](/github) — how the dev workflow, GitHub Actions, and Homebrew tap fit together
- [Overview](/overview) — what cairntrace is
