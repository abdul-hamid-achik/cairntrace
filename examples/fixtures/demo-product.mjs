#!/usr/bin/env node
// Demo fixture helper: create, show or delete a catalog product through the
// demo platform's JSON API. Used by the `demo_product` exec fixture in
// examples/cairntrace.config.yml and by the `run:` steps of
// flows/platform/31-run-step-teardown.yml.
//
//   node demo-product.mjs create <sku> <stock> [name]   → {"sku","name","stock"}
//   node demo-product.mjs show <sku>                    → {"sku","name","stock"} (exit 1 when absent)
//   node demo-product.mjs delete <sku>                  → {"sku","deleted"}
//
// The base URL comes from CAIRN_BASE_URL (cairn sets it for fixtures and run
// steps). It signs in as the seeded demo operator; override the password with
// CAIRN_DEMO_PASSWORD. Progress goes to stderr: the last stdout line is the
// JSON result cairn reads.

const [verb, sku, stockArg, nameArg] = process.argv.slice(2);
const baseUrl = (process.env.CAIRN_BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const email = process.env.CAIRN_DEMO_EMAIL || "casey@cairntrace.dev";
const password = process.env.CAIRN_DEMO_PASSWORD || "cairn-demo-2026";

function fail(message) {
  console.error(`demo-product: ${message}`);
  process.exit(1);
}

async function signIn() {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) fail(`sign-in failed (${response.status})`);
  const cookie = response.headers.get("set-cookie");
  if (!cookie) fail("sign-in returned no session cookie");
  return cookie.split(";")[0];
}

async function find(target) {
  const response = await fetch(`${baseUrl}/api/products?sku=${encodeURIComponent(target)}`);
  if (!response.ok) fail(`product lookup failed (${response.status})`);
  const body = await response.json();
  return body.products?.[0];
}

if (!verb || !sku) fail("usage: demo-product.mjs create|show|delete <sku> [stock] [name]");

if (verb === "create") {
  const stock = Number(stockArg ?? 0);
  const name = nameArg || `Demo shelf bin ${sku}`;
  const cookie = await signIn();
  const response = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sku, name, category: "office", price: 4.5, stock }),
  });
  // Idempotent ensure: an existing product with this SKU is reused.
  if (response.status === 409) {
    const existing = await find(sku);
    if (!existing) fail(`sku ${sku} conflicts but cannot be read back`);
    console.error(`demo-product: reusing ${sku}`);
    console.log(JSON.stringify({ sku, name: existing.name, stock: existing.stock }));
  } else if (response.status === 201) {
    const { product } = await response.json();
    console.error(`demo-product: created ${sku}`);
    console.log(JSON.stringify({ sku, name: product.name, stock: product.stock }));
  } else {
    fail(`create failed (${response.status}): ${await response.text()}`);
  }
} else if (verb === "show") {
  const product = await find(sku);
  if (!product) fail(`no product ${sku}`);
  console.log(JSON.stringify({ sku, name: product.name, stock: product.stock }));
} else if (verb === "delete") {
  const cookie = await signIn();
  const response = await fetch(`${baseUrl}/api/products/${encodeURIComponent(sku)}`, {
    method: "DELETE",
    headers: { cookie },
  });
  if (!response.ok) fail(`delete failed (${response.status})`);
  const { deleted } = await response.json();
  console.error(`demo-product: deleted ${deleted} product(s) ${sku} (run status ${process.env.CAIRN_RUN_STATUS ?? "n/a"})`);
  console.log(JSON.stringify({ sku, deleted }));
} else {
  fail(`unknown verb ${verb}`);
}
