import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test-only stand-in for the `tmux` binary (a bash script on PATH): enough of
 * sessions, windows, panes, send-keys, capture-pane and list-panes to drive
 * the services runner without a real tmux server. State lives in a temp dir;
 * every call is appended to `calls.log` (one line per call, args separated
 * by spaces). Not shipped (package.json excludes src/testing).
 *
 * Targets resolve like tmux 3.x: a session or window name is looked up
 * exactly, then as a unique prefix (`-t app` finds `app-wt` when `app` does
 * not exist), unless it starts with `=` (exact only); an empty part is the
 * "current" (first) one. A `=name` without `:` is not a pane target
 * (send-keys, capture-pane, clear-history, set-option fail), and
 * `display-message` answers for another pane (exit 0) when its target is
 * missing — as tmux does — so code that relies on either fails the tests.
 *
 * Behavior of a window's "process": sending a command (anything that is not
 * `echo '…'` or `C-c`) makes the pane run `node` and append the lines of
 * `<session>__<window>.output` (when it exists) to the pane log, after the
 * optional `<session>__<window>.delay` seconds. `C-c` returns the pane to the
 * idle shell `zsh`, unless `<session>__<window>.ignore` holds a count of
 * interrupts to swallow first. `FAKE_TMUX_KEEP_HISTORY=1` makes clear-history
 * a no-op (stale scrollback survives). A `ps` stand-in answers
 * `ps -o tpgid= -p <pid>` for a pane given a pid ({@link FakeTmux.foregroundJob})
 * and runs the real `ps` otherwise.
 */

