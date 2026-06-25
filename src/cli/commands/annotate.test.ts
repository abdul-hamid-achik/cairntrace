import { describe, expect, it } from "vitest";
import { isCodemapAvailable } from "./annotate.js";
import { isTvaultAvailable } from "./secrets.js";

describe("annotate module", () => {
  it("isCodemapAvailable returns a boolean", async () => {
    expect(typeof (await isCodemapAvailable())).toBe("boolean");
  });
});

describe("secrets module", () => {
  it("isTvaultAvailable returns a boolean", async () => {
    expect(typeof (await isTvaultAvailable())).toBe("boolean");
  });
});
