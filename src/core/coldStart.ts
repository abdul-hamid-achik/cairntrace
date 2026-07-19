import type { Spec } from "./schema/spec.v1";

/**
 * Cold-start contract lint (plan §10.6): every spec must be replayable from a
 * fresh browser session, satisfied via ONE of `imports`, `session.resume`,
 * `preconditions.commands`, or an explicit `coldStart: guest` acknowledgement.
 *
 * Returns a warning message when none are present, or undefined when the
 * contract is satisfied. Shared by `cairn spec verify` and the discovery
 * export so both surface the same guidance.
 */
export function coldStartLint(spec: Spec): string | undefined {
  if (spec.coldStart === "guest") return undefined;
  const hasImports = (spec.imports?.length ?? 0) > 0;
  const hasResume = !!spec.session?.resume;
  const hasPreCmds = (spec.preconditions?.commands?.length ?? 0) > 0;
  if (!hasImports && !hasResume && !hasPreCmds) {
    return "cold-start: no imports, no session.resume, and no preconditions.commands. Specs without setup likely cannot replay from a fresh browser.";
  }
  return undefined;
}
