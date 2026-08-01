#!/usr/bin/env bash
# Cairntrace installer — one-liner:
#
#   curl -fsSL https://raw.githubusercontent.com/abdul-hamid-achik/cairntrace/main/install.sh | bash
#
# Installs the @thelacanians/cairntrace CLI globally with whichever package
# manager is available (bun > pnpm > yarn > npm). The CLI runs on Bun
# (bin/cairn is a Bun shebang with no build step), so a missing Bun is
# reported with its install command instead of failing silently.
set -euo pipefail

PKG="@thelacanians/cairntrace"

if ! command -v bun >/dev/null 2>&1; then
  echo "warning: cairn needs Bun at runtime (bin/cairn is a Bun shebang)." >&2
  echo "         Install Bun first:  curl -fsSL https://bun.sh/install | bash" >&2
fi

if command -v bun >/dev/null 2>&1; then
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
  echo "error: no package manager found (need bun, pnpm, yarn, or npm)" >&2
  exit 1
fi

if command -v cairn >/dev/null 2>&1; then
  cairn --version
else
  echo "Installed, but \`cairn\` is not on your PATH yet." >&2
  echo "Add your package manager's global bin directory and run \`cairn --version\`." >&2
fi
