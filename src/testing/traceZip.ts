import { deflateRawSync } from "node:zlib";

/**
 * A ZIP writer and a synthetic Playwright trace for the importer tests: the
 * same JSON-lines shapes a real trace has (checked against Playwright 1.61),
 * small enough to read in the test, with neutral names and no real hosts.
 */

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A ZIP of `entries` (deflated when `deflate`, else stored). */
export function zipOf(
  entries: Record<string, string | Buffer>,
  deflate = true,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

export interface SyntheticTraceInput {
  /** The credentials the trace "typed", built by the test at runtime. */
  password: string;
  token: string;
}

/** `{ name: lines.join("\n") }` for a small signed-in session. */
export function syntheticTraceEntries(
  input: SyntheticTraceInput,
): Record<string, string> {
  const base = "http://app.example.test";
  let call = 0;
  const events: unknown[] = [
    {
      version: 8,
      type: "context-options",
      origin: "library",
      browserName: "chromium",
      playwrightVersion: "1.61.1",
      options: { baseURL: base },
      testIdAttributeName: "data-qa",
      title: "shop.spec.ts:3 › checkout › pays with a card",
    },
  ];
  const before = (
    cls: string,
    method: string,
    params: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): string => {
    call += 2;
    const callId = `call@${call}`;
    events.push({
      type: "before",
      callId,
      class: cls,
      method,
      params,
      ...extra,
    });
    return callId;
  };
  const after = (callId: string, error?: string): void => {
    events.push({
      type: "after",
      callId,
      ...(error ? { error: { name: "Error", message: error } } : {}),
    });
  };
  const log = (callId: string, message: string): void => {
    events.push({ type: "log", callId, message });
  };
  const run = (
    cls: string,
    method: string,
    params: Record<string, unknown>,
    opts: {
      resolved?: string;
      error?: string;
      extra?: Record<string, unknown>;
    } = {},
  ): void => {
    const id = before(cls, method, params, opts.extra);
    if (opts.resolved) log(id, `  locator resolved to ${opts.resolved}`);
    after(id, opts.error);
  };

  run("Frame", "goto", {
    url: `${base}/login?next=/cart&access_token=${input.token}`,
    waitUntil: "load",
  });
  run(
    "Frame",
    "fill",
    { selector: 'internal:label="Email"i', value: "ada@example.test" },
    { extra: { stepId: "pw:api@2" } },
  );
  run(
    "Frame",
    "fill",
    { selector: "#pw", value: input.password },
    { resolved: '<input id="pw" type="password" name="pw"/>' },
  );
  run(
    "Frame",
    "click",
    { selector: "button.primary" },
    { resolved: '<button class="primary" type="submit">Sign in</button>' },
  );
  run(
    "Frame",
    "click",
    { selector: ".cart-link" },
    {
      resolved:
        '<a class="cart-link" data-qa="cart-link" href="/cart"><svg></svg></a>',
    },
  );
  run("Frame", "waitForSelector", {
    selector: "#cart-items",
    state: "visible",
    timeout: 5000,
  });
  run("Frame", "waitForTimeout", { waitTimeout: 150 });
  run("Frame", "queryCount", { selector: "li" });
  run(
    "Frame",
    "click",
    { selector: 'internal:text="Missing"i' },
    { error: "Timeout 30000ms exceeded" },
  );
  run("Frame", "press", { selector: 'internal:label="Email"i', key: "Enter" });
  run("Page", "keyboardType", { text: "typed raw" });
  run("Frame", "expect", {
    selector: 'internal:testid=[data-qa="total"s]',
    expression: "to.have.text",
    expectedText: [{ string: "Total: 12", normalizeWhiteSpace: true }],
    isNot: false,
  });
  run("Frame", "expect", {
    selector: "#cart-items li",
    expression: "to.have.count",
    expectedNumber: 2,
    isNot: false,
  });
  run("Frame", "expect", {
    expression: "to.have.url",
    expectedText: [{ regexSource: "\\/cart$", regexFlags: "" }],
    isNot: false,
  });
  run("APIRequestContext", "fetch", {
    url: `${base}/api/orders?token=${input.token}`,
    method: "POST",
    headers: [
      { name: "Authorization", value: `Bearer ${input.token}` },
      { name: "x-trace", value: "t1" },
      { name: "Content-Length", value: "30" },
    ],
    jsonData: JSON.stringify({ item: "widget", password: input.password }),
  });
  events.push({
    type: "frame-snapshot",
    snapshot: {
      isMainFrame: true,
      frameUrl: `${base}/cart`,
      snapshotName: "after@call@1",
    },
  });

  const resource = (
    method: string,
    url: string,
    status: number,
    type: string,
  ): unknown => ({
    type: "resource-snapshot",
    snapshot: {
      _resourceType: type,
      request: {
        method,
        url,
        headers: [{ name: "Authorization", value: `Bearer ${input.token}` }],
        postData: { text: `password=${input.password}` },
      },
      response: { status },
    },
  });
  const network = [
    resource("GET", `${base}/cart`, 200, "document"),
    resource("GET", `${base}/api/cart?session=${input.token}`, 200, "fetch"),
    resource("GET", `${base}/api/cart/4821?x=1`, 200, "xhr"),
    resource("POST", `${base}/api/orders`, 201, "fetch"),
    resource("OPTIONS", `${base}/api/orders`, 204, "fetch"),
    resource("GET", "https://tracker.example.test/pixel", 200, "fetch"),
  ];
  const stepTitles = [
    { version: 8, type: "context-options", origin: "testRunner", options: {} },
    {
      type: "before",
      callId: "test.step@1",
      stepId: "test.step@1",
      class: "Test",
      method: "test.step",
      title: "sign in",
    },
    {
      type: "before",
      callId: "pw:api@2",
      stepId: "pw:api@2",
      parentId: "test.step@1",
      class: "Test",
      method: "pw:api",
      title: "Fill email",
    },
  ];
  return {
    "0-trace.trace": events.map((e) => JSON.stringify(e)).join("\n"),
    "0-trace.network": network.map((e) => JSON.stringify(e)).join("\n"),
    "test.trace": stepTitles.map((e) => JSON.stringify(e)).join("\n"),
    "resources/a.json": '{"never":"read"}',
  };
}

export interface HostileTraceInput {
  /** A password the trace types, sends as basic auth and leaks in a selector. */
  password: string;
  /** A JWT-shaped token (query, fragment). */
  jwt: string;
  /** A 32-hex reset token (path segment). */
  resetToken: string;
  /** A numeric PIN (JSON number under a credential key). */
  pin: number;
}

/**
 * A trace that hides credentials everywhere an importer can trip: URL
 * user:password (same- and cross-origin), a fragment token, a JWT under a
 * non-credential query name, a failed call whose selector shows the password
 * before a later fill identifies it, a nested credential object, a numeric
 * PIN, a token path segment, an id-carrying final URL. All values come from
 * the caller (built at runtime): no secret-shaped literal lives here.
 */
export function hostileTraceEntries(
  input: HostileTraceInput,
): Record<string, string> {
  const base = "http://app.example.test";
  let n = 0;
  const events: unknown[] = [
    {
      version: 8,
      type: "context-options",
      origin: "library",
      browserName: "chromium",
      playwrightVersion: "1.61.1",
      options: { baseURL: base },
      title: "x.spec.ts:1 › hostile",
    },
  ];
  const run = (
    cls: string,
    method: string,
    params: Record<string, unknown>,
    opts: { resolved?: string; error?: string } = {},
  ): void => {
    n += 2;
    const callId = `call@${n}`;
    events.push({ type: "before", callId, class: cls, method, params });
    if (opts.resolved)
      events.push({
        type: "log",
        callId,
        message: `  locator resolved to ${opts.resolved}`,
      });
    events.push({
      type: "after",
      callId,
      ...(opts.error ? { error: { name: "Error", message: opts.error } } : {}),
    });
  };
  const pw = input.password;
  run("Frame", "goto", {
    url: `https://admin:${pw}@idp.example.test/login`,
    waitUntil: "load",
  });
  run("Frame", "goto", {
    url: `${base}/callback#access_token=${input.jwt}&state=x`,
    waitUntil: "load",
  });
  // a failed click shows the password before the fill below identifies it
  run(
    "Frame",
    "click",
    { selector: `internal:text="${pw}"i` },
    { error: "Timeout" },
  );
  // a successful one too: its step id would carry it
  run(
    "Frame",
    "click",
    { selector: `internal:text="${pw}"i` },
    { resolved: `<span>${pw}</span>` },
  );
  run(
    "Frame",
    "fill",
    { selector: "#pw", value: pw },
    { resolved: '<input id="pw" type="password" name="pw"/>' },
  );
  run(
    "Frame",
    "fill",
    { selector: 'internal:label="Mot de passe"i', value: `Autre-${pw}` },
    { resolved: '<input id="mdp" type="text"/>' },
  );
  run("Frame", "fill", {
    selector: 'internal:label="Code"i',
    value: input.jwt,
  });
  run("APIRequestContext", "fetch", {
    url: `${base}/api/me?jwt=${input.jwt}`,
    method: "POST",
    headers: [
      { name: "X-CSRFToken", value: `csrf-${pw}` },
      { name: "x-trace", value: "t1" },
      { name: "x-request-sig", value: input.jwt },
    ],
    jsonData: JSON.stringify({
      auth: { value: `body-${pw}`, nested: { deeper: `deep-${pw}` } },
      pin: input.pin,
      note: input.resetToken,
    }),
  });
  run("APIRequestContext", "fetch", {
    url: `https://svc:${pw}@api.other.test/v1/x`,
    method: "GET",
    headers: [],
  });
  run("APIRequestContext", "fetch", {
    url: `https://${input.jwt}@git.other.test/repo`,
    method: "GET",
    headers: [],
  });
  run("Frame", "goto", {
    url: `${base}/reset-password/${input.resetToken}`,
    waitUntil: "load",
  });
  run("Frame", "goto", { url: `${base}/#${input.jwt}`, waitUntil: "load" });
  run(
    "Frame",
    "goto",
    { url: `https://user:${pw}@idp.example.test/fail?token=${input.jwt}` },
    { error: "net::ERR_FAILED" },
  );
  run("Frame", "expect", {
    expression: "to.have.url",
    expectedText: [{ string: `${base}/done#id_token=${input.jwt}` }],
    isNot: false,
  });
  events.push({
    type: "frame-snapshot",
    snapshot: {
      isMainFrame: true,
      frameUrl: `${base}/orders/4821/confirmation`,
      snapshotName: "after@x",
    },
  });
  return {
    "0-trace.trace": events.map((e) => JSON.stringify(e)).join("\n"),
    "0-trace.network": "",
  };
}

/**
 * A trace with NO credential that trips loose secret heuristics: words that
 * contain a credential word (`Compass`, `Passenger`, `tokenizer`,
 * `secretary`, `token_count`), an `x-session-locale` header whose short value
 * also sits in the title and URLs, a commit SHA / avatar digest / request id
 * that are hex, a REST collection (`/api/tokens/<id>`) and an e-mail
 * `signature`. A faithful importer rewrites none of it.
 */
export function benignTraceEntries(): Record<string, string> {
  const base = "http://app.example.test";
  let n = 0;
  const events: unknown[] = [
    {
      version: 8,
      type: "context-options",
      origin: "library",
      browserName: "chromium",
      playwrightVersion: "1.61.1",
      options: { baseURL: base },
      title: "x.spec.ts:1 › checkout en-US flow",
    },
  ];
  const run = (
    cls: string,
    method: string,
    params: Record<string, unknown>,
    resolved?: string,
  ): void => {
    n += 2;
    const callId = `call@${n}`;
    events.push({ type: "before", callId, class: cls, method, params });
    if (resolved)
      events.push({
        type: "log",
        callId,
        message: `  locator resolved to ${resolved}`,
      });
    events.push({ type: "after", callId });
  };
  run("Frame", "goto", { url: `${base}/en-US/products`, waitUntil: "load" });
  run("APIRequestContext", "fetch", {
    url: `${base}/api/cart`,
    method: "GET",
    headers: [{ name: "x-session-locale", value: "en-US" }],
  });
  run(
    "Frame",
    "fill",
    { selector: 'internal:label="Compass heading"i', value: "north" },
    '<input id="ch" type="text"/>',
  );
  run("Frame", "click", {
    selector: 'internal:role=link[name="North America"i]',
  });
  run("Frame", "goto", {
    url: `${base}/en-US/regions/northwest`,
    waitUntil: "load",
  });
  run("Frame", "goto", { url: `${base}/passwords-policy`, waitUntil: "load" });
  run("Frame", "goto", {
    url: `${base}/commit/4f3c2a1b9e8d7c6b5a49382716f5e4d3c2b1a090`,
    waitUntil: "load",
  });
  run("Frame", "goto", { url: `${base}/api/tokens/abc12345` });
  run("Frame", "goto", {
    url: `${base}/avatar/205e460b479e2e5b48aec07710c08d50`,
  });
  run(
    "Frame",
    "fill",
    { selector: 'internal:label="Passenger count"i', value: "2" },
    '<input id="pc" type="number"/>',
  );
  run(
    "Frame",
    "fill",
    { selector: "#tokenizer", value: "bpe" },
    '<input id="tokenizer" type="text"/>',
  );
  run("APIRequestContext", "fetch", {
    url: `${base}/api/v2/model?q=password+reset+help&token_count=5`,
    method: "POST",
    headers: [
      { name: "x-request-id", value: "9f8e7d6c5b4a39281706f5e4d3c2b1a0" },
      { name: "x-session-locale", value: "en" },
    ],
    jsonData: JSON.stringify({
      tokenizer: "bpe",
      passengers: 2,
      secretary: "Jane Doe",
      author: "Ann",
      bypassCache: true,
      signature: "Regards, Ann",
      max_tokens: 64,
    }),
  });
  return {
    "0-trace.trace": events.map((e) => JSON.stringify(e)).join("\n"),
    "0-trace.network": "",
  };
}

/** A test-runner trace whose step parent links form a cycle. */
export function cyclicTraceEntries(): Record<string, string> {
  const lines = [
    { version: 8, type: "context-options", origin: "library", options: {} },
  ];
  const steps = [
    { version: 8, type: "context-options", origin: "testRunner", options: {} },
    {
      type: "before",
      callId: "a",
      stepId: "a",
      parentId: "b",
      class: "Test",
      method: "pw:api",
      title: "A",
    },
    {
      type: "before",
      callId: "b",
      stepId: "b",
      parentId: "a",
      class: "Test",
      method: "pw:api",
      title: "B",
    },
  ];
  return {
    "0-trace.trace": lines.map((e) => JSON.stringify(e)).join("\n"),
    "test.trace": steps.map((e) => JSON.stringify(e)).join("\n"),
  };
}
