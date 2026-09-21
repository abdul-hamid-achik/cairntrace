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
