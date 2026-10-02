import { AgentBrowserAdapter } from "../../../adapters/agent-browser/AgentBrowserAdapter";
import { CheckpointStore } from "../../../core/checkpoint/CheckpointStore";
import { UnknownEnvironmentError } from "../../../core/config/runtimeContext";
import {
  type CheckpointScope,
  type CheckpointScopeOptions,
  checkpointMetaFor,
  resolveCheckpointScope,
} from "./scope";

export interface CaptureOptions extends CheckpointScopeOptions {
  /** agent-browser session to read state from. REQUIRED. */
  session?: string;
  /** Override the checkpoint root directory (rarely needed). */
  root?: string;
  /** agent-browser provider (-p) the target session uses (e.g. ios). */
  provider?: string;
  /** iOS device name (--device) the target session uses. */
  device?: string;
}

export async function captureFromSessionCommand(
  name: string,
  opts: CaptureOptions,
): Promise<void> {
  if (!opts.session) {
    process.stderr.write(
      "cairn checkpoint capture-from-session: --session <agent-browser-session> is required.\n" +
        "  First run something like: agent-browser --session my-login open https://app.com/login\n" +
        "  then capture: cairn checkpoint capture-from-session billing-ready --session my-login\n",
    );
    process.exit(2);
  }

  const store = new CheckpointStore(opts.root);
  let outPath: string;
  let scope: CheckpointScope;
  try {
    outPath = store.pathFor(name);
    scope = await resolveCheckpointScope(opts);
  } catch (e) {
    process.stderr.write(`cairn checkpoint: ${(e as Error).message}\n`);
    process.exit(e instanceof UnknownEnvironmentError ? e.exitCode : 2);
  }

  await store.ensureRoot();

  const adapter = new AgentBrowserAdapter({
    session: opts.session,
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.device !== undefined ? { device: opts.device } : {}),
  });
  try {
    const r = await adapter.saveState(outPath);
    if (!r.ok) {
      process.stderr.write(
        `agent-browser state save failed: ${r.stderr.trim() || `exit ${r.exitCode}`}\n`,
      );
      process.exit(2);
    }
    // Scope: the environment's baseUrl, else the session's current origin.
    const pageUrl = scope.envBaseUrl
      ? undefined
      : await adapter.getUrl().catch(() => undefined);
    const meta = checkpointMetaFor(name, scope, {
      ...(pageUrl ? { pageUrl } : {}),
      capturedBy: "capture-from-session",
    });
    await store.writeMeta(outPath, meta);
    process.stdout.write(`Checkpoint saved: ${outPath}\n`);
    process.stdout.write(
      `Scope: ${meta.baseUrl ?? "(no baseUrl)"}${
        meta.env ? ` env ${meta.env}` : ""
      }${meta.expiresAt ? `, expires ${meta.expiresAt}` : ""}\n`,
    );
    process.stdout.write(`Reference it with:  session: { resume: ${name} }\n`);
  } finally {
    // Do not close the session — the user might still be using it. capture-from-session
    // is a read-only operation against a session they own.
  }
}
