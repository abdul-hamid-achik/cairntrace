import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

/**
 * Guards the hermetic test HOME (see vitest.setup.ts): no test may resolve
 * state roots against the developer's real home directory.
 */
describe("hermetic test HOME", () => {
  it("redirects HOME and os.homedir() to a tmp dir", () => {
    expect(process.env.CAIRN_TEST_HOME).toBeDefined();
    expect(process.env.HOME).toBe(process.env.CAIRN_TEST_HOME);
    expect(homedir()).toBe(process.env.CAIRN_TEST_HOME);
    expect(homedir().startsWith(tmpdir())).toBe(true);
  });

  it("keeps Playwright browser resolution pointed at the real cache", () => {
    // Only asserted when the setup file set the var itself; a developer's own
    // PLAYWRIGHT_BROWSERS_PATH is left untouched and may point anywhere.
    if (process.env.CAIRN_TEST_PW_PATH === "1") {
      expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toContain("ms-playwright");
    }
  });
});
