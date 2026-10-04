import { execa } from "execa";
import { tmuxWindowTarget } from "../runner/tmuxTarget";
import { sliceAfterGeneration } from "./generation";

/**
 * `cairn services logs <window>`: the captured text of a tmux window, joined
 * lines (`capture-pane -J`), optionally only the current restart generation,
 * optionally waiting for a pattern. Pure over an injectable capture, so the
 * waiting logic is testable without tmux.
 */

export type CaptureWindow = () => Promise<string | undefined>;

/** The real capture: whole scrollback, wrapped lines joined. */
export function tmuxCapture(session: string, window: string): CaptureWindow {
  return async () => {
    try {
      const r = await execa(
        "tmux",
        [
          "capture-pane",
          "-J",
          "-p",
          "-t",
          tmuxWindowTarget(session, window),
          "-S",
          "-",
        ],
        { reject: false, timeout: 5_000 },
      );
      if (r.exitCode !== 0) return undefined;
      return typeof r.stdout === "string" ? r.stdout : "";
    } catch {
      return undefined;
    }
  };
}

/** The lines of a capture (trailing blank lines dropped). */
export function captureLines(text: string): string[] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  return lines;
}

export interface WindowView {
  lines: string[];
  /** `--since-restart` asked, and a restart marker was found. */
  restartFound: boolean;
  generation?: string;
}

/** The view of one capture. */
export function viewCapture(
  text: string,
  options: { sinceRestart: boolean },
): WindowView {
  if (!options.sinceRestart) {
    return { lines: captureLines(text), restartFound: false };
  }
  const slice = sliceAfterGeneration(text);
  return {
    lines: captureLines(slice.text),
    restartFound: slice.found,
    ...(slice.generation ? { generation: slice.generation } : {}),
  };
}

export interface WaitResult {
  matched: boolean;
  /** The first matching line. */
  line?: string;
  timedOut: boolean;
  elapsedMs: number;
  view: WindowView;
}

/**
 * Poll the window until a line matches `pattern` (in the current view) or
 * the budget runs out. A window that cannot be captured ends the wait.
 */
export async function waitForPattern(
  capture: CaptureWindow,
  input: {
    pattern: RegExp;
    timeoutMs: number;
    sinceRestart: boolean;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<WaitResult> {
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = now();
  let view: WindowView = { lines: [], restartFound: false };
  for (;;) {
    const text = await capture();
    if (text === undefined) {
      return {
        matched: false,
        timedOut: false,
        elapsedMs: now() - startedAt,
        view,
      };
    }
    view = viewCapture(text, { sinceRestart: input.sinceRestart });
    const line = view.lines.find((candidate) => input.pattern.test(candidate));
    if (line !== undefined) {
      return {
        matched: true,
        line,
        timedOut: false,
        elapsedMs: now() - startedAt,
        view,
      };
    }
    if (now() - startedAt >= input.timeoutMs) {
      return {
        matched: false,
        timedOut: true,
        elapsedMs: now() - startedAt,
        view,
      };
    }
    await sleep(input.pollMs ?? 500);
  }
}
