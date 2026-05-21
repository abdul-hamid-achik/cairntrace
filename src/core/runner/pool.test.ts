import { describe, expect, it } from "vitest";
import { runPool } from "./pool";

describe("runPool", () => {
  it("processes all items and preserves input order", async () => {
    const out = await runPool([10, 20, 30, 40, 50], 2, async (n) => n * 2);
    expect(out).toEqual([20, 40, 60, 80, 100]);
  });

  it("never exceeds the configured concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await runPool(items, 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(out).toEqual(items);
  });

  it("clamps concurrency to a sane minimum (1)", async () => {
    const out = await runPool([1, 2, 3], 0, async (n) => n);
    expect(out).toEqual([1, 2, 3]);
  });

  it("propagates errors from work fn", async () => {
    await expect(
      runPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
