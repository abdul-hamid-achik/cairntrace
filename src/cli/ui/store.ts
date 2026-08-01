// Pure state store for the Ink TUI.
//
// The runner emits events imperatively (progress listener callbacks, services
// lifecycle events, batch lines); the views render from this reducer's state.
// Keeping the reducer pure makes the status/variant/duration derivation
// testable without rendering anything.

export type RowStatus =
  | "running"
  | "passed"
  | "failed"
  | "errored"
  | "skipped"
  | "warn";

export type PhaseName = "docker" | "seed" | "tmux" | "teardown";

export interface PhaseRow {
  phase: PhaseName;
  status: RowStatus;
  message: string;
  startedAt: number;
  finishedAt?: number;
  /** Streamed subprocess output lines for this phase (bounded, truncated). */
  output: string[];
}

export interface Note {
  kind: "info" | "warn" | "error";
  message: string;
}

export interface RunInfo {
  specName: string;
  runId: string;
  runDir: string;
  backend: string;
  environment: string;
}

export interface Row {
  id: string;
  status: RowStatus;
  durationMs?: number;
  error?: string;
}

export interface OutcomeRow {
  id: string;
  status: RowStatus;
  expected?: string;
  actual?: string;
}

export interface BatchRow {
  idx: number;
  total: number;
  label: string;
  status: RowStatus;
  name?: string;
  durationMs?: number;
  passed?: number;
  totalOutcomes?: number;
  error?: string;
}

export interface BatchSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  durationMs: number;
}

export interface TuiState {
  notes: Note[];
  services: {
    active: boolean;
    phases: PhaseRow[];
  };
  /** Batch size (1 for a single-spec run). */
  specCount: number;
  run?: RunInfo;
  preconditions: Row[];
  steps: Row[];
  outcomes: OutcomeRow[];
  batch: BatchRow[];
  summary?: BatchSummary;
  /** Fatal error shown as a prominent alert before the run exits. */
  fatal?: string;
}

export type TuiEvent =
  | { type: "note"; kind: Note["kind"]; message: string }
  | { type: "fatal"; message: string }
  | { type: "specs-count"; count: number }
  | { type: "services-start"; phase: PhaseName; message: string }
  | { type: "services-update"; phase: PhaseName; message: string }
  | {
      type: "services-finish";
      phase: PhaseName;
      status: RowStatus;
      message: string;
    }
  | { type: "services-output"; chunk: string }
  | { type: "run-start"; run: RunInfo }
  | { type: "precondition-start"; id: string }
  | {
      type: "precondition-finish";
      id: string;
      status: RowStatus;
      durationMs: number;
      error?: string;
    }
  | { type: "step-start"; id: string }
  | {
      type: "step-finish";
      id: string;
      status: RowStatus;
      durationMs: number;
      error?: string;
    }
  | { type: "outcome-start"; id: string }
  | {
      type: "outcome-finish";
      id: string;
      status: RowStatus;
      expected?: string;
      actual?: string;
    }
  | { type: "spec-start"; idx: number; total: number; label: string }
  | {
      type: "spec-finish";
      idx: number;
      status: RowStatus;
      name: string;
      durationMs: number;
      passed: number;
      totalOutcomes: number;
      error?: string;
    }
  | { type: "batch-end"; summary: BatchSummary }
  | { type: "run-end"; status: RowStatus; durationMs: number };

/** Max output lines kept per phase; longer lines are truncated. */
export const PHASE_OUTPUT_MAX_LINES = 40;
export const PHASE_OUTPUT_MAX_LINE = 200;

export function createTuiState(): TuiState {
  return {
    notes: [],
    services: { active: false, phases: [] },
    specCount: 1,
    preconditions: [],
    steps: [],
    outcomes: [],
    batch: [],
  };
}

function upsertPhase(
  state: TuiState,
  phase: PhaseName,
  mutate: (row: PhaseRow) => void,
): PhaseRow {
  let row = state.services.phases.find((p) => p.phase === phase);
  if (!row) {
    row = {
      phase,
      status: "running",
      message: "",
      startedAt: Date.now(),
      output: [],
    };
    state.services.phases = [...state.services.phases, row];
  }
  const next = { ...row };
  mutate(next);
  state.services.phases = state.services.phases.map((p) =>
    p.phase === phase ? next : p,
  );
  return next;
}

function replaceRow(rows: Row[], id: string, next: Row): Row[] {
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) return [...rows, next];
  const copy = rows.slice();
  copy[idx] = next;
  return copy;
}

function upsertOutcome(rows: OutcomeRow[], next: OutcomeRow): OutcomeRow[] {
  const idx = rows.findIndex((r) => r.id === next.id);
  if (idx < 0) return [...rows, next];
  const copy = rows.slice();
  copy[idx] = next;
  return copy;
}

/** Drop docker compose status spam (kept in service-log artifacts). */
function shouldBufferOutput(state: TuiState): boolean {
  const running = state.services.phases.find((p) => p.status === "running");
  return running !== undefined && running.phase !== "docker";
}

