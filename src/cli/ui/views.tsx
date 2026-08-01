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

function RowLine({ id, status, durationMs, error }: Row) {
  if (status === "running") {
    return <Spinner label={id} />;
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
        <Text key={i} dimColor>
          {note.message}
        </Text>
      ))}
    </Box>
  );
}

/* ----- services lifecycle task list ----- */

function ServicesView({ phases }: { phases: PhaseRow[] }) {
  if (phases.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {phases.map((phase) => (
        <Box key={phase.phase} flexDirection="column">
          {phase.status === "running" ? (
            <Spinner
              label={`${phase.phase}${
                phase.message ? ` — ${truncate(phase.message, 120)}` : ""
              }`}
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
          {phase.status === "running" && phase.output.length > 0 ? (
            <Box flexDirection="column" marginLeft={2}>
              {phase.output.slice(-10).map((line, i) => (
                <Text key={i} dimColor>
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
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
  if (outcome.status === "running") {
    return <Spinner label={outcome.id} />;
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
      <Duration ms={row.durationMs} />
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
      <Text bold color={hasFailures ? "red" : "green"}>
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
                  state.summary.passed === state.summary.total ? "green" : "red"
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
