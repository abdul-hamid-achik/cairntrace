import type { Command } from "commander";

/** Exit code for a usage error: bad flag, missing value, unknown command. */
export const EXIT_USAGE = 2;

/**
 * Commander exits 1 on a usage error, which `cairn` reserves for a failed
 * outcome (a spec that ran and failed). Route every command's parse failure
 * to 2 (errored) instead, so a typo never reads as a red test. `--help` and
 * `--version` still exit 0.
 *
 * `exitOverride` is only inherited by commands created after it is set, so
 * walk the whole tree once every command is registered.
 */
export function applyUsageExitCodes(
  root: Command,
  exit: (code: number) => never = (code) => process.exit(code),
): void {
  const visit = (command: Command): void => {
    command.exitOverride((error) =>
      exit(error.exitCode === 0 ? 0 : EXIT_USAGE),
    );
    for (const child of command.commands) visit(child);
  };
  visit(root);
}
