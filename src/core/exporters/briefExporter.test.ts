import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSpec } from "../parser/parseSpec";
import { BriefDocumentSchema } from "../schema/brief.v1";
import {
  applyResolvedFromRun,
  exportBrief,
  isBriefSecretEnvKey,
  redactBriefStep,
  renderBriefMarkdown,
} from "./briefExporter";
import type { Spec } from "../schema/spec.v1";

const login = {
  version: 1,
  name: "login_admin",
  intent: "sign in as admin and land on the dashboard",
  outcomes: [
    {
      id: "lands_on_dashboard",
      description: "URL ends with /dashboard.html",
      verify: { url: { endsWith: "/dashboard.html" } },
    },
  ],
  steps: [
    { id: "open_login", open: "/login" },
    {
      id: "fill_email",
      fill: {
        by: "selector",
        selector: "#email-input-v2",
        value: "admin@example.com",
      },
    },
    {
      id: "fill_password",
      fill: {
        by: "label",
        name: "Password",
        value: "__CAIRN_SECRET_REF__PASSWORD__",
      },
    },
    { id: "submit", click: { by: "role", role: "button", name: "Sign in" } },
    { id: "probe", eval: { js: "1+1", assign: "sum" } },
  ],
} as Spec;

describe("exportBrief", () => {
  it("compiles fill values, marks CSS brittle, and never inlines secrets", () => {
    const doc = BriefDocumentSchema.parse(
      exportBrief(login, { specPath: "/tmp/login.yml" }),
    );
    expect(doc.rules).toHaveLength(5);
    expect(doc.setup?.coldStart).toBe("unspecified");
    const email = doc.steps.find((s) => s.id === "fill_email")!;
    expect(email.action).toBe("fill");
    expect(email.value).toEqual({
      kind: "literal",
      text: "admin@example.com",
    });
    expect(email.brittle).toBe(true);
    expect(email.approximations.some((a) => /email/i.test(a))).toBe(true);

    const password = doc.steps.find((s) => s.id === "fill_password")!;
    expect(password.value).toEqual({ kind: "secret", name: "PASSWORD" });
    expect(JSON.stringify(doc)).not.toContain("hunter2");
    expect(JSON.stringify(doc)).not.toContain("__CAIRN_SECRET_REF__");
    expect(doc.requiredSecrets).toEqual(["PASSWORD"]);

    const probe = doc.steps.find((s) => s.id === "probe")!;
    expect(probe.action).toBe("machine");
    expect(probe.skip).toMatch(/eval/i);
    expect(doc.coverage.skips.some((s) => s.id === "probe")).toBe(true);
  });

  it("redacts a live fill value that matches a sensitive env var", () => {
    const compiled = exportBrief(login, { specPath: "/tmp/login.yml" });
    const email = compiled.steps.find((s) => s.id === "fill_email")!;
    email.value = { kind: "literal", text: "hunter2" };
    email.goal = "Fill the field with hunter2";
    const redacted = redactBriefStep(email, { PASSWORD: "hunter2" });
    expect(redacted.value).toEqual({ kind: "secret", name: "PASSWORD" });
    expect(redacted.goal).not.toContain("hunter2");
    expect(redacted.goal).toContain("secret PASSWORD");
  });

  it("treats DATABASE_URL-shaped keys as brief secrets", () => {
    expect(isBriefSecretEnvKey("DATABASE_URL")).toBe(true);
    expect(isBriefSecretEnvKey("MONGO_URI")).toBe(true);
    expect(isBriefSecretEnvKey("PASSWORD")).toBe(true);
    expect(isBriefSecretEnvKey("BASE_URL")).toBe(false);
  });

  it("attaches seenLocally from a green run", () => {
    const base = exportBrief(login, { specPath: "/tmp/login.yml" });
    const enriched = applyResolvedFromRun(base, [
      {
        id: "fill_email",
        status: "passed",
        durationMs: 10,
        resolved: { role: "textbox", name: "Email address" },
      },
    ]);
    expect(
      enriched.steps.find((s) => s.id === "fill_email")!.seenLocally,
    ).toEqual({
      role: "textbox",
      name: "Email address",
    });
  });

  it("matches the dashboard_nav markdown golden", async () => {
    const parsed = await parseSpec(
      resolve("examples/flows/01-dashboard-nav.yml"),
    );
    const doc = exportBrief(parsed.resolved, { specPath: parsed.path });
    expect(doc.setup).toEqual({
      environment: "local",
      coldStart: "preconditions",
      detail: "echo demo-app must be running on :8787",
    });
    const md = renderBriefMarkdown(doc);
    const golden = readFileSync(
      resolve("src/core/exporters/goldens/dashboard-nav.brief.md"),
      "utf8",
    );
    expect(md).toBe(golden);
  });
});
