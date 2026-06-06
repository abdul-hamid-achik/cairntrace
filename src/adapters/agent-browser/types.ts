/**
 * Adapter-specific options for the agent-browser backend.
 * Generic types (InvocationResult, NetworkEntry, etc.) live in `../browserBackend.ts`.
 */

export interface AgentBrowserOptions {
  /** Logical session name. Stamped onto every invocation as `--session <name>`. */
  session: string;
  /** Binary name or absolute path. Default: "agent-browser" (on $PATH). */
  binary?: string;
  /** Working directory for the child process. */
  cwd?: string;
  /** Show the browser window (--headed). */
  headed?: boolean;
  /** Chrome profile path (--profile). */
  profile?: string;
  /** Initial auth state file to load (--state). */
  initialStatePath?: string;
  /**
   * Per-command hard deadline in milliseconds, enforced by Cairn: the child
   * process is killed (SIGTERM, then SIGKILL) and the step fails with a
   * timeout error. Default 60s. Steps with their own `timeoutMs` get that
   * value plus a small grace period instead.
   */
  defaultTimeoutMs?: number;
  /**
   * How long interactive steps poll the snapshot for a semantic locator to
   * resolve before failing with "element not found". Default 10s.
   */
  locatorTimeoutMs?: number;
  /** Where screenshot files land (--screenshot-dir). */
  screenshotDir?: string;
  /**
   * agent-browser's state/socket directory holding `<session>.pid` files.
   * Default `~/.agent-browser`; overridable for tests.
   */
  stateDir?: string;
  /** Cap on the agent-browser stdout size (--max-output). */
  maxOutput?: number;
  /** Enable verbose agent-browser logging (--debug). */
  debug?: boolean;
  /** Extra global args to pass through. */
  extraGlobalArgs?: string[];
}
