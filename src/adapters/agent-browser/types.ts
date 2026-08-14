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
  /**
   * agent-browser `--idle-timeout` in milliseconds. `0` disables the
   * daemon's 1h idle exit (0.33.1+) so a long script verifier cannot
   * strand the session. Omit to leave the CLI default. Production
   * `createBackend` passes 0.
   */
  idleTimeoutMs?: number;
  /**
   * Browser provider (`-p <name>`): selects the agent-browser transport —
   * `ios` (Mobile Safari via Appium; requires Xcode + Appium), or a cloud
   * provider (`browserbase`, `kernel`, …) connecting to a remote browser.
   * Unset uses the default local Chromium.
   */
  provider?: string;
  /** iOS device name (`--device <name>`), e.g. "iPhone 15 Pro". Used with `provider: "ios"`. */
  device?: string;
  /**
   * Enable the verify-after-click delivery guard. When true (the default),
   * same-tab links must produce URL, document, or DOM evidence before the
   * next step. Set to false when the spec owns all post-click waiting.
   */
  verifyAfterClick?: boolean;
  /**
   * Project-level opt-in budget for a post-click networkidle settle.
   * Unset means delivery confirmation is sufficient; no implicit
   * networkidle wait is added.
   */
  postClickSettleMs?: number;
  /**
   * Attribute used when compiling `by: testid` to a CSS selector.
   * Default `data-testid`.
   */
  testIdAttribute?: string;
}
