import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LineSplitter,
  LiveLog,
  logIndex,
  logSlug,
  normalizeLogLine,
} from "./liveLog";
import { createArtifactRedactor } from "./redaction";

async function tempLog(name = "logs/test.log"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-live-log-"));
  return join(dir, name);
}

describe("LineSplitter", () => {
  it("emits only complete lines and holds the partial tail", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push("alpha\nbe");
    expect(lines).toEqual(["alpha"]);
    splitter.push("ta\ngamma");
    expect(lines).toEqual(["alpha", "beta"]);
    splitter.flush();
    expect(lines).toEqual(["alpha", "beta", "gamma"]);
    splitter.flush();
    expect(lines).toHaveLength(3);
  });
});

describe("LineSplitter overflow", () => {
  const SECRET = "OVERFLOW-SECRET-0042";
  const redact = (text: string) => text.split(SECRET).join("[redacted]");

  it("holds back the tail of an over-long line so a secret still arriving is completed", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line), { redact });
    splitter.push(`${"a".repeat(70_000)}${SECRET.slice(0, 9)}`);
    splitter.push(`${SECRET.slice(9)}\n`);
    const written = lines.map(redact).join("\n");
    expect(written).toContain("[redacted]");
    expect(written).not.toContain(SECRET.slice(0, 9));
    expect(written).not.toContain(SECRET.slice(9));
  });

  it("redacts a secret that straddles its own cut before cutting", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line), { redact });
    // The secret sits exactly where the held-back tail begins.
    const input = `${"a".repeat(70_000)}${SECRET}${"b".repeat(8 * 1024 - 5)}`;
    splitter.push(input);
    splitter.flush();
    expect(lines.length).toBeGreaterThan(1);
    // Only the [redacted] marker may be split, never the secret.
    expect(lines.join("")).toBe(redact(input));
    for (const line of lines) {
      expect(line).not.toContain(SECRET.slice(0, 6));
      expect(line).not.toContain(SECRET.slice(-6));
    }
  });
});

describe("normalizeLogLine", () => {
  it("strips ANSI escapes and collapses carriage-return redraws", () => {
    expect(normalizeLogLine("\u001b[32mready\u001b[0m")).toBe("ready");
    expect(normalizeLogLine("pulling 10%\rpulling 55%\rpulling 100%\r")).toBe(
      "pulling 100%",
    );
    expect(normalizeLogLine("tab\tkept\u0007")).toBe("tab\tkept");
  });
});

describe("LiveLog", () => {
  it("redacts a secret even when it arrives split across chunks", async () => {
    const path = await tempLog();
    const redactor = createArtifactRedactor(undefined, {
      DEMO_API_TOKEN: "hunter2-demo-secret",
    });
    const log = new LiveLog(path, { redact: (line) => redactor.text(line) });
    log.write("connecting with hunter2-de");
    log.write("mo-secret now\nsecond line");
    log.close();
    const text = await readFile(path, "utf8");
    expect(text).toBe("connecting with [redacted] now\nsecond line\n");
    expect(text).not.toContain("hunter2");
  });

  it("redacts every line of a multi-line secret", async () => {
    const path = await tempLog();
    const pem = [
      "-----BEGIN DEMO KEY-----",
      "MIIEdemoSECRETbodyLINE1",
      "MIIEdemoSECRETbodyLINE2",
      "-----END DEMO KEY-----",
    ].join("\n");
    const redactor = createArtifactRedactor(undefined, {
      DEMO_PRIVATE_TOKEN: pem,
    });
    const log = new LiveLog(path, { redact: redactor.text });
    log.write(`key:\n${pem.slice(0, 40)}`);
    log.write(`${pem.slice(40)}\nafter\n`);
    log.close();
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("MIIEdemoSECRETbodyLINE");
    expect(text).not.toContain("BEGIN DEMO KEY");
    expect(text).toBe(
      "key:\n[redacted]\n[redacted]\n[redacted]\n[redacted]\nafter\n",
    );
  });

  it("creates the file private and keeps a redacted tail", async () => {
    const path = await tempLog();
    const log = new LiveLog(path, {
      redact: (line) => line.replaceAll("secret", "[redacted]"),
      tailChars: 100,
    });
    log.writeLine("first secret");
    log.writeLine("last line");
    expect(log.tail()).toBe("first [redacted]\nlast line");
    expect(log.tail(11)).toBe("]\nlast line");
    log.close();
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("drops filtered lines and stops at the byte cap with one notice", async () => {
    const path = await tempLog();
    const log = new LiveLog(path, {
      filter: (line) => !line.startsWith("#"),
      maxBytes: 12,
    });
    log.write("# hidden\nkeep me\nthis is too long\nmore\n");
    log.close();
    const text = await readFile(path, "utf8");
    expect(text.startsWith("keep me\n")).toBe(true);
    expect(text).toContain("[cairn] log truncated");
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("more");
  });

  it("is a no-op after close and never throws on an unwritable path", async () => {
    const path = await tempLog();
    const log = new LiveLog(path);
    log.close();
    log.close();
    log.write("late\n");
    expect(await readFile(path, "utf8")).toBe("");

    const broken = new LiveLog("/dev/null/cannot/exist.log");
    expect(broken.available).toBe(false);
    expect(() => {
      broken.writeLine("ignored");
      broken.close();
    }).not.toThrow();
  });
});

describe("log names", () => {
  it("slugs names and pads indexes", () => {
    expect(logSlug("seed check / quiesce")).toBe("seed-check-quiesce");
    expect(logSlug("../../etc")).toBe("etc");
    expect(logSlug("   ")).toBe("item");
    expect(logIndex(3)).toBe("03");
    expect(logIndex(12)).toBe("12");
  });
});
