/**
 * Exact tmux targets. A bare `-t name` lets tmux fall back to a prefix or
 * fnmatch match when no session (or window) has exactly that name: with the
 * configured session `app` stopped and a session `app-wt` running, `-t app`
 * addresses `app-wt`, so a restart, a log read or a teardown would act on a
 * session cairn does not own. A `=` prefix asks tmux for an exact name only.
 *
 * - {@link tmuxSessionTarget}: commands whose target is a session
 *   (`has-session`, `kill-session`, `list-windows`, `set-environment`).
 * - {@link tmuxSessionScopeTarget}: commands whose target is a window or a
 *   pane but that address the session as a whole (`new-window`,
 *   `set-option`). The trailing `:` keeps tmux from reading the name as a
 *   window or pane.
 * - {@link tmuxWindowTarget}: one window (`send-keys`, `capture-pane`,
 *   `clear-history`, `list-panes`).
 *
 * `display-message -t` is never used to read a pane: it falls back to
 * another pane (exit 0) when the target is missing; `list-panes` fails.
 */
export function tmuxSessionTarget(session: string): string {
  return `=${session}`;
}

export function tmuxSessionScopeTarget(session: string): string {
  return `=${session}:`;
}

export function tmuxWindowTarget(session: string, window: string): string {
  return `=${session}:=${window}`;
}
