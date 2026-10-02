import { describe, expect, it } from "vitest";
import { isTraceViewerZip } from "./agentContext";

describe("agent_context trace hint", () => {
  it("recommends show-trace only for Playwright zips", () => {
    expect(isTraceViewerZip("playwright", "traces/playwright-trace.zip")).toBe(
      true,
    );
    // agent-browser traces are Chrome trace-event JSON, whatever the name.
    expect(
      isTraceViewerZip("agent-browser", "traces/agent-browser-trace.json"),
    ).toBe(false);
    expect(
      isTraceViewerZip("agent-browser", "traces/agent-browser-trace.zip"),
    ).toBe(false);
  });
});
