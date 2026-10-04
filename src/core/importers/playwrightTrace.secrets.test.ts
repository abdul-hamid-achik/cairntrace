import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runImportPlaywrightTrace } from "../../cli/commands/import";
import {
  benignTraceEntries,
  cyclicTraceEntries,
  hostileTraceEntries,
  zipOf,
} from "../../testing/traceZip";
import { SpecSchema } from "../schema/spec.v1";
import { slug } from "./importCommon";
import { importPlaywrightTrace } from "./playwrightTrace";
import { ZipError } from "./zipReader";

const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

/** Credentials built at runtime: no secret-shaped literal in this file. */
function hostileInput() {
  const stamp = `${process.pid}${Date.now()}`;
  return {
    password: ["Zq", stamp.slice(-6), "!pw", "Secret"].join(""),
    jwt: [
      b64({ alg: "HS256", typ: "JWT" }),
      b64({ sub: stamp }),
      randomBytes(12).toString("base64url"),
    ].join("."),
    resetToken: randomBytes(16).toString("hex"),
    pin: 3_000_000 + (Number(stamp.slice(-6)) % 999_999),
  };
}

describe("trace importer never writes a credential it can identify (hostile trace)", () => {
  const input = hostileInput();
  const result = importPlaywrightTrace(zipOf(hostileTraceEntries(input)), {
    sourceLabel: "hostile.zip",
  });
  const everything = `${result.yaml}\n${JSON.stringify(result)}`;
  const spec = SpecSchema.parse(parseYaml(result.yaml));
  const steps = spec.steps ?? [];
  const byId = new Map(steps.map((s) => [s.id, s as Record<string, unknown>]));

  it("no value, encoding or slug of any credential appears anywhere", () => {
    const values = [
      input.password,
      input.jwt,
      input.resetToken,
      String(input.pin),
      encodeURIComponent(input.password),
    ];
    for (const v of values) expect(everything).not.toContain(v);
    // ids and names are slugs: the slug of a credential must not leak either
    expect(everything).not.toContain(slug(input.password));
    expect(everything).not.toContain(slug(input.password).slice(0, 8));
  });

  it("URL user:password becomes placeholders, cross-origin included", () => {
    expect(byId.get("open")?.["open"]).toBe(
      "https://${secrets.IDP_USER}:${secrets.IDP_PASSWORD}@idp.example.test/login",
    );
    const requests = steps.filter((s) => "request" in s) as Array<{
      id: string;
      request: {
        url: string;
        headers?: Record<string, string>;
        body?: unknown;
      };
    }>;
    expect(requests.map((r) => r.request.url)).toEqual([
      "/api/me?jwt=${secrets.JWT}",
      "https://${secrets.API_USER}:${secrets.API_PASSWORD}@api.other.test/v1/x",
      "https://${secrets.GIT_USER}@git.other.test/repo",
    ]);
    // step ids come from the redacted URL, never the raw one
    expect(requests.map((r) => r.id)).toEqual([
      "request_post_api_me",
      "request_get_https_api_other_test_v1_x",
      "request_get_https_git_other_test_repo",
    ]);
  });

  it("fragment, query and path tokens become placeholders by name and by shape", () => {
    const opens = steps
      .filter((s) => "open" in s)
      .map((s) => (s as { open: unknown }).open);
    expect(opens).toContain(
      "/callback#access_token=${secrets.ACCESS_TOKEN}&state=x",
    );
    expect(opens).toContain("/reset-password/${secrets.RESET_PASSWORD_TOKEN}");
    expect(opens).toContain("/#${secrets.FRAGMENT_TOKEN}");
    const urlOutcome = spec.outcomes.find((o) => o.id === "url_matches");
    expect(urlOutcome?.verify).toEqual({
      url: { endsWith: "/done#id_token=${secrets.ID_TOKEN}" },
    });
  });

  it("nested credential objects, numbers under credential keys, shaped values and headers", () => {
    const req = steps.find((s) => s.id === "request_post_api_me") as {
      request: { headers: Record<string, string>; body: unknown };
    };
    expect(req.request.headers).toEqual({
      "X-CSRFToken": "${secrets.X_CSRFTOKEN}",
      "x-trace": "t1",
      "x-request-sig": "${secrets.X_REQUEST_SIG}",
    });
    expect(req.request.body).toEqual({
      auth: {
        value: "${secrets.AUTH_VALUE}",
        nested: { deeper: "${secrets.AUTH_NESTED_DEEPER}" },
      },
      pin: "${secrets.PIN}",
      note: "${secrets.NOTE}",
    });
    // a credential-shaped value typed into an ordinary field
    expect(byId.get("fill_code")?.["fill"]).toEqual({
      by: "label",
      name: "Code",
      value: "${secrets.CODE_TOKEN}",
    });
  });

  it("a call recorded before the credential was identified is scrubbed too", () => {
    const failed = result.todos.find((t) => t.includes("Frame.click"));
    expect(failed).toContain('internal:text="<redacted>"i');
    // the successful click on that text keeps replaying, through a placeholder
    const click = steps.find(
      (s) =>
        "click" in s && (s as { click: { by: string } }).click.by === "text",
    ) as { id: string; click: { text: string } };
    expect(click.click.text).toMatch(/^\$\{secrets\.[A-Z_]+\}$/);
    expect(click.id).toBe("click_redacted");
    const failedGoto = result.todos.find((t) =>
      t.includes("idp.example.test/fail"),
    );
    expect(failedGoto).toContain(
      "<redacted>:<redacted>@idp.example.test/fail?token=<redacted>",
    );
  });

  it("the final URL generalizes id segments instead of pinning one record", () => {
    const final = spec.outcomes.find((o) => o.id === "final_url");
    expect(final?.verify).toEqual({
      url: { matches: "/orders/[^/?#]+/confirmation(?:[?#]|$)" },
    });
    expect(final?.description).toBe(
      "DRAFT: the session ends on /orders/{id}/confirmation",
    );
  });

  it("lists every placeholder in the header (names only)", () => {
    expect(result.secrets).toEqual(
      expect.arrayContaining([
        "IDP_USER",
        "IDP_PASSWORD",
        "ACCESS_TOKEN",
        "PW",
        "MOT_DE_PASSE",
        "JWT",
        "X_CSRFTOKEN",
        "AUTH_VALUE",
        "PIN",
        "RESET_PASSWORD_TOKEN",
      ]),
    );
    expect(result.yaml).toContain("# Secrets referenced: ${secrets.");
  });

  describe("through the CLI path (written file + report)", () => {
    let dir: string;
    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it("the written YAML and the JSON report hold no credential", async () => {
      dir = await mkdtemp(join(tmpdir(), "cairn-trace-secrets-"));
      const zip = join(dir, "hostile.zip");
      await writeFile(zip, zipOf(hostileTraceEntries(input)));
      const out = join(dir, "hostile.yml");
      const report = await runImportPlaywrightTrace(zip, { out });
      const written = await readFile(out, "utf8");
      const all = `${written}\n${JSON.stringify(report)}`;
      for (const v of [input.password, input.jwt, input.resetToken]) {
        expect(all).not.toContain(v);
      }
      expect(all).not.toContain(String(input.pin));
    });
  });
});

