/**
 * One temp root per `vitest run`, removed when the run ends.
 *
 * Tests (and the `bun bin/cairn` subprocesses they spawn) create temp dirs
 * with `os.tmpdir()`: hermetic HOMEs, fake projects, run artifact roots,
 * services stubs. Cleaning each of them up per test is easy to forget, and
 * one full run used to leave ~400 MB behind — repeated agent and git-hook
 * runs filled a developer disk. Pointing TMPDIR at a per-run root that the
 * teardown deletes makes the whole suite leak-free by construction.
 *
 * Runs once in the main vitest process, before any worker starts, so every
 * worker and child process inherits the TMPDIR set here. A run that was
 * killed before its teardown leaves its root behind; the next run sweeps
 * roots whose owning process is gone.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "cairn-vitest-run-";
const OWNER_FILE = ".owner-pid";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sweepAbandonedRoots(base: string): void {
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(PREFIX)) continue;
    const root = join(base, name);
    let pid = Number.NaN;
    try {
      pid = Number.parseInt(readFileSync(join(root, OWNER_FILE), "utf8"), 10);
    } catch {
      // No owner file: a root from an older layout or a crash mid-setup.
    }
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) continue;
    rmSync(root, { recursive: true, force: true });
  }
}

export default function setup(): () => void {
  // A nested `vitest run` (a test that runs vitest) keeps its parent's root.
  if (process.env.CAIRN_VITEST_RUN_ROOT) return () => undefined;

  const base = tmpdir();
  sweepAbandonedRoots(base);

  const root = mkdtempSync(join(base, PREFIX));
  writeFileSync(join(root, OWNER_FILE), String(process.pid));
  const tmp = join(root, "tmp");
  mkdirSync(tmp);
  process.env.CAIRN_VITEST_RUN_ROOT = root;
  process.env.TMPDIR = tmp;
  // Bun subprocesses (`bun bin/cairn …` under a hermetic HOME) would each
  // write their own transpiler cache into that HOME; share one per run.
  process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = join(root, "bun-cache");

  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
