import { describe, expect, it } from "vitest";
import { StepSchema } from "../schema/spec.v1";
import {
  callVars,
  findActionMatches,
  type ActionTemplate,
} from "./actionMatch";
import { matchWaitUrl } from "../locators";
import {
  applyConventions,
  guardSecrets,
  pathPattern,
  SecretLiteralError,
  stablePath,
  type ConventionContext,
  type RecordedEntry,
} from "./conventions";
import { looksLikePasswordField } from "./secrets";
import { assignStepIds, stepIdFor, toSnake } from "./stepIds";

const editField: ActionTemplate = {
  name: "edit_and_save_text_field",
  file: "/project/actions/edit_and_save_text_field.yml",
  steps: [
    {
      fill: {
        by: "label",
        name: "${vars.fieldLabel}",
        value: "${vars.fieldValue}",
      },
    },
    { click: { by: "role", role: "button", name: "Save" } },
  ],
  defaults: { fieldLabel: "Name" },
};

const openSettings: ActionTemplate = {
  name: "open_settings",
  file: "/project/actions/open_settings.yml",
  steps: [{ open: "/settings" }],
  defaults: {},
};

function ctx(extra: Partial<ConventionContext> = {}): ConventionContext {
  return {
    baseUrl: "http://app.test",
    configVars: { websiteValue: "https://acme.example.test" },
    actions: [editField, openSettings],
    secrets: [
      { value: "Very-Secret-42", placeholder: "${secrets.APP_PASSWORD}" },
    ],
    displayPath: (file) => file.replace("/project/", ""),
    ...extra,
  };
}

describe("findActionMatches", () => {
  it("binds ${vars.X} from recorded literals and compares names case-insensitively", () => {
    const matches = findActionMatches(
      [
        { open: "/profile" },
        { fill: { by: "label", name: "Website", value: "https://x.test" } },
        { click: { by: "role", role: "button", name: "save " } },
      ],
      [editField],
    );
    expect(matches).toEqual([
      expect.objectContaining({
        action: "edit_and_save_text_field",
        start: 1,
        end: 3,
        bindings: { fieldLabel: "Website", fieldValue: "https://x.test" },
        confidence: 0.9,
        applied: true,
      }),
    ]);
  });

  it("refuses a var bound to two different values and an exact-name mismatch", () => {
    const twice: ActionTemplate = {
      name: "type_twice",
      file: "/a.yml",
      steps: [
        { fill: { by: "label", name: "A", value: "${vars.v}" } },
        { fill: { by: "label", name: "B", value: "${vars.v}" } },
      ],
      defaults: {},
    };
    expect(
      findActionMatches(
        [
          { fill: { by: "label", name: "A", value: "one" } },
          { fill: { by: "label", name: "B", value: "two" } },
        ],
        [twice],
      ),
    ).toEqual([]);
    const exact: ActionTemplate = {
      ...twice,
      steps: [
        { click: { by: "role", role: "button", name: "Save", exact: true } },
        { click: { by: "role", role: "button", name: "Done", exact: true } },
      ],
    };
    expect(
      findActionMatches(
        [
          { click: { by: "role", role: "button", name: "save", exact: true } },
          { click: { by: "role", role: "button", name: "Done", exact: true } },
        ],
        [exact],
      ),
    ).toEqual([]);
  });

  it("reports one-step actions as candidates and matches open forms equivalently", () => {
    const [match] = findActionMatches(
      [{ open: { path: "/settings", waitUntil: "load" } }],
      [openSettings],
    );
    expect(match).toMatchObject({
      action: "open_settings",
      applied: false,
      confidence: 0.9,
      reason: "one-step action: reported, not replaced",
    });
  });

  it("passes only the vars that differ from what the action would read", () => {
    const vars = callVars(
      { bindings: { fieldLabel: "Name", fieldValue: "x", other: "y" } },
      editField,
      { other: "y" },
    );
    expect(vars).toEqual({ fieldValue: "x" });
  });
});