describe("trace importer leaves a benign trace alone (no false positives)", () => {
  const result = importPlaywrightTrace(zipOf(benignTraceEntries()), {
    sourceLabel: "benign.zip",
  });
  const spec = SpecSchema.parse(parseYaml(result.yaml));
  const steps = (spec.steps ?? []) as Array<Record<string, unknown>>;

  it("rewrites nothing: no placeholder, no <redacted>, no secrets header", () => {
    expect(result.yaml).not.toContain("${secrets.");
    expect(result.yaml).not.toContain("<redacted>");
    expect(result.yaml).not.toContain("Secrets referenced");
    expect(result.secrets).toEqual([]);
    expect(result.coverage.approximated).toBe(0);
  });

  it("keeps the title, URLs, ids and typed values as recorded", () => {
    expect(spec.name).toBe("checkout_en_us_flow");
    expect(spec.intent).toBe("checkout en-US flow");
    expect(steps.map((s) => s["open"]).filter(Boolean)).toEqual([
      "/en-US/products",
      "/en-US/regions/northwest",
      "/passwords-policy",
      "/commit/4f3c2a1b9e8d7c6b5a49382716f5e4d3c2b1a090",
      "/api/tokens/abc12345",
      "/avatar/205e460b479e2e5b48aec07710c08d50",
    ]);
    expect(steps.map((s) => s["id"])).toContain("click_north_america");
    const fills = steps
      .filter((s) => "fill" in s)
      .map((s) => (s["fill"] as { value: string }).value);
    expect(fills).toEqual(["north", "2", "bpe"]);
    const requests = steps
      .filter((s) => "request" in s)
      .map(
        (s) =>
          s["request"] as {
            url: string;
            headers?: Record<string, string>;
            body?: unknown;
          },
      );
    expect(requests[0]?.headers).toEqual({ "x-session-locale": "en-US" });
    expect(requests[1]).toMatchObject({
      url: "/api/v2/model?q=password+reset+help&token_count=5",
      headers: {
        "x-request-id": "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
        "x-session-locale": "en",
      },
      body: {
        tokenizer: "bpe",
        passengers: 2,
        secretary: "Jane Doe",
        author: "Ann",
        bypassCache: true,
        signature: "Regards, Ann",
        max_tokens: 64,
      },
    });
  });

  it("the hostile trace says a numeric credential is now sent as text", () => {
    const hostile = importPlaywrightTrace(
      zipOf(hostileTraceEntries(hostileInput())),
    );
    expect(hostile.yaml).toContain(
      "pin was a number in the recording; a ${secrets.X} reference is always text",
    );
  });
});

describe("trace importer bounds (hostile archives)", () => {
  it("a cycle in test-step parent links terminates", () => {
    const result = importPlaywrightTrace(zipOf(cyclicTraceEntries()));
    expect(result.spec.outcomes[0]?.id).toBe("todo_assertion");
  });

  it("refuses an entry above the per-entry cap and reads above the total cap", () => {
    const big = " ".repeat(300_000);
    expect(() =>
      importPlaywrightTrace(zipOf({ "0-trace.trace": big }), {
        limits: { maxEntryBytes: 200_000 },
      }),
    ).toThrow(ZipError);
    expect(() =>
      importPlaywrightTrace(
        zipOf({ "0-trace.trace": big, "0-trace.network": big }),
        { limits: { maxEntryBytes: 400_000, maxTotalBytes: 500_000 } },
      ),
    ).toThrow(/more than 500000 bytes/);
  });
});
