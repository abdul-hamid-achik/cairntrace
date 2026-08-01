// Ink views for the Cairntrace TUI. All views render from the store state;
// the runner never writes to the viewport directly.
import React from "react";
import { Box, Text } from "ink";
import { Alert, Badge, Spinner, StatusMessage } from "@inkjs/ui";
import { STATUS_BADGE, STATUS_COLOR, formatDuration, truncate } from "./theme";
import {
  statusVariant,
  type BatchRow,
  type Note,
  type OutcomeRow,
  type PhaseRow,
  type Row,
  type RowStatus,
  type TuiState,
} from "./store";

/* ----- shared bits ----- */

/** Live elapsed since a start timestamp, re-rendering each second. */
function useElapsed(startedAt: number | undefined, intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    // Do not hold the event loop open after the run finishes.
    timer.unref?.();
    return () => clearInterval(timer);
  }, [startedAt, intervalMs]);
  return startedAt === undefined ? 0 : now - startedAt;
}

function StatusLine({
  status,
  children,
}: {
  status: RowStatus;
  children: React.ReactNode;
}) {
  return (
    <StatusMessage variant={statusVariant(status)}>{children}</StatusMessage>
  );
}

function Duration({ ms }: { ms?: number }) {
  return ms === undefined ? null : <Text dimColor> {formatDuration(ms)}</Text>;
}

function RowLine({ id, status, startedAt, durationMs, error }: Row) {
  const elapsed = useElapsed(startedAt);
  if (status === "running") {
    return <Spinner label={`${id} ${formatDuration(elapsed)}`} />;
  }
  return (
    <StatusLine status={status}>
      {id}
      <Duration ms={durationMs} />
      {error && status === "failed" ? (
        <Text dimColor> — {truncate(error, 140)}</Text>
      ) : null}
    </StatusLine>
  );
}

/* ----- notes (logger lines that used to interleave: starting, prepared, stash) ----- */

function NotesView({ notes }: { notes: Note[] }) {
  if (notes.length === 0) return null;
  return (
    <Box flexDirection="column">
      {notes.map((note, i) => (
        <Text
          key={i}
          dimColor={note.kind === "info"}
          color={
            note.kind === "warn"
              ? "yellow"
              : note.kind === "error"
                ? "red"
                : undefined
          }
        >
          {note.message}
        </Text>
      ))}
    </Box>
  );
}

/* ----- services lifecycle task list ----- */

function PhaseRowView({ phase }: { phase: PhaseRow }) {
  const elapsed = useElapsed(phase.startedAt);
  return (
    <Box flexDirection="column">
      {phase.status === "running" ? (
        <Spinner
          label={`${phase.phase}${
            phase.message ? ` — ${truncate(phase.message, 120)}` : ""
          } ${formatDuration(elapsed)}`}
        />
      ) : (
        <StatusLine status={phase.status}>
          {phase.phase}
          {phase.message ? (
            <Text dimColor> — {truncate(phase.message, 120)}</Text>
          ) : null}
          <Duration
            ms={
              phase.finishedAt !== undefined
                ? phase.finishedAt - phase.startedAt
                : undefined
            }
          />
        </StatusLine>
      )}
      {phase.output.length > 0 &&
      (phase.status === "running" || phase.status === "failed") ? (
        <Box flexDirection="column" marginLeft={2}>
          {phase.output
            .slice(phase.status === "failed" ? -5 : -10)
            .map((line, i) => (
              <Text key={i} dimColor>
                {line}
              </Text>
            ))}
        </Box>
      ) : null}
    </Box>
  );
}

function ServicesView({ phases }: { phases: PhaseRow[] }) {
  if (phases.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {phases.map((phase) => (
        <PhaseRowView key={phase.phase} phase={phase} />
      ))}
    </Box>
  );
}

/* ----- run view (single spec, or the active spec in a batch) ----- */

function RunHeader({ state }: { state: TuiState }) {
  if (!state.run) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        {state.run.specName}
      </Text>
      <Text dimColor>
        run {state.run.runId} · env={state.run.environment} · backend=
        {state.run.backend}
      </Text>
      <Text dimColor>{state.run.runDir}</Text>
    </Box>
  );
}

