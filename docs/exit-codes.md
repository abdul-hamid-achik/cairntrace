---
title: Cairntrace Exit Codes for CI and Agents
description: Stable exit codes for the cairn CLI, from success and outcome failure to cold-start gates, config errors, refused runs, and critical teardown failures.
---

# Exit codes

`cairn` exits with a small, stable set of codes. CI jobs and agent harnesses can branch on them without parsing output.

## Run and general commands

| Code | Meaning                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- |
| 0    | success                                                                                   |
| 1    | outcome failure                                                                           |
| 2    | errored (a [delegated runner](/delegate) that failed, timed out, went silent, or whose exit code the relayed evidence does not support included), or a command-line usage error (unknown flag or command, a missing subcommand — bare `cairn`, `cairn services` —, missing option value or argument, on every command); `--help` / `--version` exit 0 |
| 3    | cold-start gate                                                                           |
| 4    | lint or config error (spec lint/verify findings, unknown `--env`, a held or refused services lock, a services boot an MCP server may not do, a run refused by the config `run:` policy: live run lock, failed preflight, dirty machine before the run; `cairn services up / down / restart` while a live run holds that lock) |
| 5    | heal made no progress                                                                     |
| 6    | contract-hash mismatch                                                                    |
| 7    | refused by the environment policy (nothing ran, or any refusal under `--strict-requires`) |
| 8    | a critical teardown failed (`services.teardown` entry with `critical: true`, or the `services.provisioner` `down`); outranks every other code |
| 9    | dirty state after the run (`run.verifyClean` found a survivor); outranks the run's own code except 8 |

A delegated invocation (`environments.<n>.runner`) exits with its runner's code (0–9, or 130 / 143 when the remote side was interrupted) only when the evidence supports it: a 0 needs every planned run settled by a run directory of this invocation, consistent with the stream and the remote invocation's own summary; a 1 needs a run that failed. Otherwise it settles on 2 (or the code the evidence shows); see [Delegated runners](/delegate#exit-codes).

## Export, import and check

`cairn export playwright --verify` has its own table:

| Code | Meaning |
| ---- | ------- |
| 0    | passed |
| 1    | a gate, differential spec, or mutant failed (or a refused spec) |
| 2    | usage or environment error |
| 3    | inconclusive: nothing proven; never a pass |

`cairn export playwright --check` exits 0 when the export is fresh, 1 when it is stale, and 2 on error.

`cairn import` exits 0 when the draft was written, 1 when a draft that maps nothing was refused, and 2 on error (an existing `--out` without `--force`).

See the [Commands](/commands) page for the commands that produce these codes, and [Run policy](/services#run-policy-run-lock-preflight-clean-machine-belts) for the config settings behind codes 4, 8 and 9.
