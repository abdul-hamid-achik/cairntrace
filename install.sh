#!/usr/bin/env bash
# Cairntrace installer — one-liner:
#
#   curl -fsSL https://raw.githubusercontent.com/abdul-hamid-achik/cairntrace/main/install.sh | bash
#
# Prefers Homebrew (`abdul-hamid-achik/tap/cairntrace`) when `brew` is on
# PATH, then bun > pnpm > yarn > npm for `@thelacanians/cairntrace`. The CLI
# runs on Bun (bin/cairn is a Bun shebang with no build step), so a missing
# Bun is reported with its install command instead of failing silently.
set -euo pipefail

PKG="@thelacanians/cairntrace"
BREW_FORMULA="abdul-hamid-achik/tap/cairntrace"

if command -v brew >/dev/null 2>&1; then
  echo "Installing cairntrace with Homebrew (${BREW_FORMULA})..."
  brew install "$BREW_FORMULA"
elif command -v bun >/dev/null 2>&1; then
  echo "Installing ${PKG} with bun..."
  bun add -g "$PKG"
elif command -v pnpm >/dev/null 2>&1; then
  echo "Installing ${PKG} with pnpm..."
  pnpm add -g "$PKG"
elif command -v yarn >/dev/null 2>&1; then
  echo "Installing ${PKG} with yarn..."
  yarn global add "$PKG"
elif command -v npm >/dev/null 2>&1; then
  echo "Installing ${PKG} with npm..."
  npm install -g "$PKG"
else
  echo "error: no installer found (need brew, bun, pnpm, yarn, or npm)" >&2
  echo "       Homebrew:  brew install ${BREW_FORMULA}" >&2
  echo "       npm:       npm install -g ${PKG}" >&2
  echo "       Bun:       curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "warning: cairn needs Bun at runtime (bin/cairn is a Bun shebang)." >&2
  echo "         Install Bun first:  curl -fsSL https://bun.sh/install | bash" >&2
fi

if command -v cairn >/dev/null 2>&1; then
  cairn --version
else
  echo "Installed, but \`cairn\` is not on your PATH yet." >&2
  echo "Add your package manager's global bin directory and run \`cairn --version\`." >&2
fi
