/**
 * The renderer's DOM builder is browser code, but its one pure decision —
 * "is this second argument a props bag or a child?" — is exactly the decision
 * that silently emptied whole panels when wrong, so it gets a unit test.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

require("../lib/format"); // dom.js reads Studio.fmt off the global
require("../renderer/dom"); // renderer scripts publish onto window/globalThis
const dom = /** @type {any} */ (globalThis).Studio;

describe("isProps", () => {
  it("treats plain objects as props", () => {
    assert.equal(dom.isProps({ class: "panel" }), true);
    assert.equal(dom.isProps({}), true);
  });

  it("treats arrays, nodes, and primitives as children", () => {
    assert.equal(dom.isProps([]), false);
    assert.equal(dom.isProps([1, 2]), false);
    assert.equal(dom.isProps("text"), false);
    assert.equal(dom.isProps(42), false);
    assert.equal(dom.isProps(null), false);
    assert.equal(dom.isProps(undefined), false);
    assert.equal(dom.isProps(false), false);
  });

  it("treats DOM nodes as children when a DOM exists", () => {
    if (typeof Node === "undefined") return; // node:test has no DOM
    assert.equal(dom.isProps(document.createElement("div")), false);
  });
});
