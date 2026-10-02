import { appendFileSync, existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROGRESS_MESSAGE_MAX_CHARS,
  ProgressFiles,
  ProgressTail,
} from "./progressChannel";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ProgressFiles", () => {
  it("creates empty per-item files outside any run dir and disposes them", () => {
    const files = new ProgressFiles();
    const path = files.create("outcome-tasks terminal");
    expect(path).toBeDefined();
    expect(path!).toMatch(/cairn-progress-.+outcome-tasks-terminal\.progress$/);
    expect(existsSync(path!)).toBe(true);
    files.dispose();
    expect(existsSync(dirname(path!))).toBe(false);
    files.dispose();
  });
});

describe("ProgressTail", () => {
  it("reports appended lines while polling and drains the rest on stop", async () => {
    const files = new ProgressFiles();
    const path = files.create("precondition-01")!;
    const messages: string[] = [];
    const tail = new ProgressTail(path, {
      onMessage: (message) => messages.push(message),
      intervalMs: 10,
    }).start();
    await appendFile(path, "1/3 seeded\n\n");
    await sleep(60);
    expect(messages).toEqual(["1/3 seeded"]);
    await appendFile(path, "2/3 seeded\n3/3 without newline");
    tail.stop();
    expect(messages).toEqual([
      "1/3 seeded",
      "2/3 seeded",
      "3/3 without newline",
    ]);
    // Idempotent and silent after stop.
    await appendFile(path, "late\n");
    tail.stop();
    tail.poll();
    expect(messages).toHaveLength(3);
    files.dispose();
  });

  it("caps long messages and keeps only the newest lines of a burst", () => {
    const files = new ProgressFiles();
    const path = files.create("burst")!;
    const messages: string[] = [];
    const tail = new ProgressTail(path, {
      onMessage: (message) => messages.push(message),
      intervalMs: 0,
    });
    const burst = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    appendFileSync(
      path,
      `${"x".repeat(PROGRESS_MESSAGE_MAX_CHARS + 50)}\n${burst.join("\n")}\n`,
    );
    tail.stop();
    expect(messages).toHaveLength(20);
    expect(messages.at(-1)).toBe("line 50");
    expect(messages[0]).toBe("line 31");
    files.dispose();

    const files2 = new ProgressFiles();
    const path2 = files2.create("long")!;
    const long: string[] = [];
    const tail2 = new ProgressTail(path2, { onMessage: (m) => long.push(m) });
    appendFileSync(path2, `${"y".repeat(900)}\n`);
    tail2.stop();
    expect(long[0]!.length).toBe(PROGRESS_MESSAGE_MAX_CHARS);
    expect(long[0]!.endsWith("…")).toBe(true);
    files2.dispose();
  });

  it("tolerates a missing file", () => {
    const tail = new ProgressTail("/nonexistent/cairn/progress", {
      onMessage: () => {
        throw new Error("never called");
      },
    });
    expect(() => tail.stop()).not.toThrow();
  });
});
