// Theme tokens for the Ink TUI — one vocabulary shared by every view.
import type { TextProps } from "ink";
import type { RowStatus } from "./store";

export const STATUS_COLOR: Record<RowStatus, TextProps["color"]> = {
  passed: "green",
  failed: "red",
  errored: "red",
  warn: "yellow",
  running: "cyan",
  skipped: "gray",
};

export const STATUS_BADGE: Record<RowStatus, string> = {
  passed: "PASSED",
  failed: "FAILED",
  errored: "ERRORED",
  warn: "WARN",
  running: "RUNNING",
  skipped: "SKIPPED",
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