describe("applyConventions", () => {
  const entries: RecordedEntry[] = [
    {
      step: { open: "http://app.test/profile" },
      index: 2,
      urlBefore: "about:blank",
      urlAfter: "http://app.test/profile",
    },
    {
      step: {
        fill: {
          by: "label",
          name: "Website",
          value: "https://acme.example.test",
        },
      },
      index: 3,
      urlBefore: "http://app.test/profile",
      urlAfter: "http://app.test/profile",
    },
    {
      step: { click: { by: "role", role: "button", name: "Save" } },
      index: 4,
      urlBefore: "http://app.test/profile",
      urlAfter: "http://app.test/profile/42/done",
      mutations: [
        { method: "PATCH", path: "/api/profile/42", status: 204 },
        { method: "POST", path: "/api/audit", status: 201 },
      ],
    },
    {
      step: { click: { by: "role", role: "link", name: "Home" } },
      index: 5,
      urlBefore: "http://app.test/profile/42/done",
      urlAfter: "http://app.test/",
    },
  ];

  it("reuses actions, lifts vars, keeps URLs relative, adds waits, ids and template fields", () => {
    const result = applyConventions({
      entries,
      setupSteps: [{ use: "login" }],
      setupImports: ["/project/actions/login.yml"],
      ctx: ctx({
        template: {
          requires: { env: ["local"] },
          metadata: { tags: ["profile"] },
        },
      }),
      options: { tags: ["smoke"] },
    });
    expect(result.setupSteps).toEqual([{ id: "use_login", use: "login" }]);
    expect(result.steps).toEqual([
      {
        id: "open_profile",
        open: { path: "/profile", waitUntil: "networkidle" },
      },
      {
        id: "use_edit_and_save_text_field",
        use: {
          action: "edit_and_save_text_field",
          vars: { fieldLabel: "Website", fieldValue: "${vars.websiteValue}" },
        },
      },
      { id: "wait_url_profile", wait: { url: { includes: "/profile/" } } },
      { id: "click_home", click: { by: "role", role: "link", name: "Home" } },
      { id: "wait_load_networkidle", wait: { load: "networkidle" } },
    ]);
    for (const step of [...result.setupSteps, ...result.steps]) {
      expect(StepSchema.safeParse(step).success, JSON.stringify(step)).toBe(
        true,
      );
    }
    expect(result.imports).toEqual([
      "/project/actions/login.yml",
      "/project/actions/edit_and_save_text_field.yml",
    ]);
    expect(result.requires).toEqual({ env: ["local"] });
    expect(result.metadata).toEqual({ tags: ["profile", "smoke"] });
    expect(result.report.reusedActions).toEqual([
      expect.objectContaining({
        action: "login",
        source: "setup",
        applied: true,
      }),
      expect.objectContaining({
        action: "edit_and_save_text_field",
        file: "actions/edit_and_save_text_field.yml",
        source: "recorded",
        steps: [2, 3],
        confidence: 1,
        applied: true,
      }),
    ]);
    // Locations as written: the setup's use_login is steps[0].
    expect(result.report.liftedVars).toEqual([
      {
        where: "steps[2].use.vars.fieldValue",
        var: "websiteValue",
        value: "https://acme.example.test",
      },
    ]);
    // The save's PATCH was inside the reused action: reported, not guarded.
    expect(result.report.warnings.join(" ")).toContain("PATCH /api/profile/42");
  });

  it("guards a recorded save with a postcondition from the observed mutation", () => {
    const result = applyConventions({
      entries,
      setupSteps: [],
      setupImports: [],
      ctx: ctx(),
      options: { reuseActions: false, liftVars: false },
    });
    const save = result.steps.find((s) => s["id"] === "click_save");
    expect(save).toMatchObject({
      postcondition: {
        network: {
          method: "PATCH",
          urlContains: "/api/profile/",
          status: { below: 400 },
        },
      },
    });
    expect(StepSchema.safeParse(save).success).toBe(true);
    expect(result.report.warnings.join(" ")).toContain(
      "also caused POST /api/audit 201",
    );
    // Literal kept when lifting is off.
    expect(JSON.stringify(result.steps)).toContain("https://acme.example.test");
  });

  it("leaves page noise unguarded and reports an eval's mutation", () => {
    const result = applyConventions({
      entries: [
        {
          step: { open: "/x" },
          index: 1,
          mutations: [{ method: "POST", path: "/telemetry", status: 200 }],
        },
        {
          step: { eval: { js: "1" } },
          index: 2,
          mutations: [{ method: "POST", path: "/api/x", status: 200 }],
        },
      ],
      setupSteps: [],
      setupImports: [],
      ctx: ctx(),
    });
    expect(result.steps[0]).not.toHaveProperty("postcondition");
    expect(result.report.warnings.join(" ")).toContain(
      "steps[1] (eval) caused POST /api/x",
    );
    expect(result.report.warnings.join(" ")).not.toContain("telemetry");
  });

  it("does not lift a literal several config vars share", () => {
    const result = applyConventions({
      entries: [
        { step: { fill: { by: "label", name: "City", value: "Lisbon" } } },
      ],
      setupSteps: [],
      setupImports: [],
      ctx: ctx({ configVars: { homeCity: "Lisbon", officeCity: "Lisbon" } }),
    });
    expect(result.report.liftedVars).toEqual([]);
    expect(result.report.warnings.join(" ")).toContain("homeCity, officeCity");
  });

  it("writes known secrets as placeholders and refuses an unexplained password literal", () => {
    const placeheld = applyConventions({
      entries: [
        {
          step: {
            fill: { by: "label", name: "Password", value: "Very-Secret-42" },
          },
        },
      ],
      setupSteps: [],
      setupImports: [],
      ctx: ctx(),
    });
    expect(placeheld.steps[0]).toMatchObject({
      fill: { value: "${secrets.APP_PASSWORD}" },
    });
    expect(placeheld.report.secretsPlaceholdered).toEqual([
      { where: "steps[0].fill.value", placeholder: "${secrets.APP_PASSWORD}" },
    ]);

    const literal = {
      entries: [
        { step: { fill: { by: "label", name: "Password", value: "hunter2" } } },
      ],
      setupSteps: [],
      setupImports: [],
      ctx: ctx(),
    };
    expect(() => applyConventions(literal)).toThrow(SecretLiteralError);
    expect(() => applyConventions(literal)).toThrow(
      /password-type field \(name "Password"\)/,
    );
    const kept = applyConventions({
      ...literal,
      options: { refuseSecrets: false },
    });
    expect(kept.report.warnings.join(" ")).toContain("matches no known secret");

    expect(() =>
      guardSecrets({
        steps: [],
        setupSteps: [
          { use: { action: "login", vars: { password: "hunter2" } } },
        ],
        secrets: [],
        refuseSecrets: true,
      }),
    ).toThrow(/credential var "password"/);
    // A plain --path export (no refuseSecrets) keeps it with a warning.
    const plain = guardSecrets({
      steps: [{ fill: { by: "label", name: "Password", value: "hunter2" } }],
      setupSteps: [],
      secrets: [],
    });
    expect(plain.steps[0]).toMatchObject({ fill: { value: "hunter2" } });
    expect(plain.warnings.join(" ")).toContain("${vars.X}");
  });

  it("does not take a field about a credential for the credential", () => {
    for (const name of [
      "Token name",
      "API key name",
      "Secret question hint",
      "Pin to top",
      "Password hint",
      "Boarding pass",
    ]) {
      expect(looksLikePasswordField({ by: "label", name }), name).toBe(false);
    }
    for (const name of ["Access token", "API key", "PIN", "One-time code"]) {
      expect(looksLikePasswordField({ by: "label", name }), name).toBe(true);
    }
    const tokenName = applyConventions({
      entries: [
        { step: { fill: { by: "label", name: "Token name", value: "ci" } } },
      ],
      setupSteps: [],
      setupImports: [],
      ctx: ctx(),
    });
    expect(tokenName.steps[0]).toMatchObject({ fill: { value: "ci" } });
  });
});

