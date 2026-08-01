// TUI lifecycle + listener factories: the bridge between the runner's
// imperative callbacks and the Ink views' declarative state.
import React, { useSyncExternalStore } from "react";
import { render } from "ink";
import type { ProgressListener } from "../../core/runner/Runner";
import type {
  ServicesEvent,
  StartServicesContext,
} from "../../core/runner/services";
import { App } from "./views";
import { TuiStore, type Note, type PhaseName, type RowStatus } from "./store";

let activeStore: TuiStore | undefined;
let unmountFn: (() => void) | undefined;
let exitHandlerInstalled = false;

function TuiApp() {
  const store = activeStore;
  const state = useSyncExternalStore(store!.subscribe, store!.getSnapshot);
  return <App state={state} />;
}

/** Mount the Ink tree on stderr; narration now flows through the store. */
export function mountTui(store: TuiStore): void {
  if (activeStore) return;
  activeStore = store;
  const instance = render(<TuiApp />, { stdout: process.stderr });
  unmountFn = () => instance.unmount();
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on("exit", () => {
      try {
        unmountFn?.();
      } catch {
        // best-effort: the process is exiting anyway
      }
    });
  }
}

/** Release the viewport; raw stderr writes are safe again afterwards. */
export function unmountTui(): void {
  if (unmountFn) {
    const fn = unmountFn;
    unmountFn = undefined;
    try {
      fn();
    } catch {
      // best-effort
    }
  }
  activeStore = undefined;
}

export function isTuiMounted(): boolean {
  return activeStore !== undefined;
}

export function getTuiStore(): TuiStore | undefined {
  return activeStore;
}

/** Route a narration line through the tree (no-op when not mounted). */
export function tuiNote(kind: Note["kind"], message: string): void {
  activeStore?.push({ type: "note", kind, message });
}

/** Route a fatal error through the tree so the final frame shows it. */
export function tuiFatal(message: string): void {
  activeStore?.push({ type: "fatal", message });
}

function mapStepStatus(status: string): RowStatus {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "errored":
      return "errored";
    case "skipped":
      return "skipped";
    default:
      return "failed";
  }
}

/** ProgressListener backed by the store (replaces the tty clack renderer). */
export function makeInkProgressListener(store: TuiStore): ProgressListener {
  return {
    onRunStart(spec, runId, runDir, backendName, environment) {
      store.push({
        type: "run-start",
        run: {
          specName: spec.name,
          runId,
          runDir,
          backend: backendName,
          environment,
        },
      });
    },
    onPreconditionStart(name) {
      store.push({ type: "precondition-start", id: name });
    },
    onPreconditionFinish(name, exitCode, durationMs, details) {
      const ok = exitCode === 0 && !details?.timedOut;
      store.push({
        type: "precondition-finish",
        id: name,
        status: ok ? "passed" : "failed",
        durationMs,
        error: ok
          ? undefined
          : `exit ${exitCode}${details?.timedOut ? " (timed out)" : ""}`,
      });
    },
    onStepStart(_idx, _step, stepId) {
      store.push({ type: "step-start", id: stepId });
    },
    onStepFinish(_idx, stepId, status, durationMs, error) {
      store.push({
        type: "step-finish",
        id: stepId,
        status: mapStepStatus(status),
        durationMs,
        error,
      });
    },
    onOutcomesStart() {
      // The outcomes section appears as outcomes start; no event needed.
    },
    onOutcomeStart(outcome) {
      store.push({ type: "outcome-start", id: outcome.id });
    },
    onOutcomeFinish(outcome, evaluation) {
      store.push({
        type: "outcome-finish",
        id: outcome.id,
        status: evaluation.skipped
          ? "skipped"
          : evaluation.passed
            ? "passed"
            : "failed",
        expected: evaluation.expected,
        actual: evaluation.actual,
      });
    },
    onRunEnd(result) {
      store.push({
        type: "run-end",
        status:
          result.status === "passed"
            ? "passed"
            : result.status === "errored"
              ? "errored"
              : "failed",
        durationMs: result.durationMs,
      });
    },
  };
}

/** ServicesNarrator shape (matches StartServicesContext narration fields). */
type ServicesNarrator = Pick<
  StartServicesContext,
  "log" | "logDetail" | "onOutput" | "onEvent"
>;

/** ServicesNarrator backed by the store (replaces the tty services renderer). */
export function makeInkServicesNarrator(store: TuiStore): ServicesNarrator {
  return {
    log(message) {
      // Seed heartbeats are covered by the spinner; teardown commands are
      // worth a note since their events carry no command text.
      if (/still running after/.test(message)) return;
      if (message.startsWith("teardown (")) {
        store.push({ type: "note", kind: "info", message });
      }
    },
    logDetail() {
      // Play-by-play detail is not rendered in the tree.
    },
    onOutput(chunk) {
      store.push({ type: "services-output", chunk });
    },
    onEvent(event: ServicesEvent) {
      const phase = event.phase as PhaseName;
      switch (event.event) {
        case "start":
          store.push({ type: "services-start", phase, message: event.message });
          return;
        case "fail":
          store.push({
            type: "services-finish",
            phase,
            status: "failed",
            message: event.message,
          });
          return;
        case "ready":
        case "reuse":
        case "complete":
        case "skip":
          store.push({
            type: "services-finish",
            phase,
            status: "passed",
            message: event.message,
          });
          return;
        default:
          // readiness/healthcheck/relaunch play-by-play updates the running
          // phase's message without changing its status.
          store.push({
            type: "services-update",
            phase,
            message: event.message,
          });
      }
    },
  };
}