function RunView({ state }: { state: TuiState }) {
  if (!state.run) return null;
  const { preconditions, steps, outcomes } = state;
  return (
    <Box flexDirection="column">
      <RunHeader state={state} />
      {preconditions.length > 0 ? (
        <Box flexDirection="column">
          {preconditions.map((row) => (
            <RowLine key={row.id} {...row} />
          ))}
        </Box>
      ) : null}
      {steps.map((row) => (
        <RowLine key={row.id} {...row} />
      ))}
      {outcomes.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {outcomes.map((outcome) => (
            <OutcomeLine key={outcome.id} outcome={outcome} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function OutcomeLine({ outcome }: { outcome: OutcomeRow }) {
  const elapsed = useElapsed(outcome.startedAt);
  if (outcome.status === "running") {
    return <Spinner label={`${outcome.id} ${formatDuration(elapsed)}`} />;
  }
  return (
    <StatusLine status={outcome.status}>
      {outcome.id}
      {outcome.status === "failed" ? (
        <Text dimColor>
          {" "}
          — expected: {truncate(outcome.expected ?? "", 100)}; actual:{" "}
          {truncate((outcome.actual ?? "").split("\n")[0] ?? "", 100)}
        </Text>
      ) : null}
    </StatusLine>
  );
}

/* ----- batch rows + summary ----- */

function BatchRowView({ row }: { row: BatchRow }) {
  const running = row.status === "running";
  const liveDuration = useElapsed(running ? row.startedAt : undefined);
  const label = row.name ?? row.label;
  const outcomes =
    row.passed !== undefined && row.totalOutcomes !== undefined
      ? ` ${row.passed}/${row.totalOutcomes} outcomes`
      : "";
  return (
    <Box>
      <Text bold>
        [{row.idx + 1}/{row.total}]
      </Text>
      <Text> {label}</Text>
      <Duration ms={running ? liveDuration : row.durationMs} />
      <Text dimColor>{outcomes}</Text>
      {row.status === "running" ? (
        <Spinner />
      ) : (
        <Badge color={STATUS_COLOR[row.status]}>
          {STATUS_BADGE[row.status]}
        </Badge>
      )}
      {row.error ? <Text dimColor> — {truncate(row.error, 140)}</Text> : null}
    </Box>
  );
}

function BatchSummaryView({ state }: { state: TuiState }) {
  const summary = state.summary;
  if (!summary) return null;
  const failed = state.batch.filter(
    (r) => r.status === "failed" || r.status === "errored",
  );
  const hasFailures = summary.failed + summary.errored > 0;
  const banner = `${summary.passed}/${summary.total} passed  ${summary.failed} failed  ${summary.errored} errored  in ${formatDuration(summary.durationMs)}`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text
        bold
        color={hasFailures ? STATUS_COLOR.failed : STATUS_COLOR.passed}
      >
        {banner}
      </Text>
      {failed.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Failing specs:</Text>
          {failed.map((row) => (
            <Box key={row.idx}>
              <Text dimColor>{`- ${row.name ?? row.label}`}</Text>
              {row.error ? (
                <Text dimColor> — {truncate(row.error, 140)}</Text>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/* ----- root ----- */

export function App({ state }: { state: TuiState }) {
  const isBatch = state.specCount > 1;
  return (
    <Box flexDirection="column" gap={1}>
      <NotesView notes={state.notes} />
      {state.services.active ? (
        <ServicesView phases={state.services.phases} />
      ) : null}
      {isBatch ? (
        <Box flexDirection="column">
          {state.batch.map((row) => (
            <BatchRowView key={row.idx} row={row} />
          ))}
          <RunView state={state} />
          <BatchSummaryView state={state} />
        </Box>
      ) : (
        <Box flexDirection="column">
          <RunView state={state} />
          {state.summary ? (
            <Box marginTop={1}>
              <Text
                bold
                color={
                  state.summary.passed === state.summary.total
                    ? STATUS_COLOR.passed
                    : STATUS_COLOR.failed
                }
              >
                {state.summary.passed === state.summary.total
                  ? "PASSED"
                  : "FAILED"}{" "}
                {state.summary.passed}/{state.summary.total} outcomes{" "}
                <Text dimColor>{formatDuration(state.summary.durationMs)}</Text>
              </Text>
            </Box>
          ) : null}
        </Box>
      )}
      {state.fatal ? (
        <Box marginTop={1}>
          <Alert variant="error" title="run failed">
            {state.fatal}
          </Alert>
        </Box>
      ) : null}
    </Box>
  );
}