describe("guardSecrets on journaled steps", () => {
  it("explains a value the journal redacted and warns about other redactions", () => {
    expect(() =>
      guardSecrets({
        steps: [
          { fill: { by: "label", name: "Password", value: "[redacted]" } },
        ],
        setupSteps: [],
        secrets: [],
        refuseSecrets: true,
      }),
    ).toThrow(/was redacted in the session journal/);
    const out = guardSecrets({
      steps: [
        {
          request: {
            url: "/api/x",
            headers: { Authorization: "[redacted]" },
          },
        },
      ],
      setupSteps: [],
      secrets: [],
    });
    expect(out.warnings).toEqual([
      'steps[0].request.headers.Authorization holds "[redacted]" (the session journal redacted it); replace it with a placeholder before running',
    ]);
  });
});

describe("helpers", () => {
  it("derives snake_case step ids and keeps them unique", () => {
    expect(stepIdFor({ click: { by: "testid", testid: "saveButton" } })).toBe(
      "click_save_button",
    );
    expect(stepIdFor({ open: "/users/42/edit" })).toBe("open_users_edit");
    expect(stepIdFor({ request: { method: "POST", url: "/api/items" } })).toBe(
      "request_post_api_items",
    );
    expect(
      stepIdFor({ press: "Enter", target: { by: "label", name: "Search" } }),
    ).toBe("press_enter_search");
    expect(toSnake("${vars.websiteValue} Field")).toBe("website_value_field");
    const { steps, added } = assignStepIds(
      [
        { id: "click_save", click: {} },
        { click: { by: "role", role: "button", name: "Save" } },
      ],
      new Set(),
    );
    expect(added).toBe(1);
    expect(steps[1]!["id"]).toBe("click_save_2");
  });

  it("keeps the stable prefix of an id-bearing path", () => {
    expect(stablePath("/api/answers/42/edit")).toBe("/api/answers/");
    expect(stablePath("http://app.test/a/b?x=1")).toBe("/a/b");
    expect(stablePath("/orders/5d9d1c2e3f4a5b6c7d8e9f01")).toBe("/orders/");
  });

  it("recognizes password-type fields", () => {
    expect(
      looksLikePasswordField({ by: "label", name: "Current password" }),
    ).toBe(true);
    expect(
      looksLikePasswordField({
        by: "selector",
        selector: "input[type=password]",
      }),
    ).toBe(true);
    expect(
      looksLikePasswordField({ by: "testid", testid: "loginPasswordInput" }),
    ).toBe(true);
    expect(looksLikePasswordField({ by: "label", name: "Website" })).toBe(
      false,
    );
    expect(
      looksLikePasswordField({ by: "selector", selector: "#passport-number" }),
    ).toBe(false);
  });
});