const SCRIPT = String.raw`#!/bin/bash
D="$FAKE_TMUX_DIR"
echo "$*" >> "$D/calls.log"
cmd="$1"; shift
target=""; fmt=""
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  case "\${args[$i]}" in
    -t) target="\${args[$((i+1))]}" ;;
    -F) fmt="\${args[$((i+1))]}" ;;
  esac
done
# tmux lookup: exact, then a unique prefix, unless "=" (exact only); an empty
# name is the current (first) entry.
lookup() {
  local file="$1" spec="$2" exact=0 hits n
  [ -f "$file" ] || return 1
  if [ -z "$spec" ]; then head -n 1 "$file" | grep .; return $?; fi
  if [ "\${spec:0:1}" = "=" ]; then exact=1; spec="\${spec:1}"; fi
  if grep -qxF -- "$spec" "$file"; then printf '%s\n' "$spec"; return 0; fi
  [ $exact -eq 1 ] && return 1
  hits="$(while IFS= read -r line; do case "$line" in "$spec"*) printf '%s\n' "$line" ;; esac; done < "$file")"
  n="$(printf '%s' "$hits" | grep -c .)"
  [ "$n" -eq 1 ] && { printf '%s\n' "$hits"; return 0; }
  return 1
}
case "$cmd" in
  has-session|kill-session|list-windows|set-environment|new-session) kind=session ;;
  new-window|list-panes|kill-window|select-window) kind=window ;;
  *) kind=pane ;;
esac
sess=""; win=""; found=1
if [ "$cmd" != "new-session" ]; then
  colon=0; spart="$target"; wpart=""
  case "$target" in *:*) colon=1; spart="\${target%%:*}"; wpart="\${target#*:}" ;; esac
  if [ $colon -eq 0 ] && [ "$kind" = pane ] && [ "\${spart:0:1}" = "=" ]; then
    found=0
  else
    sess="$(lookup "$D/sessions" "$spart")" || found=0
    if [ $found -eq 1 ] && [ "$kind" != session ]; then
      win="$(lookup "$D/$sess.windows" "$wpart")" || found=0
    fi
  fi
fi
if [ $found -eq 0 ] && [ "$cmd" = display-message ]; then
  # tmux falls back to another pane (exit 0) when the target is missing.
  sess="$(head -n 1 "$D/sessions" 2>/dev/null)"
  win="$(head -n 1 "$D/$sess.windows" 2>/dev/null)"
  found=1
fi
key="\${sess}__\${win}"
render() {
  local out="$1" cur pid=""
  cur="$(cat "$D/$key.cmd" 2>/dev/null)"
  [ -f "$D/$key.pid" ] && pid="$(cat "$D/$key.pid")"
  out="\${out//'#{pane_current_command}'/$cur}"
  out="\${out//'#{pane_dead_status}'/}"
  out="\${out//'#{pane_dead}'/0}"
  out="\${out//'#{pane_pid}'/$pid}"
  out="\${out//'#{session_name}'/$sess}"
  out="\${out//'#{window_name}'/$win}"
  printf '%s\n' "$out"
}
if [ $found -eq 0 ]; then
  echo "can't find $kind: $target" >&2
  exit 1
fi
case "$cmd" in
  has-session) exit 0 ;;
  new-session)
    name=""; first=""
    for ((i=0; i<\${#args[@]}; i++)); do
      [ "\${args[$i]}" = "-s" ] && name="\${args[$((i+1))]}"
      [ "\${args[$i]}" = "-n" ] && first="\${args[$((i+1))]}"
    done
    if grep -qxF -- "$name" "$D/sessions" 2>/dev/null; then echo "duplicate session: $name" >&2; exit 1; fi
    echo "$name" >> "$D/sessions"
    echo "$first" > "$D/$name.windows"
    echo zsh > "$D/\${name}__\${first}.cmd"; : > "$D/\${name}__\${first}.log"
    exit 0 ;;
  new-window)
    name=""
    for ((i=0; i<\${#args[@]}; i++)); do
      [ "\${args[$i]}" = "-n" ] && name="\${args[$((i+1))]}"
    done
    echo "$name" >> "$D/$sess.windows"
    echo zsh > "$D/\${sess}__\${name}.cmd"; : > "$D/\${sess}__\${name}.log"
    exit 0 ;;
  list-windows)
    cat "$D/$sess.windows" 2>/dev/null; exit 0 ;;
  list-panes)
    render "\${fmt:-#{pane_current_command}}"; exit 0 ;;
  kill-session)
    grep -vxF -- "$sess" "$D/sessions" > "$D/sessions.tmp" 2>/dev/null; mv "$D/sessions.tmp" "$D/sessions" 2>/dev/null
    rm -f "$D/$sess.windows"
    exit 0 ;;
  kill-window)
    grep -vxF -- "$win" "$D/$sess.windows" > "$D/windows.tmp" 2>/dev/null; mv "$D/windows.tmp" "$D/$sess.windows" 2>/dev/null
    exit 0 ;;
  set-option|set-environment|select-window) exit 0 ;;
  clear-history)
    [ -n "$FAKE_TMUX_KEEP_HISTORY" ] || : > "$D/$key.log"; exit 0 ;;
  display-message)
    cur="$(cat "$D/$key.cmd" 2>/dev/null)"
    [ -z "$cur" ] && exit 1
    render "\${args[\${#args[@]}-1]}"
    exit 0 ;;
  capture-pane)
    cat "$D/$key.log" 2>/dev/null; exit 0 ;;
  send-keys)
    keys=()
    skip=0
    for ((i=0; i<\${#args[@]}; i++)); do
      if [ $skip -eq 1 ]; then skip=0; continue; fi
      if [ "\${args[$i]}" = "-t" ]; then skip=1; continue; fi
      keys+=("\${args[$i]}")
    done
    text="\${keys[0]}"
    if [ "$text" = "C-c" ]; then
      n=0; [ -f "$D/$key.ignore" ] && n="$(cat "$D/$key.ignore")"
      if [ "$n" -gt 0 ]; then echo $((n-1)) > "$D/$key.ignore"; exit 0; fi
      echo zsh > "$D/$key.cmd"; echo "^C" >> "$D/$key.log"
      if [ -f "$D/$key.pid" ]; then pid="$(cat "$D/$key.pid")"; echo "$pid" > "$D/ps.tpgid.$pid"; fi
      exit 0
    fi
    case "$text" in
      "echo '"*)
        out="$(printf '%s' "$text" | sed -e "s/^echo '//" -e "s/'\$//")"
        echo "$out" >> "$D/$key.log"; exit 0 ;;
    esac
    echo "$text" >> "$D/$key.sent"
    echo node > "$D/$key.cmd"
    delay=0; [ -f "$D/$key.delay" ] && delay="$(cat "$D/$key.delay")"
    if [ -f "$D/$key.output" ]; then
      if [ "$delay" -gt 0 ]; then
        ( sleep "$delay"; cat "$D/$key.output" >> "$D/$key.log" ) >/dev/null 2>&1 &
      else
        cat "$D/$key.output" >> "$D/$key.log"
      fi
    fi
    exit 0 ;;
esac
exit 0
`;

/**
 * `ps -o <field>= -p <pid>` for fake processes: `ps.<field>.<pid>` in the
 * state dir answers (a fake pane's `tpgid`, a reused pid's `stat` /
 * `lstart`); anything else is the real `ps`.
 */
const PS_SCRIPT = String.raw`#!/bin/bash
if [ "$1" = "-o" ] && [ "$3" = "-p" ]; then
  f="$FAKE_TMUX_DIR/ps.\${2%=}.$4"
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
fi
exec /bin/ps "$@"
`;

