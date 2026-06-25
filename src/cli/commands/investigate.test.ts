import { describe, expect, it } from "vitest";
import type { CodeMatch } from "./investigate";

describe("investigate module", () => {
  it("CodeMatch interface is structurally correct", () => {
    const match: CodeMatch = {
      file: "src/auth/login.ts",
      line: 42,
      score: 0.89,
      snippet: "handleSubmit",
    };
    expect(match.file).toBe("src/auth/login.ts");
    expect(match.line).toBe(42);
    expect(match.score).toBe(0.89);
    expect(match.snippet).toBe("handleSubmit");
  });

  it("CodeMatch without snippet is valid", () => {
    const match: CodeMatch = {
      file: "src/router.ts",
      line: 15,
      score: 0.72,
    };
    expect(match.snippet).toBeUndefined();
  });
});
