/**
 * Shared formatting helpers — the same functions the main process and the
 * renderer both use, so a duration or status reads identically everywhere.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const fmt = require("../lib/format");

describe("formatDuration", () => {
  it("scales units", () => {
    assert.equal(fmt.formatDuration(0), "0ms");
    assert.equal(fmt.formatDuration(250), "250ms");
    assert.equal(fmt.formatDuration(1500), "1.50s");
    assert.equal(fmt.formatDuration(45_000), "45.0s");
    assert.equal(fmt.formatDuration(125_000), "2m 5s");
    assert.equal(fmt.formatDuration(3_720_000), "1h 2m");
  });

  it("returns an em dash for nonsense", () => {
    assert.equal(fmt.formatDuration(undefined), "—");
    assert.equal(fmt.formatDuration(null), "—");
    assert.equal(fmt.formatDuration(-5), "—");
    assert.equal(fmt.formatDuration(Number.NaN), "—");
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    assert.equal(fmt.formatBytes(0), "0 B");
    assert.equal(fmt.formatBytes(512), "512 B");
    assert.equal(fmt.formatBytes(2048), "2.0 KB");
    assert.equal(fmt.formatBytes(5 * 1024 * 1024), "5.0 MB");
    assert.equal(fmt.formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB");
    assert.equal(fmt.formatBytes(undefined), "—");
  });
});

describe("formatTimestamp", () => {
  it("formats an ISO timestamp and passes junk through", () => {
    assert.match(fmt.formatTimestamp("2026-09-01T10:00:00.000Z"), /2026/);
    assert.equal(fmt.formatTimestamp("not a date"), "not a date");
    assert.equal(fmt.formatTimestamp(null), "—");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("describes the past", () => {
    assert.equal(fmt.relativeTime("2026-09-01T11:59:30.000Z", now), "30s ago");
    assert.equal(fmt.relativeTime("2026-09-01T11:00:00.000Z", now), "1h ago");
    assert.equal(fmt.relativeTime("2026-08-31T12:00:00.000Z", now), "1d ago");
    assert.equal(fmt.relativeTime("2026-08-12T12:00:00.000Z", now), "20d ago");
    assert.equal(fmt.relativeTime("2026-08-01T12:00:00.000Z", now), "1mo ago");
    assert.equal(fmt.relativeTime("2025-09-01T12:00:00.000Z", now), "1y ago");
  });

  it("describes the future", () => {
    assert.equal(fmt.relativeTime("2026-09-01T13:00:00.000Z", now), "in 1h");
  });

  it("accepts epoch millis and Dates", () => {
    assert.equal(fmt.relativeTime(now.getTime() - 60_000, now), "1m ago");
    assert.equal(
      fmt.relativeTime(new Date(now.getTime() - 120_000), now),
      "2m ago",
    );
  });

  it("returns an em dash for empty input", () => {
    assert.equal(fmt.relativeTime(null, now), "—");
    assert.equal(fmt.relativeTime("", now), "—");
    assert.equal(fmt.relativeTime("garbage", now), "garbage");
  });
});

describe("statusTone", () => {
  it("maps cairn statuses onto UI tones", () => {
    assert.equal(fmt.statusTone("passed"), "ok");
    assert.equal(fmt.statusTone("PASSED"), "ok");
    assert.equal(fmt.statusTone("failed"), "bad");
    assert.equal(fmt.statusTone("errored"), "bad");
    assert.equal(fmt.statusTone("skipped"), "muted");
    assert.equal(fmt.statusTone("interrupted"), "warn");
    assert.equal(fmt.statusTone("whatever"), "muted");
    assert.equal(fmt.statusTone(null), "muted");
  });
});

describe("parseRunId", () => {
  it("splits a cairn run id", () => {
    assert.deepEqual(
      fmt.parseRunId("2026-08-06T19-27-11-803Z_saved_reading_actions_fb47eb"),
      {
        startedAt: "2026-08-06T19-27-11-803Z",
        spec: "saved_reading_actions",
        suffix: "fb47eb",
      },
    );
  });

  it("returns nulls for an unrecognised name", () => {
    assert.deepEqual(fmt.parseRunId("scratch"), {
      startedAt: null,
      spec: null,
      suffix: null,
    });
    assert.deepEqual(fmt.parseRunId(""), {
      startedAt: null,
      spec: null,
      suffix: null,
    });
  });
});

describe("text helpers", () => {
  it("truncates with an ellipsis", () => {
    assert.equal(fmt.truncate("abcdef", 6), "abcdef");
    assert.equal(fmt.truncate("abcdefg", 4), "abc…");
    assert.equal(fmt.truncate(null), "");
  });

  it("collapses whitespace onto one line", () => {
    assert.equal(fmt.oneLine("  a\n\n b\t c "), "a b c");
    assert.equal(fmt.oneLine(undefined), "");
  });

  it("title-cases a label", () => {
    assert.equal(fmt.titleCase("errored"), "Errored");
    assert.equal(fmt.titleCase(""), "");
  });
});

describe("percent", () => {
  it("computes a bounded percentage", () => {
    assert.equal(fmt.percent(1, 3), 33.3);
    assert.equal(fmt.percent(3, 3), 100);
    assert.equal(fmt.percent(0, 3), 0);
  });

  it("returns null when the total is not usable", () => {
    assert.equal(fmt.percent(1, 0), null);
    assert.equal(fmt.percent(Number.NaN, 3), null);
  });
});
