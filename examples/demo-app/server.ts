/**
 * Cairntrace demo platform server.
 *
 * Two halves:
 *  1. The original tiny static smoke app (index/dashboard/api/import pages,
 *     /api/inventory, /api/broken, /template.xlsx) — kept byte-compatible so
 *     the numbered smoke specs keep working.
 *  2. A small DB-backed inventory platform (Postgres via Drizzle) exercising
 *     login, forms, uploads/downloads, and JSON APIs for the platform specs.
 *
 * Run with:
 *   bun examples/demo-app/server.ts
 *
 * Listens on http://localhost:8787 (PORT overrides). DATABASE_URL defaults to
 * the docker-compose service in examples/docker-compose.yaml (localhost:5433).
 * The DB is contacted lazily per request; while Postgres is still starting the
 * DB routes answer 503 "database starting" instead of crashing (cairn starts
 * the webServer before the services block brings the database up).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { documents, products, users } from "./db/schema";
import { verifyPassword } from "./db/seed";
import { makeWorkbook } from "./xlsx";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const SESSION_COOKIE = "cairn_demo_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const SESSION_SECRET =
  process.env.DEMO_SESSION_SECRET ?? "cairn-demo-session-secret-0123456789ab";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const CATEGORIES = ["office", "electronics", "kitchen"] as const;
const DOC_TYPES = ["invoice", "report", "photo", "other"] as const;

// Legacy static inventory for the original smoke specs (01-12).
const inventory = [
  { id: 1, name: "Apples", total: "$1.00" },
  { id: 2, name: "Bread", total: "$2.00" },
  { id: 3, name: "Cheese", total: "$5.00" },
];

type User = { id: string; email: string; name: string; passwordHash: string };

function sign(payload: string): string {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}

function sessionToken(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function parseSessionToken(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const expSep = raw.lastIndexOf(".");
  if (expSep <= 0) {
    return null;
  }
  const payload = raw.slice(0, expSep);
  const given = raw.slice(expSep + 1);
  const expected = sign(payload);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  const [userId, expRaw] = payload.split(".");
  if (!userId || !expRaw || !/^\d+$/.test(expRaw)) {
    return null;
  }
  if (Number(expRaw) * 1000 <= Date.now()) {
    return null;
  }
  return userId;
}

function sessionUserId(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return parseSessionToken(match?.[1]);
}

async function currentUser(req: Request): Promise<User | null> {
  const userId = sessionUserId(req);
  if (!userId) {
    return null;
  }
  try {
    const [row] = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title: string, body: string, nav = true): Response {
  const navHtml = nav
    ? `<nav style="margin-bottom:1.5rem">
         <a href="/products.html">Products</a> ·
         <a href="/documents.html">Documents</a> ·
         <a href="/form-controls.html">Form controls</a> ·
         <a href="/dashboard.html">Smoke dashboard</a>
       </nav>`
    : "";
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${esc(title)}</title>
    <style>
      body { font: 16px system-ui, sans-serif; max-width: 760px; margin: 3rem auto; padding: 0 1rem; color: #222; }
      header { border-bottom: 1px solid #ddd; padding-bottom: 1rem; margin-bottom: 1rem; }
      table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
      th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #eee; }
      th { background: #f8f8f8; }
      label { display: block; margin-top: 1rem; font-weight: 600; }
      input, select { display: block; margin-top: 0.25rem; padding: 0.4rem; font: inherit; width: 24ch; }
      input[type="file"] { width: auto; }
      button { margin-top: 1.25rem; padding: 0.55rem 1.1rem; background: #1e7e34; color: #fff; border: 0; border-radius: 4px; font: inherit; cursor: pointer; }
      button:hover { background: #155724; }
      .flash { padding: 0.6rem 0.9rem; background: #e8f5e9; border: 1px solid #1e7e34; border-radius: 4px; margin-top: 1rem; }
      .error { padding: 0.6rem 0.9rem; background: #fdecea; border: 1px solid #b3261e; border-radius: 4px; margin-top: 1rem; }
      .filters a { margin-right: 0.75rem; }
      img.thumb { max-width: 120px; max-height: 120px; display: block; margin-top: 0.5rem; border: 1px solid #ddd; }
      form { margin-bottom: 2rem; }
    </style>
  </head>
  <body>
    <header>
      <h1>${esc(title)}</h1>
      ${navHtml}
    </header>
    <main>
${body}
    </main>
    <script>
      // intentionally quiet — no console errors
    </script>
  </body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function dbUnavailable(): Response {
  return new Response("database starting — try again shortly", { status: 503 });
}

function loginRedirect(next: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `/login.html?next=${encodeURIComponent(next)}` },
  });
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function renderProducts(url: URL): Promise<Response> {
  const category = url.searchParams.get("category");
  const flash = url.searchParams.get("created");
  let rows: Array<typeof products.$inferSelect>;
  try {
    rows = await getDb().select().from(products).orderBy(products.sku);
  } catch {
    return dbUnavailable();
  }
  const filtered = category ? rows.filter((row) => row.category === category) : rows;
  const chips = ["all", ...CATEGORIES]
    .map(
      (c) =>
        `<a href="${c === "all" ? "/products.html" : `/products.html?category=${c}`}"${category === c || (!category && c === "all") ? ' aria-current="true" style="font-weight:700"' : ""}>${c}</a>`,
    )
    .join(" ");
  const body = `
      ${flash ? `<p class="flash" data-testid="flash">Product created: ${esc(flash)}</p>` : ""}
      <p class="filters" aria-label="Category filters">${chips}</p>
      <p>
        <a href="/products/new.html">Add a product</a> ·
        <a role="button" href="/export/products.csv" download>Export CSV</a> ·
        <a role="button" href="/export/products.xlsx" download>Export XLSX</a>
      </p>
      <table aria-label="Products">
        <thead>
          <tr><th>SKU</th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th></tr>
        </thead>
        <tbody>
          ${
            filtered.length === 0
              ? `<tr><td colspan="5" data-testid="empty-products">No products in this category</td></tr>`
              : filtered
                  .map(
                    (row) => `
            <tr data-testid="product-row">
              <td>${esc(row.sku)}</td>
              <td>${esc(row.name)}</td>
              <td>${esc(row.category)}</td>
              <td>${money(row.priceCents)}</td>
              <td>${row.stock}</td>
            </tr>`,
                  )
                  .join("")
          }
        </tbody>
      </table>`;
  return page("Products", body);
}

function renderNewProduct(url: URL, error?: string, values?: Record<string, string>): Response {
  const opts = CATEGORIES.map(
    (c) => `<option value="${c}"${values?.category === c ? " selected" : ""}>${c}</option>`,
  ).join("");
  const v = (key: string) => esc(values?.[key] ?? "");
  const body = `
      ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
      <form method="post" action="/products" data-testid="product-form">
        <label for="name">Product name</label>
        <input id="name" name="name" data-testid="product-name" required minlength="2" maxlength="120" value="${v("name")}" />
        <label for="sku">SKU</label>
        <input id="sku" name="sku" data-testid="product-sku" required maxlength="40" value="${v("sku")}" />
        <label for="category">Category</label>
        <select id="category" name="category" data-testid="product-category">${opts}</select>
        <label for="price">Price (USD)</label>
        <input id="price" name="price" type="number" min="0" step="0.01" required data-testid="product-price" value="${v("price")}" />
        <label for="stock">Stock</label>
        <input id="stock" name="stock" type="number" min="0" step="1" required data-testid="product-stock" value="${v("stock")}" />
        <button type="submit" data-testid="product-submit">Create product</button>
      </form>`;
  return page("New product", body);
}

async function renderDocuments(url: URL, user: User): Promise<Response> {
  const uploaded = url.searchParams.get("uploaded");
  let rows: Array<typeof documents.$inferSelect>;
  try {
    rows = await getDb().select().from(documents).orderBy(documents.createdAt);
  } catch {
    return dbUnavailable();
  }
  const typeOpts = DOC_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
  const body = `
      ${uploaded ? `<p class="flash" data-testid="flash">Document uploaded</p>` : ""}
      <p>Signed in as <strong>${esc(user.name)}</strong> (${esc(user.email)}) ·
         <form method="post" action="/logout" style="display:inline"><button type="submit" style="margin:0;padding:0 0.4rem;font-size:0.9em">Sign out</button></form>
      </p>
      <form method="post" action="/documents" enctype="multipart/form-data" data-testid="upload-form">
        <label for="doc-type">Document type</label>
        <select id="doc-type" name="docType" data-testid="document-type">${typeOpts}</select>
        <label for="doc-file">Choose file</label>
        <input id="doc-file" name="file" type="file" data-testid="document-file" required />
        <button type="submit" data-testid="document-submit">Upload document</button>
      </form>
      <table aria-label="Documents">
        <thead>
          <tr><th>Filename</th><th>Type</th><th>Size</th><th>Uploaded by</th><th>Preview</th><th></th></tr>
        </thead>
        <tbody>
          ${
            rows.length === 0
              ? `<tr><td colspan="6" data-testid="empty-documents">No documents yet</td></tr>`
              : rows
                  .map(
                    (row) => `
            <tr data-testid="document-row">
              <td>${esc(row.filename)}</td>
              <td>${esc(row.docType)}</td>
              <td>${(row.sizeBytes / 1024).toFixed(1)} KB</td>
              <td>${esc(row.uploadedBy ?? "")}</td>
              <td>${
                row.mimeType.startsWith("image/")
                  ? `<img class="thumb" alt="${esc(row.filename)}" src="/documents/${row.id}/preview" />`
                  : ""
              }</td>
              <td><a href="/documents/${row.id}/download" aria-label="Download ${esc(row.filename)} as ${esc(row.docType)}">Download ${esc(row.filename)}</a></td>
            </tr>`,
                  )
                  .join("")
          }
        </tbody>
      </table>`;
  return page("Documents", body);
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join("\n");
}

async function handleProductCreate(req: Request, url: URL): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const name = (form.get("name") ?? "").trim();
  const sku = (form.get("sku") ?? "").trim();
  const category = form.get("category") ?? "";
  const price = Number(form.get("price"));
  const stock = Number(form.get("stock"));
  const values = { name, sku, category, price: form.get("price") ?? "", stock: form.get("stock") ?? "" };
  if (name.length < 2 || !sku || !CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    return renderNewProduct(url, "Name, SKU, and a valid category are required", values);
  }
  if (!Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
    return renderNewProduct(url, "Price and stock must be non-negative numbers", values);
  }
  try {
    await getDb().insert(products).values({
      sku,
      name,
      category,
      priceCents: Math.round(price * 100),
      stock,
    });
  } catch (error) {
    if (errorText(error).includes("products_sku_unique")) {
      return renderNewProduct(url, `SKU already exists: ${sku}`, values);
    }
    return dbUnavailable();
  }
  return new Response(null, {
    status: 303,
    headers: { location: `/products.html?created=${encodeURIComponent(sku)}` },
  });
}

async function handleDocumentUpload(req: Request, user: User): Promise<Response> {
  const form = await req.formData();
  const docType = String(form.get("docType") ?? "");
  const file = form.get("file");
  if (!DOC_TYPES.includes(docType as (typeof DOC_TYPES)[number]) || !(file instanceof File)) {
    return new Response("A known document type and a file are required", { status: 422 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return new Response("The file is empty", { status: 422 });
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return new Response("The file exceeds the 10 MB limit", { status: 422 });
  }
  await getDb().insert(documents).values({
    filename: file.name || "unnamed",
    mimeType: file.type || "application/octet-stream",
    sizeBytes: bytes.byteLength,
    docType,
    uploadedBy: user.name,
    contentHex: bytes.toString("hex"),
  });
  return new Response(null, {
    status: 303,
    headers: { location: "/documents.html?uploaded=1" },
  });
}

async function serveDocumentFile(
  id: string,
  disposition: "attachment" | "inline",
): Promise<Response> {
  try {
    const [row] = await getDb().select().from(documents).where(eq(documents.id, id)).limit(1);
    if (!row) {
      return new Response("Not found", { status: 404 });
    }
    const bytes = Buffer.from(row.contentHex, "hex");
    return new Response(bytes, {
      headers: {
        "content-type": row.mimeType,
        "content-disposition": `${disposition}; filename="${row.filename}"`,
      },
    });
  } catch {
    return dbUnavailable();
  }
}

async function handleLogin(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  let email = "";
  let password = "";
  let next = "/products.html";
  if (contentType.includes("application/json")) {
    const body = (await req.json()) as { email?: string; password?: string };
    email = body.email ?? "";
    password = body.password ?? "";
  } else {
    const form = new URLSearchParams(await req.text());
    email = form.get("email") ?? "";
    password = form.get("password") ?? "";
    const requested = form.get("next");
    if (requested?.startsWith("/")) {
      next = requested;
    }
  }
  let user: User | undefined;
  try {
    [user] = await getDb()
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
  } catch {
    return dbUnavailable();
  }
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    if (contentType.includes("application/json")) {
      return Response.json({ error: "invalid_credentials" }, { status: 401 });
    }
    return new Response(null, {
      status: 303,
      headers: { location: "/login.html?error=1" },
    });
  }
  const cookie = `${SESSION_COOKIE}=${sessionToken(user.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
  if (contentType.includes("application/json")) {
    return Response.json(
      { user: { email: user.email, name: user.name } },
      { headers: { "set-cookie": cookie } },
    );
  }
  return new Response(null, {
    status: 303,
    headers: { location: next, "set-cookie": cookie },
  });
}

async function apiStats(): Promise<Response> {
  try {
    const db = getDb();
    const allProducts = await db.select().from(products);
    const allDocuments = await db.select().from(documents);
    const allUsers = await db.select().from(users);
    return Response.json({
      products: allProducts.length,
      electronics: allProducts.filter((row) => row.category === "electronics").length,
      categories: [...new Set(allProducts.map((row) => row.category))].sort(),
      documents: allDocuments.length,
      users: allUsers.length,
    });
  } catch {
    return Response.json({ error: "database unavailable" }, { status: 503 });
  }
}

async function apiHealth(): Promise<Response> {
  try {
    const rows = await getDb().select().from(products).limit(1);
    return Response.json({ status: "ok", database: "up", seeded: rows.length > 0 });
  } catch {
    return Response.json({ status: "ok", database: "down", seeded: false });
  }
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- legacy smoke routes (specs 01-12) -------------------------------
    if (path === "/api/inventory") {
      return Response.json({ items: inventory });
    }
    if (path === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }
    if (path === "/api/broken") {
      return Response.json({ error: "intentional 500 for the demo" }, { status: 500 });
    }
    if (path === "/api/import-preview" && req.method === "POST") {
      const bytes = (await req.arrayBuffer()).byteLength;
      return Response.json({ accepted: true, bytes });
    }
    if (path === "/template.xlsx") {
      return new Response(makeTemplateWorkbook(), {
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": 'attachment; filename="template.xlsx"',
        },
      });
    }

    // --- platform API -----------------------------------------------------
    if (path === "/api/health") {
      return apiHealth();
    }
    if (path === "/api/stats") {
      return apiStats();
    }
    if (path === "/api/session") {
      const user = await currentUser(req);
      if (!user) {
        return Response.json({ error: "unauthenticated" }, { status: 401 });
      }
      return Response.json({ user: { email: user.email, name: user.name } });
    }
    if (path === "/api/login" && req.method === "POST") {
      return handleLogin(req);
    }
    if (path === "/api/products") {
      try {
        const category = url.searchParams.get("category");
        const rows = await getDb().select().from(products).orderBy(products.sku);
        const filtered = category ? rows.filter((row) => row.category === category) : rows;
        return Response.json({ products: filtered, total: filtered.length });
      } catch {
        return Response.json({ error: "database unavailable" }, { status: 503 });
      }
    }

    // --- platform exports ---------------------------------------------------
    if (path === "/export/products.csv") {
      try {
        const category = url.searchParams.get("category");
        const rows = await getDb().select().from(products).orderBy(products.sku);
        const filtered = category ? rows.filter((row) => row.category === category) : rows;
        const csv = [
          "sku,name,category,price,stock",
          ...filtered.map(
            (row) => `${row.sku},"${row.name.replaceAll('"', '""')}",${row.category},${money(row.priceCents)},${row.stock}`,
          ),
        ].join("\n");
        return new Response(csv, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="products.csv"',
          },
        });
      } catch {
        return dbUnavailable();
      }
    }
    if (path === "/export/products.xlsx") {
      try {
        const rows = await getDb().select().from(products).orderBy(products.sku);
        const workbook = makeWorkbook([
          {
            name: "Products",
            rows: [
              ["SKU", "Name", "Category", "Price (USD)", "Stock"],
              ...rows.map((row) => [
                row.sku,
                row.name,
                row.category,
                row.priceCents / 100,
                row.stock,
              ]),
            ],
            validations: { E: "whole" },
          },
        ]);
        return new Response(workbook, {
          headers: {
            "content-type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-disposition": 'attachment; filename="products.xlsx"',
          },
        });
      } catch {
        return dbUnavailable();
      }
    }

    // --- platform pages -----------------------------------------------------
    if (path === "/products.html" && req.method === "GET") {
      return renderProducts(url);
    }
    if (path === "/products/new.html" && req.method === "GET") {
      const user = await currentUser(req);
      if (!user) {
        return loginRedirect("/products/new.html");
      }
      return renderNewProduct(url);
    }
    if (path === "/products" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        return loginRedirect("/products/new.html");
      }
      return handleProductCreate(req, url);
    }
    if (path === "/documents.html" && req.method === "GET") {
      const user = await currentUser(req);
      if (!user) {
        return loginRedirect("/documents.html");
      }
      return renderDocuments(url, user);
    }
    if (path === "/documents" && req.method === "POST") {
      const user = await currentUser(req);
      if (!user) {
        return loginRedirect("/documents.html");
      }
      try {
        return await handleDocumentUpload(req, user);
      } catch {
        return new Response("Upload failed", { status: 422 });
      }
    }
    const docMatch = path.match(/^\/documents\/([0-9a-f-]+)\/(download|preview)$/);
    if (docMatch) {
      const user = await currentUser(req);
      if (!user) {
        return loginRedirect("/documents.html");
      }
      return serveDocumentFile(docMatch[1]!, docMatch[2] === "download" ? "attachment" : "inline");
    }
    if (path === "/login" && req.method === "POST") {
      return handleLogin(req);
    }
    if (path === "/logout" && req.method === "POST") {
      return new Response(null, {
        status: 303,
        headers: {
          location: "/login.html",
          "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    // --- static files ---------------------------------------------------------
    const staticPath = path === "/" ? "/index.html" : path;
    const file = Bun.file(join(here, staticPath));
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Cairntrace demo platform at http://localhost:${server.port}/`);
console.log(`  Static smoke pages:  /  /dashboard.html  /api.html  /import.html  /table-actions.html`);
console.log(`  Platform pages:      /products.html  /products/new.html  /documents.html  /login.html`);
console.log(`  API:                 /api/health  /api/stats  /api/products  /api/session  POST /api/login`);
console.log(`  Exports:             /export/products.csv  /export/products.xlsx`);

function makeTemplateWorkbook(): Buffer {
  return makeWorkbook([
    {
      name: "Template Guide",
      rows: [["Help Text"], ["Allowed Values"], ["Examples"]],
    },
    {
      name: "RBA Academy Training",
      rows: [["Email"]],
      validations: { A: "textLength" },
    },
    {
      name: "In Scope Workers",
      rows: [["", "FMW"]],
      validations: { B: "decimal" },
    },
  ]);
}