describe("navigation waits", () => {
  const crud: Array<[string, string]> = [
    ["/products/new", "/products/42"],
    ["/products/42", "/products/42/edit"],
    ["/products/42/edit", "/products/42"],
    ["/orders", "/orders/9f8e7d6c5b4a3f2e1d0c9b8a"],
    ["/profile", "/profile/42/done"],
  ];

  it.each(crud)(
    "writes a wait %s → %s that the URL before the click does not satisfy",
    (before, after) => {
      const result = applyConventions({
        entries: [
          {
            step: { click: { by: "role", role: "button", name: "Go" } },
            urlBefore: `http://app.test${before}`,
            urlAfter: `http://app.test${after}`,
          },
        ],
        setupSteps: [],
        setupImports: [],
        ctx: ctx({ actions: [] }),
      });
      const wait = result.steps[1]?.["wait"] as
        | { url: { includes?: string; pattern?: string } }
        | undefined;
      expect(wait?.url, JSON.stringify(result.steps)).toBeDefined();
      expect(StepSchema.safeParse(result.steps[1]).success).toBe(true);
      expect(matchWaitUrl(`http://app.test${before}`, wait!.url)).toBe(false);
      expect(matchWaitUrl(`http://app.test${after}`, wait!.url)).toBe(true);
      expect(matchWaitUrl(`http://app.test${after}?tab=1`, wait!.url)).toBe(
        true,
      );
    },
  );

  it("adds no wait (and says so) when no matcher tells the URLs apart", () => {
    const result = applyConventions({
      entries: [
        {
          step: { click: { by: "role", role: "link", name: "Next" } },
          urlBefore: "http://app.test/products/41",
          urlAfter: "http://app.test/products/42",
        },
      ],
      setupSteps: [],
      setupImports: [],
      ctx: ctx({ actions: [] }),
    });
    expect(result.steps).toHaveLength(1);
    expect(result.report.warnings.join(" ")).toContain(
      "steps[0] (click_next): click changed the page from /products/41 to /products/42",
    );
    expect(pathPattern("/products/42/edit")).toBe(
      "/products/\\d+/edit/?(?:[?#]|$)",
    );
  });
});

