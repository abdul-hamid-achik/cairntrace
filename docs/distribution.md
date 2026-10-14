---
title: Install Cairntrace with npm, Homebrew or GitHub Releases
---

# Distribution

Cairntrace is published to npm as **`@thelacanians/cairntrace`** and to
Homebrew as **`abdul-hamid-achik/tap/cairntrace`**. Installing from source
(clone + `bun install`) is also supported and equivalent — there is no build
or compile step either way. Pin to the latest release tag or use `main`.

## Install the CLI

One-liner (Homebrew if `brew` is on `$PATH`, otherwise bun > pnpm > yarn > npm):

```bash
curl -fsSL https://raw.githubusercontent.com/abdul-hamid-achik/cairntrace/main/install.sh | bash
```

Homebrew:

```bash
brew install abdul-hamid-achik/tap/cairntrace
```

npm (or bun / pnpm / yarn):

```bash
npm install -g @thelacanians/cairntrace
bun add -g @thelacanians/cairntrace
pnpm add -g @thelacanians/cairntrace
yarn global add @thelacanians/cairntrace
```

Requires [Bun](https://bun.com) `>=1.3.0` at runtime (the CLI is a Bun shebang;
Homebrew installs it as a dependency). Tag pushes publish to npm via
`.github/workflows/npm-publish.yml` (Trusted Publisher + provenance) and bump
the Homebrew formula via `.github/workflows/homebrew-tap.yml`.

## What gets distributed

- **The CLI binary**, `./bin/cairn` — a Bun shebang launcher. It runs on Bun and needs the dependencies installed (`bun install`) when run from a clone.
- **The MCP server**, `./bin/cairn mcp` — same binary, different mode.
- **Spec examples**, `examples/` — meant to be copied, not edited. (The npm package's `files` list does not include `examples/`; use a clone to get them.)

What does NOT get distributed:

- The `node_modules/` tree. Installs from npm and Homebrew bring their own dependencies; a clone needs `bun install`.
- Any `dev` dependency (Oxlint, Vitest, Knip). TypeScript is a runtime
  dependency: `cairn import playwright` and the export's host profile read
  code with its compiler API.
- Project-local `~/.cairntrace/` caches or run dirs.

## Pinning a version

```bash
git clone https://github.com/abdul-hamid-achik/cairntrace
cd cairntrace
git checkout <release-tag>
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
./bin/cairn run examples/flows/01-dashboard-nav.yml --format md
```

The canonical local gate is `bun run verify` (`audit:production` + typecheck + lint + format check + knip + tests). There is no separate `dev` script that runs the spec suite with mock data — `bun run verify` is it.

## Symlink-on-PATH convenience

The point of `./bin/cairn` is symlinking it onto `$PATH`:

```bash
ln -s "$(pwd)/bin/cairn" /usr/local/bin/cairn
cairn --help
```

This lets spec authors invoke `cairn run my-spec.yml` from any project without baking the path. Teams that put specs under `~/work/specs/` all point at the same binary this way.

## Versioning policy

Releases are SemVer tags (`vMAJOR.MINOR.PATCH`) and are the release record. Old tags are not rewritten, even when the numbering looks inconsistent with the current series. Check the tags on the [GitHub releases page](https://github.com/abdul-hamid-achik/cairntrace/releases) for the current version.

## What this means for agent harnesses

An agent harness (Claude Code, Codex, OpenCode, …) should:

- Pin to a specific release tag, npm version, or Homebrew formula in any setup script.
- Verify the version with `cairn --version` after install.
- Run `cairn_explain` (or `cairn explain --format json`) once on first contact to get the current CLI surface.
- Re-pin only on a deliberate upgrade.

If your harness ships a spec authorship toolkit, the version of the toolkit should match the cairntrace version it was tested against. There is no per-agent code path inside cairntrace — the toolkit is the layer above.

## See also

- [Configuration](/configuration) — config schema, env resolution, redaction
- [MCP](/mcp) — what the MCP server does and how to enable confirm-gated mutating tools
- [GitHub](/github) — how the dev workflow, GitHub Actions, and Homebrew tap fit together
- [Overview](/overview) — what cairntrace is
