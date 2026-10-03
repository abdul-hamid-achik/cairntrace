/**
 * Hermetic HOME for the test suite.
 *
 * Cairntrace resolves its state roots (`~/.cairntrace`, `~/.agent-browser`,
 * `~/.config/secrets`, …) through `os.homedir()`. Pointing HOME at a fresh
 * per-process tmp dir keeps tests from reading or polluting the developer's
 * real home — and lets the suite run inside sandboxes where home is read-only.
 *
 * Runs once per vitest worker process via `setupFiles` (see vitest.config.ts).
 * Idempotent: a marker env var keeps nested/repeated loads on the same dir.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFcheapTestGuard } from "./src/testing/fcheapTestGuard";

// No test may write to a real file.cheap vault: a real `fcheap save`/
// `publish`/… without a temp --stash-dir fails the test that ran it.
installFcheapTestGuard();

// A fork worker whose vitest parent died (a crash, ENOSPC, a killed shell or
// agent) must die with it. Left alone, vitest 2.x reports the failed IPC send
// as an unhandled error over the same dead channel and loops: 100% CPU and
// ~100 MB/s of heap per worker until the machine runs out of memory. Only
// IPC send failures emit `error` on `process`. SIGKILL because vitest
// replaces `process.exit` while a test file runs.
const orphanGuard = Symbol.for("cairn.vitest.orphanGuard");
const guardState = globalThis as { [orphanGuard]?: true };
function dieWithParent(): void {
  process.kill(process.pid, "SIGKILL");
}
if (typeof process.send === "function" && !guardState[orphanGuard]) {
  guardState[orphanGuard] = true;
  process.on("disconnect", dieWithParent);
  process.on("error", dieWithParent);
}

if (!process.env.CAIRN_TEST_HOME) {
  const realHome = process.env.HOME;
  const testHome = mkdtempSync(join(tmpdir(), "cairn-test-home-"));
  process.env.CAIRN_TEST_HOME = testHome;
  process.env.HOME = testHome;
  // Playwright resolves its browser cache under $HOME — keep pointing at the
  // real install so browser tests still find the downloaded Chromium.
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && realHome) {
    process.env.PLAYWRIGHT_BROWSERS_PATH =
      process.platform === "darwin"
        ? join(realHome, "Library", "Caches", "ms-playwright")
        : join(realHome, ".cache", "ms-playwright");
    process.env.CAIRN_TEST_PW_PATH = "1";
  }
}