describe("var lifting", () => {
  it("lifts distinctive values and named matches, never locators, numbers or coincidences", () => {
    const result = applyConventions({
      entries: [
        { step: { fill: { by: "label", name: "Quantity", value: "3000" } } },
        { step: { fill: { by: "label", name: "Region", value: "local" } } },
        { step: { click: { by: "role", role: "button", name: "Save" } } },
        {
          step: {
            fill: {
              by: "label",
              name: "Email",
              value: "supplier@example.test",
            },
          },
        },
        { step: { fill: { by: "label", name: "City", value: "Lisbon" } } },
      ],
      setupSteps: [],
      setupImports: [],
      ctx: ctx({
        actions: [],
        configVars: {
          port: 3000,
          quantityText: "3000",
          envName: "local",
          saveLabel: "Save",
          supplierEmail: "supplier@example.test",
          homeCity: "Lisbon",
        },
      }),
    });
    expect(result.steps.map((s) => s["fill"] ?? s["click"])).toEqual([
      { by: "label", name: "Quantity", value: "3000" },
      { by: "label", name: "Region", value: "local" },
      { by: "role", role: "button", name: "Save" },
      { by: "label", name: "Email", value: "${vars.supplierEmail}" },
      { by: "label", name: "City", value: "${vars.homeCity}" },
    ]);
    expect(result.report.liftedVars.map((l) => [l.where, l.var])).toEqual([
      ["steps[3].fill.value", "supplierEmail"],
      ["steps[4].fill.value", "homeCity"],
    ]);
  });
});

describe("action reuse with env-backed defaults", () => {
  it("does not hardcode a default the action resolves from the environment", () => {
    const login: ActionTemplate = {
      name: "login",
      file: "/project/actions/login.yml",
      steps: [
        { open: "/login" },
        { fill: { by: "label", name: "Email", value: "${vars.email}" } },
        { click: { by: "role", role: "button", name: "Sign in" } },
      ],
      defaults: { email: "${env.SUPPLIER_EMAIL}" },
    };
    const run = (env: Record<string, string>) =>
      applyConventions({
        entries: [
          { step: { open: "/login" } },
          {
            step: {
              fill: {
                by: "label",
                name: "Email",
                value: "supplier@example.test",
              },
            },
          },
          { step: { click: { by: "role", role: "button", name: "Sign in" } } },
        ],
        setupSteps: [],
        setupImports: [],
        ctx: ctx({ actions: [login], configVars: {}, env }),
      });
    expect(run({ SUPPLIER_EMAIL: "supplier@example.test" }).steps[0]).toEqual({
      id: "use_login",
      use: "login",
    });
    // Another user than the environment's: the call passes it.
    expect(run({ SUPPLIER_EMAIL: "admin@example.test" }).steps[0]).toEqual({
      id: "use_login",
      use: { action: "login", vars: { email: "supplier@example.test" } },
    });
  });
});

describe("report locations", () => {
  it("name steps as the written file has them (setup first, waits included)", () => {
    const result = applyConventions({
      entries: [
        {
          step: { click: { by: "role", role: "link", name: "Profile" } },
          urlBefore: "http://app.test/home",
          urlAfter: "http://app.test/profile",
        },
        {
          step: {
            fill: { by: "label", name: "Password", value: "Very-Secret-42" },
          },
        },
        {
          step: {
            fill: {
              by: "label",
              name: "Website",
              value: "https://acme.example.test",
            },
          },
        },
      ],
      setupSteps: [{ use: "login" }],
      setupImports: [],
      ctx: ctx({ actions: [] }),
    });
    const written = [...result.setupSteps, ...result.steps];
    for (const item of [
      ...result.report.secretsPlaceholdered,
      ...result.report.liftedVars,
    ]) {
      const m = /^steps\[(\d+)\]\.(\w+)\.value$/.exec(item.where)!;
      expect(m, item.where).not.toBeNull();
      const step = written[Number(m[1])] as Record<string, { value: string }>;
      expect(step[m[2]!]!.value).toMatch(/^\$\{/);
    }
    expect(result.report.secretsPlaceholdered[0]!.where).toBe(
      "steps[3].fill.value",
    );
    expect(result.report.liftedVars[0]!.where).toBe("steps[4].fill.value");
  });
});