function pushOutputLine(lines: string[], text: string): string[] {
  const next = lines.slice();
  const line =
    text.length > PHASE_OUTPUT_MAX_LINE
      ? `${text.slice(0, PHASE_OUTPUT_MAX_LINE - 1)}…`
      : text;
  next.push(line);
  if (next.length > PHASE_OUTPUT_MAX_LINES)
    next.splice(0, next.length - PHASE_OUTPUT_MAX_LINES);
  return next;
}

export function reduceTui(state: TuiState, event: TuiEvent): TuiState {
  const next: TuiState = {
    ...state,
    notes: state.notes,
    services: { ...state.services, phases: state.services.phases },
    preconditions: state.preconditions,
    steps: state.steps,
    outcomes: state.outcomes,
    batch: state.batch,
  };

  switch (event.type) {
    case "note":
      next.notes = [
        ...state.notes,
        { kind: event.kind, message: event.message },
      ];
      if (next.notes.length > 50) next.notes.splice(0, next.notes.length - 50);
      return next;

    case "fatal":
      next.fatal = event.message;
      return next;

    case "specs-count":
      next.specCount = event.count;
      return next;

    case "services-start": {
      next.services.active = true;
      upsertPhase(next, event.phase, (row) => {
        row.status = "running";
        row.message = event.message;
        row.startedAt = Date.now();
        row.finishedAt = undefined;
      });
      return next;
    }

    case "services-update":
      next.services.active = true;
      upsertPhase(next, event.phase, (row) => {
        row.message = event.message;
      });
      return next;

    case "services-finish":
      upsertPhase(next, event.phase, (row) => {
        row.status = event.status;
        row.message = event.message;
        row.finishedAt = Date.now();
      });
      return next;

    case "services-output": {
      if (!shouldBufferOutput(next)) return next;
      const running = next.services.phases.find((p) => p.status === "running");
      if (!running) return next;
      const lines = event.chunk.split("\n");
      let output = running.output;
      for (const line of lines) {
        if (line.trim() === "") continue;
        output = pushOutputLine(output, line);
      }
      next.services.phases = next.services.phases.map((p) =>
        p.phase === running.phase ? { ...p, output } : p,
      );
      return next;
    }

    case "run-start":
      next.run = event.run;
      next.preconditions = [];
      next.steps = [];
      next.outcomes = [];
      return next;

    case "precondition-start":
      next.preconditions = replaceRow(next.preconditions, event.id, {
        id: event.id,
        status: "running",
      });
      return next;

    case "precondition-finish":
      next.preconditions = replaceRow(next.preconditions, event.id, {
        id: event.id,
        status: event.status,
        durationMs: event.durationMs,
        error: event.error,
      });
      return next;

    case "step-start":
      next.steps = replaceRow(next.steps, event.id, {
        id: event.id,
        status: "running",
      });
      return next;

    case "step-finish":
      next.steps = replaceRow(next.steps, event.id, {
        id: event.id,
        status: event.status,
        durationMs: event.durationMs,
        error: event.error,
      });
      return next;

    case "outcome-start":
      next.outcomes = upsertOutcome(next.outcomes, {
        id: event.id,
        status: "running",
      });
      return next;

    case "outcome-finish":
      next.outcomes = upsertOutcome(next.outcomes, {
        id: event.id,
        status: event.status,
        expected: event.expected,
        actual: event.actual,
      });
      return next;

    case "spec-start": {
      const row: BatchRow = {
        idx: event.idx,
        total: event.total,
        label: event.label,
        status: "running",
      };
      next.batch = [...state.batch, row];
      return next;
    }

    case "spec-finish": {
      const idx = state.batch.findIndex((r) => r.idx === event.idx);
      const row: BatchRow = {
        idx: event.idx,
        total: next.specCount,
        label: event.name,
        status: event.status,
        name: event.name,
        durationMs: event.durationMs,
        passed: event.passed,
        totalOutcomes: event.totalOutcomes,
        error: event.error,
      };
      next.batch =
        idx < 0
          ? [...state.batch, row]
          : state.batch.map((r) => (r.idx === event.idx ? row : r));
      return next;
    }

    case "batch-end":
      next.summary = event.summary;
      return next;

    case "run-end":
      // Single-spec runs have no batch rows; the summary lives in the footer.
      if (next.batch.length === 0) {
        next.summary = {
          total: 1,
          passed: event.status === "passed" ? 1 : 0,
          failed: event.status === "failed" ? 1 : 0,
          errored: event.status === "errored" ? 1 : 0,
          durationMs: event.durationMs,
        };
      }
      return next;
  }
}

/** Small mutable store exposing subscribe/snapshot for useSyncExternalStore. */
export class TuiStore {
  state: TuiState = createTuiState();
  private listeners = new Set<() => void>();

  push(event: TuiEvent): void {
    this.state = reduceTui(this.state, event);
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TuiState => this.state;
}

/** Derive the Ink StatusMessage variant for a row status. */
export function statusVariant(
  status: RowStatus,
): "info" | "success" | "error" | "warning" {
  switch (status) {
    case "passed":
      return "success";
    case "failed":
    case "errored":
      return "error";
    case "warn":
      return "warning";
    default:
      return "info";
  }
}
