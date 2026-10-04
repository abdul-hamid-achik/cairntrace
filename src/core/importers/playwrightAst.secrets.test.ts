import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SpecSchema } from "../schema/spec.v1";
import { importPlaywright } from "./playwrightImporter";

const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

/**
 * The AST importer never writes a credential literal it can identify —
 * not in steps, TODO text, approximations or the YAML — including the value
 * argument of a legacy `page.fill(selector, value)` whose selector is not
 * readable (so the call stays a TODO), URL user:password, nested credential
 * objects, numbers under credential keys and credential-shaped literals.
 * Every value is built at runtime.
 */
function secrets() {
  const stamp = `${process.pid}${Date.now()}`;
  return {
    typed: ["Typed", stamp.slice(-5), "!pw"].join("-"),
    seq: ["Seq", stamp.slice(-5), "pw"].join("-"),
    url: ["Url", stamp.slice(-5), "pw"].join("-"),
    nested: ["Nested", stamp.slice(-5), "pw"].join("-"),
    jwt: [b64({ alg: "HS256" }), b64({ sub: stamp }), "sig0123"].join("."),
    hex: randomBytes(16).toString("hex"),
    pin: 3_000_000 + (Number(stamp.slice(-6)) % 999_999),
  };
}

describe("AST importer secrets", () => {
  const s = secrets();
  const source = `import { test, expect } from "@playwright/test";
import { selectors } from "@example/ui-kit";
test("creds", async ({ page, request }) => {
  await page.goto("https://admin:${s.url}@idp.example.test/login");
  await page.fill(selectors.pwd, "${s.typed}");
  await page.fill("#password", "${s.typed}");
  await page.locator("#pwd").pressSequentially("${s.seq}");
  await request.post("/api/login", {
    data: { user: "ada", credentials: { value: "${s.nested}" }, pin: ${s.pin}, note: "${s.hex}" },
  });
  await page.goto("/reset/${s.hex}?jwt=${s.jwt}");
  await page.getByLabel("Code").fill("${s.jwt}");
  await expect(page).toHaveURL(/dashboard/);
});
`;
  const r = importPlaywright(source, { sourcePath: "/virtual/creds.spec.ts" });
  const everything = `${r.yaml}\n${JSON.stringify(r)}`;

  it("no literal, in steps, TODOs, approximations or YAML", () => {
    for (const v of [s.typed, s.seq, s.url, s.nested, s.jwt, s.hex]) {
      expect(everything).not.toContain(v);
    }
    expect(everything).not.toContain(String(s.pin));
  });

  it("the unreadable legacy fill stays a TODO with its value redacted", () => {
    const todo = r.todos.find((t) => t.includes("selectors.pwd"));
    expect(todo).toBeDefined();
    expect(todo).toContain('"<redacted>"');
  });

  it("maps every credential to a placeholder", () => {
    const spec = SpecSchema.parse(parseYaml(r.yaml));
    const steps = spec.steps ?? [];
    expect(steps[0]).toEqual({
      open: "https://${secrets.IDP_USER}:${secrets.IDP_PASSWORD}@idp.example.test/login",
    });
    const fill = steps.find(
      (st) =>
        "fill" in st &&
        (st.fill as { selector?: string }).selector === "#password",
    );
    expect(fill).toEqual({
      fill: {
        by: "selector",
        selector: "#password",
        value: "${secrets.PASSWORD}",
      },
    });
    const req = steps.find((st) => "request" in st) as {
      request: { body: unknown };
    };
    expect(req.request.body).toEqual({
      user: "ada",
      credentials: { value: "${secrets.CREDENTIALS_VALUE}" },
      pin: "${secrets.PIN}",
      note: "${secrets.NOTE}",
    });
    expect(steps).toContainEqual({
      open: "/reset/${secrets.PATH_TOKEN}?jwt=${secrets.JWT}",
    });
    expect(steps).toContainEqual({
      fill: { by: "label", name: "Code", value: "${secrets.CODE_TOKEN}" },
    });
  });

  it("says a numeric credential is now sent as text", () => {
    expect(r.yaml).toContain(
      "pin was a number in the recording; a ${secrets.X} reference is always text",
    );
  });
});

describe("AST importer leaves benign names and ids alone", () => {
  const source = `import { test } from "@playwright/test";
test("checkout en-US flow", async ({ page, request }) => {
  await page.goto("/commit/4f3c2a1b9e8d7c6b5a49382716f5e4d3c2b1a090");
  await page.goto("/api/tokens/abc12345");
  await page.getByLabel("Compass heading").fill("north");
  await page.getByLabel("Passenger count").fill("2");
  await page.locator("#tokenizer").fill("bpe");
  await request.post("/api/v2/model?token_count=5", {
    headers: { "x-request-id": "9f8e7d6c5b4a39281706f5e4d3c2b1a0", "x-session-locale": "en" },
    data: { tokenizer: "bpe", passengers: 2, secretary: "Jane Doe", signature: "Regards, Ann" },
  });
});
`;
  const r = importPlaywright(source, { sourcePath: "/virtual/benign.spec.ts" });

  it("writes no placeholder and keeps every value", () => {
    expect(r.yaml).not.toContain("${secrets.");
    expect(r.yaml).not.toContain("<redacted>");
    const spec = SpecSchema.parse(parseYaml(r.yaml));
    const steps = spec.steps ?? [];
    expect(steps).toContainEqual({
      open: "/commit/4f3c2a1b9e8d7c6b5a49382716f5e4d3c2b1a090",
    });
    expect(steps).toContainEqual({ open: "/api/tokens/abc12345" });
    expect(steps).toContainEqual({
      fill: { by: "label", name: "Compass heading", value: "north" },
    });
    const req = steps.find((st) => "request" in st) as {
      request: { headers: Record<string, string>; body: unknown };
    };
    expect(req.request.headers).toEqual({
      "x-request-id": "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      "x-session-locale": "en",
    });
    expect(req.request.body).toEqual({
      tokenizer: "bpe",
      passengers: 2,
      secretary: "Jane Doe",
      signature: "Regards, Ann",
    });
  });
});