export interface FakeTmux {
  /** The state directory (also FAKE_TMUX_DIR). */
  dir: string;
  /** Directory holding the fake `tmux`; prepended to PATH by {@link activate}. */
  binDir: string;
  /** Prepend the fake to PATH and set FAKE_TMUX_DIR; returns the undo. */
  activate(): () => void;
  /** The whole call log, one call per entry. */
  calls(): string[];
  /** Calls whose first word is `command`. */
  callsOf(command: string): string[];
  /** The text of a window's pane log. */
  pane(session: string, window: string): string;
  /** Replace a window's pane log (stale scrollback). */
  setPane(session: string, window: string, text: string): void;
  /** What the window's process prints when it (re)starts. */
  setOutput(session: string, window: string, text: string): void;
  /** Seconds before the window's process prints its output. */
  setDelay(session: string, window: string, seconds: number): void;
  /** Swallow this many Ctrl-C before the process exits. */
  ignoreInterrupts(session: string, window: string, count: number): void;
  /** A window whose process is running (`node`). */
  seedRunning(session: string, windows: string[]): void;
  /**
   * The window's shell runs a shell-named foreground job (`bash start.sh`):
   * `pane_current_command` reads `shell`, but the pane's shell is not the
   * terminal's foreground process group until a Ctrl-C stops the job.
   */
  foregroundJob(session: string, window: string, shell?: string): void;
  /** What `ps -o <field>= -p <pid>` answers for `pid` (e.g. `stat`, `lstart`). */
  setProcess(pid: number, fields: Record<string, string>): void;
  /** Make the window's process exit by itself (idle shell). */
  exit(session: string, window: string): void;
  /** The commands sent to a window (send-keys texts that were not Ctrl-C/echo). */
  sent(session: string, window: string): string[];
  /** Remove the temp dir. */
  cleanup(): void;
}

export function createFakeTmux(): FakeTmux {
  const dir = mkdtempSync(join(tmpdir(), "cairn-fake-tmux-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const script = SCRIPT.replaceAll("\\${", "${").replaceAll("\\'", "'");
  writeFileSync(join(binDir, "tmux"), script, "utf8");
  chmodSync(join(binDir, "tmux"), 0o755);
  writeFileSync(join(binDir, "ps"), PS_SCRIPT.replaceAll("\\${", "${"), "utf8");
  chmodSync(join(binDir, "ps"), 0o755);
  let nextPid = 900_000;
  writeFileSync(join(dir, "calls.log"), "");
  const file = (session: string, window: string, ext: string): string =>
    join(dir, `${session}__${window}.${ext}`);
  return {
    dir,
    binDir,
    activate() {
      const previousPath = process.env.PATH;
      const previousDir = process.env.FAKE_TMUX_DIR;
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      process.env.FAKE_TMUX_DIR = dir;
      return () => {
        process.env.PATH = previousPath;
        if (previousDir === undefined) delete process.env.FAKE_TMUX_DIR;
        else process.env.FAKE_TMUX_DIR = previousDir;
      };
    },
    calls: () =>
      readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean),
    callsOf(command) {
      return this.calls().filter((line) => line.split(" ")[0] === command);
    },
    pane: (session, window) =>
      existsSync(file(session, window, "log"))
        ? readFileSync(file(session, window, "log"), "utf8")
        : "",
    setPane(session, window, text) {
      writeFileSync(file(session, window, "log"), text);
    },
    setOutput(session, window, text) {
      writeFileSync(file(session, window, "output"), text);
    },
    setDelay(session, window, seconds) {
      writeFileSync(file(session, window, "delay"), String(seconds));
    },
    ignoreInterrupts(session, window, count) {
      writeFileSync(file(session, window, "ignore"), String(count));
    },
    seedRunning(session, windows) {
      const sessions = join(dir, "sessions");
      writeFileSync(sessions, `${session}\n`, { flag: "a" });
      for (const window of windows) {
        writeFileSync(join(dir, `${session}.windows`), `${window}\n`, {
          flag: "a",
        });
        writeFileSync(file(session, window, "cmd"), "node\n");
        writeFileSync(file(session, window, "log"), "");
      }
    },
    foregroundJob(session, window, shell = "bash") {
      const pid = nextPid;
      nextPid += 2;
      writeFileSync(file(session, window, "cmd"), `${shell}\n`);
      writeFileSync(file(session, window, "pid"), String(pid));
      writeFileSync(join(dir, `ps.tpgid.${pid}`), String(pid + 1));
    },
    setProcess(pid, fields) {
      for (const [field, value] of Object.entries(fields)) {
        writeFileSync(join(dir, `ps.${field}.${pid}`), `${value}\n`);
      }
    },
    exit(session, window) {
      writeFileSync(file(session, window, "cmd"), "zsh\n");
      const pidFile = file(session, window, "pid");
      if (existsSync(pidFile)) {
        const pid = readFileSync(pidFile, "utf8").trim();
        writeFileSync(join(dir, `ps.tpgid.${pid}`), pid);
      }
    },
    sent(session, window) {
      return existsSync(file(session, window, "sent"))
        ? readFileSync(file(session, window, "sent"), "utf8")
            .split("\n")
            .filter(Boolean)
        : [];
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
