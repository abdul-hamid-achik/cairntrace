import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach } from "vitest";

/**
 * Test-suite guard (installed from vitest.setup.ts): no test may write to a
 * real file.cheap vault. A `fcheap` shim is put first on PATH (and replaces
 * a developer/CI `FCHEAP_BIN`, whose binary becomes the pass-through
 * target). Only read-only commands reach the real binary: `--version`,
 * `--help` anywhere, and the allowlisted subcommands below (the subcommand
 * is the first argument that is not a flag, so `fcheap --json save` is a
 * save). Anything else (save, publish, drop, auth login, config, pull,
 * restore, …) is refused (exit 86) and recorded unless it carries a temp
 * `--stash-dir` (publish never passes), and the test that triggered it
 * fails in `afterEach`. Tests stay free to use a fake via `FCHEAP_BIN` or a
 * fake `fcheap` earlier on PATH — the shim only sees calls that would have
 * reached the real binary.
 *
 * `fcheap auth status` is answered by the shim itself ("not logged in",
 * exit 1, like fcheap with no credentials): the real command refreshes and
 * ROTATES the stored device token over the network. Every pass-through also
 * runs with its config, data and vault locations pinned inside the guard
 * directory (XDG_*_HOME, FCHEAP_STASH_DIR) and the vecgrep/service/token
 * variables removed: fcheap resolves its vault and credentials from those
 * before it looks at HOME, so the per-worker HOME alone would not keep a
 * developer's exported XDG_* or FCHEAP_* variables out.
 */

const READ_ONLY_COMMANDS = [
  "version",
  "help",
  "list",
  "info",
  "search",
  "diff",
  "doctor",
  "agent",
  "docs",
  "completion",
  "ecosystem-status",
];

export function installFcheapTestGuard(): void {
  let dir = process.env.CAIRN_FCHEAP_GUARD_DIR;
  if (!dir || !existsSync(join(dir, "fcheap"))) {
    dir = mkdtempSync(join(tmpdir(), "cairn-fcheap-guard-"));
    // A preset FCHEAP_BIN (developer shell, CI) would bypass the PATH shim
    // for every test that does not set its own fake: guard it too.
    const real =
      process.env.FCHEAP_BIN?.trim() ||
      findExecutable("fcheap", process.env.PATH ?? "");
    writeFileSync(join(dir, "violations.log"), "");
    writeFileSync(join(dir, "fcheap"), guardScript(real, dir), {
      mode: 0o755,
    });
    process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
    process.env.CAIRN_FCHEAP_GUARD_DIR = dir;
  }
  if (process.env.FCHEAP_BIN?.trim()) {
    process.env.FCHEAP_BIN = join(dir, "fcheap");
  }
  const log = join(dir, "violations.log");
  let seen = sizeOf(log);
  afterEach(() => {
    const size = sizeOf(log);
    if (size <= seen) return;
    const fresh = readFileSync(log, "utf8").slice(seen).trim();
    seen = size;
    throw new Error(
      `a test ran the real fcheap without a temp --stash-dir (use a fake FCHEAP_BIN):\n${fresh}`,
    );
  });
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function guardScript(real: string | undefined, dir: string): string {
  return `#!/bin/sh
# cairntrace vitest guard (src/testing/fcheapTestGuard.ts)
real=${quote(real ?? "")}
log=${quote(join(dir, "violations.log"))}
pass() {
  if [ -z "$real" ]; then echo "fcheap: not found (test guard)" >&2; exit 127; fi
  # fcheap reads these before HOME: pin them so nothing in the caller's
  # shell can point a pass-through at a real vault, config or credential.
  unset FCHEAP_VECGREP_PATH FILECHEAP_ARTIFACT_SERVICE_URL FILECHEAP_INGEST_TOKEN
  XDG_CONFIG_HOME=${quote(join(dir, "xdg", "config"))}
  XDG_DATA_HOME=${quote(join(dir, "xdg", "data"))}
  XDG_STATE_HOME=${quote(join(dir, "xdg", "state"))}
  XDG_CACHE_HOME=${quote(join(dir, "xdg", "cache"))}
  FCHEAP_STASH_DIR=${quote(join(dir, "xdg", "data", "fcheap"))}
  export XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME FCHEAP_STASH_DIR
  exec "$real" "$@"
}
case "$1" in ""|--version) pass "$@" ;; esac
for arg in "$@"; do
  case "$arg" in --help|-h) pass "$@" ;; esac
done
# The subcommand is the first argument that is not a flag (or a
# --stash-dir value), so global flags cannot hide a write.
sub=""
next=""
skip=""
for arg in "$@"; do
  if [ -n "$skip" ]; then skip=""; continue; fi
  case "$arg" in
    --stash-dir) skip=1 ;;
    -*) ;;
    *) if [ -z "$sub" ]; then sub="$arg"; elif [ -z "$next" ]; then next="$arg"; fi ;;
  esac
done
case " ${READ_ONLY_COMMANDS.join(" ")} " in
  *" $sub "*) pass "$@" ;;
esac
if [ "$sub" = "auth" ] && [ "$next" = "status" ]; then
  # Real fcheap refreshes (rotates) the stored token over the network; no
  # credentials means exactly this (stderr only, nothing on stdout, exit 1).
  echo "not logged in; run fcheap auth login" >&2
  exit 1
fi
stash_dir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--stash-dir" ]; then stash_dir="$arg"; fi
  case "$arg" in --stash-dir=*) stash_dir="\${arg#--stash-dir=}" ;; esac
  prev="$arg"
done
if [ "$sub" != "publish" ] && [ -n "$stash_dir" ]; then
  case "$stash_dir" in
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) pass "$@" ;;
  esac
  if [ -n "$TMPDIR" ]; then
    case "$stash_dir" in "$TMPDIR"*) pass "$@" ;; esac
  fi
fi
printf '%s\\n' "fcheap $*" >> "$log"
echo "cairntrace test guard: refusing a real 'fcheap $sub' outside a temp --stash-dir; use a fake FCHEAP_BIN" >&2
exit 86
`;
}

function findExecutable(name: string, path: string): string | undefined {
  for (const entry of path.split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
