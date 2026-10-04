/**
 * Restart generations of a tmux window. A restart prints one marker line
 * into the pane before it resends the window's command; everything below the
 * last marker is the new process' output. `readyOn.text` of a restart and
 * `services logs --since-restart` read only that part, so stale scrollback
 * can never pass for a fresh start.
 */

const PREFIX = "@@cairn-restart:";
const SUFFIX = "@@";
const MARKER_LINE = /^@@cairn-restart:([0-9a-f]{8})@@$/;

/** A new generation id (8 hex chars). */
export function newGenerationId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

/** The line a restart prints. */
export function generationMarker(id: string): string {
  return `${PREFIX}${id}${SUFFIX}`;
}

/** The shell command that prints the marker on its own line. */
export function generationMarkerCommand(id: string): string {
  return `echo '${generationMarker(id)}'`;
}

/**
 * The text after the LAST marker line (a given one when `id` is set).
 * `found: false` returns the whole text. The marker's own line is not part
 * of the result.
 */
export function sliceAfterGeneration(
  text: string,
  id?: string,
): { text: string; found: boolean; generation?: string } {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = MARKER_LINE.exec(lines[index]!.trim());
    if (!match) continue;
    if (id !== undefined && match[1] !== id) continue;
    return {
      text: lines.slice(index + 1).join("\n"),
      found: true,
      generation: match[1]!,
    };
  }
  return { text, found: false };
}
