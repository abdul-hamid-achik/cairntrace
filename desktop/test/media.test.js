/**
 * cairn-artifact:// streaming: opaque tokens only, byte ranges for seeking.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const media = require("../lib/media");
const { cleanup, tempDir } = require("./helpers");

after(cleanup);

/** @param {string} url @param {Record<string, string>} [headers] */
const request = (url, headers = {}) => ({ url, headers: new Headers(headers) });

describe("parseRange", () => {
  it("parses open, closed, and suffix ranges", () => {
    assert.deepEqual(media.parseRange("bytes=0-", 100), { start: 0, end: 99 });
    assert.deepEqual(media.parseRange("bytes=10-19", 100), {
      start: 10,
      end: 19,
    });
    assert.deepEqual(media.parseRange("bytes=-10", 100), {
      start: 90,
      end: 99,
    });
    assert.deepEqual(media.parseRange("bytes=50-500", 100), {
      start: 50,
      end: 99,
    });
    assert.equal(media.parseRange(null, 100), null);
    assert.equal(media.parseRange("bytes=200-", 100), "unsatisfiable");
  });
});

describe("media handler", () => {
  const dir = tempDir("cairn-media-");
  const file = path.join(dir, "run.webm");
  fs.writeFileSync(file, Buffer.from("0123456789"));
  const registry = media.createMediaRegistry();
  const handler = media.createMediaHandler(registry);

  it("serves a registered file, whole and by range", async () => {
    const url = registry.register(file);
    assert.match(url, /^cairn-artifact:\/\/media\/[0-9a-f]{32}$/);
    assert.equal(registry.register(file), url, "same file, same token");
    const whole = await handler(request(url));
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "video/webm");
    assert.equal(await whole.text(), "0123456789");
    const part = await handler(request(url, { range: "bytes=2-4" }));
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 2-4/10");
    assert.equal(await part.text(), "234");
    const bad = await handler(request(url, { range: "bytes=50-" }));
    assert.equal(bad.status, 416);
  });

  it("404s unknown tokens, other hosts, and anything path-shaped", async () => {
    for (const url of [
      `cairn-artifact://media/${"0".repeat(32)}`,
      `cairn-artifact://other/${"0".repeat(32)}`,
      `cairn-artifact://media/..%2F..%2Fetc%2Fhosts`,
      "cairn-artifact://media/",
    ])
      assert.equal((await handler(request(url))).status, 404, url);
  });

  it("evicts the oldest tokens past the bound", () => {
    const small = media.createMediaRegistry({ max: 8 });
    const urls = [];
    for (let index = 0; index < 10; index += 1)
      urls.push(small.register(path.join(dir, `f${index}`)));
    assert.equal(small.size(), 8);
    assert.equal(small.resolve(urls[0].split("/").pop()), null);
    assert.equal(small.resolve(urls[9].split("/").pop()), path.join(dir, "f9"));
  });
});
