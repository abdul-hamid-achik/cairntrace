/**
 * Tiny static + JSON server for the Cairntrace demo app.
 *
 * Run with:
 *   bun examples/demo-app/server.ts
 *
 * Listens on http://localhost:8787. Override the port with PORT=NNNN.
 *
 * Routes:
 *   /                  → index.html
 *   /dashboard.html    → static dashboard
 *   /api.html          → page that fetches /api/inventory
 *   /api-broken.html   → page that fetches /api/broken (returns 500)
 *   /api/inventory     → 200 JSON with three items
 *   /api/broken        → 500 JSON error
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);

const inventory = [
  { id: 1, name: "Apples", total: "$1.00" },
  { id: 2, name: "Bread", total: "$2.00" },
  { id: 3, name: "Cheese", total: "$5.00" },
];

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/inventory") {
      return Response.json({ items: inventory });
    }
    if (url.pathname === "/api/broken") {
      return Response.json({ error: "intentional 500 for the demo" }, { status: 500 });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(here, path));
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Cairntrace demo serving at http://localhost:${server.port}/`);
console.log(`  /                /api.html        /api-broken.html`);
console.log(`  /dashboard.html  /api/inventory   /api/broken`);
