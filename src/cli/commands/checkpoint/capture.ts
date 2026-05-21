import { AgentBrowserAdapter } from "../../../adapters/agent-browser/AgentBrowserAdapter";
import { CheckpointStore } from "../../../core/checkpoint/CheckpointStore";

export interface CaptureOptions {
  /** agent-browser session to read state from. REQUIRED. */
  session?: string;
  /** Override the checkpoint root directory (rarely needed). */
  root?: string;
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
  try {
    outPath = store.pathFor(name);
  } catch (e) {
    process.stderr.write(`cairn checkpoint: ${(e as Error).message}\n`);
    process.exit(2);
  }

  await store.ensureRoot();

  const adapter = new AgentBrowserAdapter({ session: opts.session });
  try {
    const r = await adapter.saveState(outPath);
    if (!r.ok) {
      process.stderr.write(
        `agent-browser state save failed: ${r.stderr.trim() || `exit ${r.exitCode}`}\n`,
      );
      process.exit(2);
    }
    process.stdout.write(`Checkpoint saved: ${outPath}\n`);
    process.stdout.write(`Reference it with:  session: { resume: ${name} }\n`);
  } finally {
    // Do not close the session — the user might still be using it. capture-from-session
    // is a read-only operation against a session they own.
  }
}
