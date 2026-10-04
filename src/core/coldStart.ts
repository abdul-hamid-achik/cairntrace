import { BUILTIN_LOGIN_ACTION } from "./schema/request.v1";
import type { Spec, Step } from "./schema/spec.v1";

/**
 * Cold-start contract lint (plan §10.6): every spec must be replayable from a
 * fresh browser session, satisfied via ONE of `imports`, `session.resume`,
 * `preconditions.commands`, a `use: login` step (F18: the environment's
 * API sign-in), or an explicit `coldStart: guest` acknowledgement.
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
  if (!hasImports && !hasResume && !hasPreCmds && !usesLogin(spec)) {
    return "cold-start: no imports, no session.resume, no preconditions.commands and no use: login. Specs without setup likely cannot replay from a fresh browser.";
  }
  return undefined;
}

/**
 * F18: a top-level `use: login` (or `use: { action: login, … }`) signs the
 * run in — the built-in environment login, or an imported action so named.
 */
export function usesLogin(spec: Pick<Spec, "steps">): boolean {
  return (spec.steps ?? []).some(
    (step: Step) =>
      "use" in step &&
      (typeof step.use === "string" ? step.use : step.use.action) ===
        BUILTIN_LOGIN_ACTION,
  );
}
