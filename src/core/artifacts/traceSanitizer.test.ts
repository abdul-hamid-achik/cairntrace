import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deflateRawSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
} from "node:zlib";
import { describe, expect, it } from "vitest";
import { createArtifactRedactor } from "./redaction";
import {
  detectTraceFormat,
  sanitizeTraceBytes,
  sanitizeTraceFile,
} from "./traceSanitizer";

const SECRET = "s3cr3t-session-value";
const redactor = createArtifactRedactor({ values: [SECRET] }, {});

/** A Playwright-shaped trace zip: network HAR entries, actions, resources. */
function playwrightTrace(): Buffer {
  const network = [
    {
      type: "resource-snapshot",
      snapshot: {
        request: {
          url: "https://app.example.test/api?token=abc123&page=2",
          headers: [
            { name: "Authorization", value: "Bearer eyJhbGciOi.payload.sig" },
            { name: "Cookie", value: "sid=abc; theme=dark" },
            { name: "Proxy-Authorization", value: "Basic dXNlcjpwYXNz" },
            { name: "X-Tenant-Key", value: "tenant-private-key" },
            { name: "Accept", value: "application/json" },
          ],
          cookies: [{ name: "sid", value: "abc", domain: "example.test" }],
        },
        response: {
          status: 200,
          headers: [{ name: "Set-Cookie", value: "sid=next; HttpOnly" }],
        },
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  const actions = [
    {
      type: "before",
      callId: "call@1",
      apiName: "locator.fill",
      params: { value: SECRET },
    },
    { type: "after", callId: "call@1" },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  return zip([
    ["trace.network", Buffer.from(network)],
    ["trace.trace", Buffer.from(actions)],
    ["resources/abc.json", Buffer.from('{"access_token":"tok-1","ok":true}')],
    ["resources/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])],
  ]);
}

describe("trace sanitizer", () => {
  it("rewrites credential headers, cookies and secrets inside a Playwright zip", () => {
    const { format, bytes } = sanitizeTraceBytes(playwrightTrace(), {
      redactor,
      sensitiveNames: ["X-Tenant-Key"],
    });
    expect(format).toBe("playwright-zip");
    const members = unzip(bytes);

    const network = JSON.parse(members.get("trace.network")!.toString());
    const headers = network.snapshot.request.headers as Array<{
      name: string;
      value: string;
    }>;
    const value = (name: string) => headers.find((h) => h.name === name)?.value;
    expect(value("Authorization")).toBe("[redacted]");
    expect(value("Cookie")).toBe("[redacted]");
    expect(value("Proxy-Authorization")).toBe("[redacted]");
    expect(value("X-Tenant-Key")).toBe("[redacted]");
    expect(value("Accept")).toBe("application/json");
    // Shape is preserved for the Trace Viewer: cookies stay an array.
    expect(Array.isArray(network.snapshot.request.cookies)).toBe(true);
    expect(network.snapshot.request.cookies[0].value).toBe("[redacted]");
    expect(network.snapshot.response.headers[0].value).toBe("[redacted]");
    expect(network.snapshot.request.url).toContain("token=[redacted]");
    expect(network.snapshot.request.url).toContain("page=2");

    const trace = members.get("trace.trace")!.toString();
    expect(trace).not.toContain(SECRET);
    expect(trace.split("\n")).toHaveLength(2);
    expect(members.get("resources/abc.json")!.toString()).toContain(
      '"access_token":"[redacted]"',
    );
    // Binary members are copied byte for byte.
    expect([...members.get("resources/logo.png")!]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3,
    ]);

    // Sanitizing twice is stable (a valid zip with valid CRCs comes out).
    const again = sanitizeTraceBytes(bytes, { redactor });
    expect(unzip(again.bytes).get("trace.network")!.toString()).toBe(
      members.get("trace.network")!.toString(),
    );
  });

  it("scrubs form bodies, OIDC params, custom auth headers, typed passwords and storage state", () => {
    // Shapes taken from a real Playwright 1.61 trace (snapshots + resources).
    const typed = "TYPEDPW_h7j8";
    const network = {
      type: "resource-snapshot",
      snapshot: {
        request: {
          url: "https://app.example.test/cb?id_token=IDTOKQ_v1w2&state=1#access_token=FRAG_9z",
          headers: [{ name: "X-Session", value: "XSESSION_k9l0" }],
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            text: "",
            params: [{ name: "client_secret", value: "CLIENTSECRET_p0o9" }],
          },
        },
      },
    };
    const actions = [
      {
        type: "context-options",
        options: {
          storageState: {
            cookies: [],
            origins: [
              {
                origin: "https://app.example.test",
                localStorage: [{ name: "persist:root", value: "LSJWT_eyJabc" }],
              },
            ],
          },
        },
      },
      {
        type: "before",
        callId: "call@3",
        method: "fill",
        params: { selector: "#pw", value: typed, timeout: 30000 },
      },
      { type: "log", callId: "call@3", message: `  - fill("${typed}")` },
      {
        type: "frame-snapshot",
        snapshot: {
          html: [
            "BODY",
            {},
            [
              "INPUT",
              { __playwright_value_: typed, id: "x", type: "password" },
            ],
            ["INPUT", { __playwright_value_: "", name: "user" }],
            ["INPUT", { __playwright_value_: "bob", name: "login" }],
          ],
        },
      },
      {
        type: "before",
        callId: "call@4",
        method: "fill",
        params: { selector: 'internal:label="One-time code"i', value: "4821" },
      },
    ];
    const { bytes } = sanitizeTraceBytes(
      zip([
        ["trace.network", Buffer.from(JSON.stringify(network))],
        [
          "trace.trace",
          Buffer.from(actions.map((a) => JSON.stringify(a)).join("\n")),
        ],
        [
          "resources/1a2a.dat",
          Buffer.from(
            "password=FORMPW_m3n4&client_secret=CLIENTSECRET_p0o9&SAMLResponse=PHNhbWw&user=bob",
          ),
        ],
        [
          "resources/req.json",
          Buffer.from(
            JSON.stringify({ body: '{"id_token":"IDTOK_body","x":1}' }),
          ),
        ],
      ]),
      { redactor },
    );
    const members = unzip(bytes);
    const all = [...members.values()].map((b) => b.toString()).join("\n");
    for (const leaked of [
      "IDTOKQ_v1w2",
      "FRAG_9z",
      "XSESSION_k9l0",
      "CLIENTSECRET_p0o9",
      "FORMPW_m3n4",
      "PHNhbWw",
      "LSJWT_eyJabc",
      typed,
      "4821",
      "IDTOK_body",
    ]) {
      expect(all).not.toContain(leaked);
    }
    expect(members.get("resources/1a2a.dat")!.toString()).toBe(
      "password=[redacted]&client_secret=[redacted]&SAMLResponse=[redacted]&user=bob",
    );
    const url = JSON.parse(members.get("trace.network")!.toString()).snapshot
      .request.url as string;
    expect(url).toContain("state=1");
    const lines = members
      .get("trace.trace")!
      .toString()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[1].params).toMatchObject({
      selector: "#pw",
      value: "[redacted]",
      timeout: 30000,
    });
    expect(lines[2].message).toBe('  - fill("[redacted]")');
    const html = lines[3].snapshot.html;
    const typedValue = (index: number) => html[index][1]["__playwright_value_"];
    expect(typedValue(2)).toBe("[redacted]");
    // Empty and non-secret inputs keep their value.
    expect(typedValue(3)).toBe("");
    expect(typedValue(4)).toBe("bob");
  });

  it("sanitizes agent-browser Chrome trace-event JSON, plain or gzipped", () => {
    const trace = {
      traceEvents: [
        {
          name: "ResourceSendRequest",
          args: {
            data: {
              url: "https://app.example.test/?api_key=k-1",
              headers: { authorization: "Bearer x", accept: "text/html" },
            },
          },
        },
        { name: "Log", args: { message: `typed ${SECRET}` } },
      ],
    };
    const plain = sanitizeTraceBytes(Buffer.from(JSON.stringify(trace)), {
      redactor,
    });
    expect(plain.format).toBe("chrome-trace-json");
    const parsed = JSON.parse(plain.bytes.toString());
    expect(parsed.traceEvents[0].args.data.headers.authorization).toBe(
      "[redacted]",
    );
    expect(parsed.traceEvents[0].args.data.headers.accept).toBe("text/html");
    expect(parsed.traceEvents[0].args.data.url).toContain("api_key=[redacted]");
    expect(JSON.stringify(parsed)).not.toContain(SECRET);

    const gz = sanitizeTraceBytes(
      gzipSync(Buffer.from(JSON.stringify(trace))),
      {
        redactor,
      },
    );
    expect(JSON.parse(gunzipSync(gz.bytes).toString())).toEqual(parsed);
  });

  it("detects a legacy agent-browser `.zip` that is really JSON", () => {
    expect(detectTraceFormat(Buffer.from('\n {"traceEvents":[]}'))).toBe(
      "chrome-trace-json",
    );
    expect(detectTraceFormat(playwrightTrace())).toBe("playwright-zip");
    expect(detectTraceFormat(Buffer.from("not a trace"))).toBeUndefined();
  });

  it("fails closed on an unreadable trace and leaves the file untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-trace-sanitize-"));
    const path = join(dir, "broken.zip");
    const broken = Buffer.concat([
      Buffer.from("PK\u0003\u0004"),
      Buffer.alloc(40),
    ]);
    await writeFile(path, broken);
    const result = await sanitizeTraceFile(path, { redactor });
    expect(result.ok).toBe(false);
    expect(await readFile(path)).toEqual(broken);
  });

  it("rewrites a trace file in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-trace-sanitize-"));
    const path = join(dir, "agent-browser-trace.json");
    await writeFile(
      path,
      JSON.stringify({ traceEvents: [{ args: { cookie: "sid=1" } }] }),
    );
    const result = await sanitizeTraceFile(path, { redactor });
    expect(result).toMatchObject({ ok: true, format: "chrome-trace-json" });
    expect(await readFile(path, "utf8")).toContain('"cookie":"[redacted]"');
  });
});

/* ----- tiny zip helpers (test-only) ----- */

function zip(entries: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function unzip(bytes: Buffer): Map<string, Buffer> {
  let end = bytes.length - 22;
  while (bytes.readUInt32LE(end) !== 0x06054b50) end--;
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extra = bytes.readUInt16LE(offset + 30);
    const comment = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString();
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    offset += 46 + nameLength + extra + comment;
  }
  return out;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++)
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
