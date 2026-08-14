import { describe, expect, it } from "vitest";
import { BriefDocumentSchema, BriefMissPacketSchema } from "./brief.v1";

const step = {
  id: "fill_email",
  action: "fill" as const,
  goal: "put the authored email in the email field",
  value: { kind: "literal" as const, text: "admin@example.com" },
  authored: { by: "selector" as const, selector: "#email-input-v2" },
  seenLocally: { role: "textbox", name: "Email address" },
  approximations: [
    "textbox named Email address",
    "label Email",
    "control nearest Email",
  ],
  doneWhen: "the live control value equals admin@example.com",
  brittle: true,
};

const doc = {
  $schema: "urn:cairntrace.dev:brief:v1" as const,
  version: "1" as const,
  spec: { name: "login", path: "/tmp/login.yml" },
  intent: "sign in as admin",
  rules: [
    "Do not change the contract (intent / outcomes).",
    "Do not invent values or extra navigation.",
    "Prefer role / accessible name / label over CSS.",
    "Authored by: selector is a stale hint unless it hits.",
    "Stop when every outcome holds.",
  ],
  outcomes: [
    {
      id: "lands_on_dashboard",
      description: "URL ends with /dashboard.html",
      doneWhen: "url endsWith /dashboard.html",
    },
  ],
  steps: [step],
  requiredSecrets: [] as string[],
  coverage: {
    steps: 1,
    stepsBriefed: 1,
    skips: [],
  },
};

describe("BriefDocumentSchema", () => {
  it("accepts a filled brief", () => {
    expect(BriefDocumentSchema.parse(doc).steps[0]!.id).toBe("fill_email");
  });

  it("rejects a secret value that inlines text", () => {
    expect(() =>
      BriefDocumentSchema.parse({
        ...doc,
        steps: [
          {
            ...step,
            value: { kind: "secret", name: "PASSWORD", text: "hunter2" },
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts a miss packet wrapping one step", () => {
    const packet = BriefMissPacketSchema.parse({
      step,
      error: "0 visible matches",
      inventory: { roles: [], testids: [] },
    });
    expect(packet.step.id).toBe("fill_email");
  });
});
