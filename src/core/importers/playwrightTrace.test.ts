import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { syntheticTraceEntries, zipOf } from "../../testing/traceZip";
import { SpecSchema } from "../schema/spec.v1";
import { importPlaywrightTrace, TraceFormatError } from "./playwrightTrace";
import { openZip, ZipError } from "./zipReader";

/** Neutral, runtime-built credentials: never literals in this file. */
function creds() {
  const stamp = `${process.pid}${Date.now()}`;
  return {
    password: ["pw", stamp, "q"].join("-"),
    token: ["tk", stamp, "z"].join("_"),
  };
}

describe("zip reader", () => {
  it("reads stored and deflated entries", () => {
    for (const deflate of [true, false]) {
      const zip = openZip(
        zipOf({ "a.txt": "alpha", "dir/b.json": '{"b":1}' }, deflate),
      );
      expect(zip.entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.json"]);
      expect(zip.read("dir/b.json").toString()).toBe('{"b":1}');
      expect(zip.has("nope")).toBe(false);
    }
  });

  it("rejects a non-zip and a missing entry", () => {
    expect(() => openZip(Buffer.from("not a zip at all, just text"))).toThrow(
      ZipError,
    );
    expect(() => openZip(zipOf({ a: "x" })).read("b")).toThrow(/no entry b/);
  });
});

describe("trace importer (synthetic trace)", () => {
  const c = creds();
  const result = importPlaywrightTrace(zipOf(syntheticTraceEntries(c)), {
    sourceLabel: "shop.zip",
  });
  const spec = SpecSchema.parse(parseYaml(result.yaml));

  it("maps recorded actions to steps with the best locator available", () => {
    expect(spec.steps).toEqual([
      {
        id: "open",
        open: "/login?next=/cart&access_token=${secrets.ACCESS_TOKEN}",
      },
      {
        // test.step title from test.trace
        id: "sign_in",
        fill: { by: "label", name: "Email", value: "ada@example.test" },
      },
      {
        id: "fill_pw",
        fill: { by: "selector", selector: "#pw", value: "${secrets.PW}" },
      },
      {
        // css upgraded to role+name from the resolved element
        id: "click_sign_in",
        click: { by: "role", role: "button", name: "Sign in" },
      },
      {
        // an anchor with child markup has no stable text: the test id wins
        id: "click_cart_link",
        click: { by: "testid", testid: "cart-link" },
      },
      {
        id: "wait_cart_items",
        wait: { selector: "#cart-items", state: "visible", timeoutMs: 5000 },
      },
      { id: "wait", wait: { ms: 150 } },
      {
        id: "press_enter_email",
        press: "Enter",
        target: { by: "label", name: "Email" },
      },
      {
        id: "request_post_api_orders",
        request: {
          method: "POST",
          url: "/api/orders?token=${secrets.TOKEN}",
          headers: {
            Authorization: "${secrets.AUTHORIZATION}",
            "x-trace": "t1",
          },
          body: { item: "widget", password: "${secrets.PASSWORD}" },
        },
      },
    ]);
  });

  it("writes draft outcomes from expects, the final URL and API calls, never bodies", () => {
    expect(spec.outcomes.map((o) => [o.id, o.verify])).toEqual([
      [
        "text_matches",
        { text: { equals: "Total: 12", region: '[data-qa="total"]' } },
      ],
      ["element_count", { count: { selector: "#cart-items li", equals: 2 } }],
      ["url_matches", { url: { matches: "\\/cart$" } }],
      ["final_url", { url: { endsWith: "/cart" } }],
      [
        "api_get_api_cart",
        {
          network: {
            method: "GET",
            urlContains: "/api/cart",
            status: { equals: 200 },
          },
        },
      ],
      [
        // an id-like segment cuts the path; the query string is never kept
        "api_get_api_cart_2",
        {
          network: {
            method: "GET",
            urlContains: "/api/cart/",
            status: { equals: 200 },
          },
        },
      ],
      [
        "api_post_api_orders",
        {
          network: {
            method: "POST",
            urlContains: "/api/orders",
            status: { equals: 201 },
          },
        },
      ],
    ]);
    expect(
      spec.outcomes.every((o) => o.description.startsWith("DRAFT: ")),
    ).toBe(true);
    // the document, a preflight and third-party traffic are not candidates
    expect(result.summary.network).toEqual({
      responses: 6,
      candidates: 3,
      skipped: 3,
    });
  });

  it("reports failed calls and unmappable ones as TODOs with reasons", () => {
    expect(result.todos.join("\n")).toContain(
      "the recorded call failed (Timeout",
    );
    expect(result.todos.join("\n")).toContain("raw keyboard input");
    expect(result.yaml).toContain("# TODO:");
    expect(result.coverage.unmapped).toBe(2);
    expect(result.summary.readsIgnored).toBe(1);
  });

  it("never writes a credential literal, in steps, outcomes, comments or the report", () => {
    const everything = JSON.stringify(result) + result.yaml;
    expect(everything).not.toContain(c.password);
    expect(everything).not.toContain(c.token);
    expect(result.secrets.toSorted()).toEqual(
      ["ACCESS_TOKEN", "AUTHORIZATION", "PASSWORD", "PW", "TOKEN"].toSorted(),
    );
    // the header names the placeholders, not values
    expect(result.yaml).toContain("# Secrets referenced:");
    expect(result.yaml).toContain("# DRAFT:");
    expect(result.yaml).toContain("Recorded against http://app.example.test");
  });

  it("takes the name and intent from the title, or from the options", () => {
    expect(spec.name).toBe("pays_with_a_card");
    expect(spec.intent).toBe("pays with a card");
    const named = importPlaywrightTrace(zipOf(syntheticTraceEntries(c)), {
      name: "Card checkout",
      intent: "A shopper pays with a card",
    });
    expect(named.spec.name).toBe("card_checkout");
    expect(named.spec.intent).toBe("A shopper pays with a card");
  });
});

describe("trace importer (errors)", () => {
  it("names what is wrong with an archive that is not a Playwright trace", () => {
    expect(() => importPlaywrightTrace(zipOf({ "readme.txt": "x" }))).toThrow(
      TraceFormatError,
    );
    expect(() => importPlaywrightTrace(Buffer.from("nope"))).toThrow(ZipError);
  });

  it("tolerates a truncated trailing line and still yields a valid draft", () => {
    const entries = syntheticTraceEntries(creds());
    entries["0-trace.trace"] += '\n{"type":"before","callId":"call@99","cl';
    const result = importPlaywrightTrace(zipOf(entries));
    expect(SpecSchema.safeParse(result.spec).success).toBe(true);
  });

  it("a trace with no recorded behavior gets a placeholder outcome and a TODO", () => {
    const result = importPlaywrightTrace(
      zipOf({
        "trace.trace": JSON.stringify({
          type: "context-options",
          version: 8,
          options: {},
        }),
      }),
    );
    expect(result.spec.outcomes[0]?.id).toBe("todo_assertion");
    expect(result.todos.join("\n")).toContain("replace placeholder outcome");
    expect(result.todos.join("\n")).toContain("intent is a placeholder");
  });
});

describe("trace importer (format version)", () => {
  it("flags a trace format version it was not checked against", () => {
    const entries = syntheticTraceEntries(creds());
    entries["0-trace.trace"] = entries["0-trace.trace"]!.replace(
      '"version":8',
      '"version":99',
    );
    // the synthetic context-options line carries no version; add one
    entries["0-trace.trace"] =
      '{"version":99,"type":"context-options","options":{}}\n' +
      entries["0-trace.trace"];
    const result = importPlaywrightTrace(zipOf(entries));
    expect(result.todos.join("\n")).toContain("trace format version 99");
  });
});
