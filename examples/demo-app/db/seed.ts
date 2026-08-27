/**
 * Deterministic demo data for the Cairntrace demo platform.
 *
 * Always migrates first, then wipes the three demo tables and re-inserts the
 * same fixed dataset (demo-import semantics: every run lands on the exact
 * same state, so specs can assert concrete numbers).
 *
 * Data policy: realistic operating data for a fictional office-supplies
 * warehouse ("Northwind Depot"). No real people; product names and prices are
 * ordinary catalog facts, not random strings.
 *
 * Run: bun examples/demo-app/db/seed.ts
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getDb, closeDb } from "./client";
import { documents, products, users } from "./schema";
import { runMigrations } from "./migrate";

const scrypt = promisify(scryptCallback);

export const DEMO_EMAIL = "casey@cairntrace.dev";
export const DEMO_PASSWORD = "cairn-demo-2026";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 32)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex) {
    return false;
  }
  const derived = (await scrypt(password, salt, 32)) as Buffer;
  const expected = Buffer.from(hex, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Fixed catalog. Category "electronics" is asserted by read-only specs;
 * creation flows post into "office" so counts stay stable. */
export const SEED_PRODUCTS: Array<{
  sku: string;
  name: string;
  category: string;
  priceCents: number;
  stock: number;
}> = [
  { sku: "FN-NB-48", name: "Field Notes Memo Book 3-pack (Graph)", category: "office", priceCents: 1495, stock: 240 },
  { sku: "MD-NB-A5", name: "Maruman Mnemosyne N195A A5 Notebook", category: "office", priceCents: 1850, stock: 120 },
  { sku: "TR-PEN-BLU", name: "Tombow MONO Draw Blue Ballpoint", category: "office", priceCents: 320, stock: 800 },
  { sku: "PX-GRPH-12", name: "Pentel GraphGear 500 Pencil 0.5mm (Dozen)", category: "office", priceCents: 2160, stock: 90 },
  { sku: "LN-LMP-ARC", name: "Lenore Arc LED Desk Lamp (Dimmable)", category: "electronics", priceCents: 5900, stock: 45 },
  { sku: "AN-HUB-7P", name: "Anker 341 USB-C Hub (7-in-1)", category: "electronics", priceCents: 3499, stock: 60 },
  { sku: "LG-MTR-27", name: "LG UltraFine 27UN500-W 27in Monitor", category: "electronics", priceCents: 27999, stock: 12 },
  { sku: "KY-KB-K380", name: "Logitech K380 Multi-Device Keyboard", category: "electronics", priceCents: 3999, stock: 38 },
  { sku: "BX-JAR-32", name: "Bormioli Rocco Quattro Stagioni 32oz Jar", category: "kitchen", priceCents: 899, stock: 150 },
  { sku: "BK-KTL-GO", name: "Bodum Bistro Gooseneck Kettle 0.5L", category: "kitchen", priceCents: 4250, stock: 26 },
  { sku: "ES-PRS-6", name: "Hario V60 Paper Filters (100 ct)", category: "kitchen", priceCents: 1299, stock: 300 },
  { sku: "OX-GRD-2C", name: "OXO Good Grips 2-Cup Angle Measure", category: "kitchen", priceCents: 749, stock: 210 },
];

async function seed(): Promise<void> {
  const applied = await runMigrations();
  if (applied.length > 0) {
    console.log(`Migrations applied: ${applied.join(", ")}`);
  }

  const db = getDb();
  await db.delete(documents);
  await db.delete(products);
  await db.delete(users);

  const [user] = await db
    .insert(users)
    .values({
      email: DEMO_EMAIL,
      name: "Casey Rivera",
      passwordHash: await hashPassword(DEMO_PASSWORD),
    })
    .returning();

  await db.insert(products).values(SEED_PRODUCTS);

  // Two starter documents so the documents desk is never empty.
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const fixtures = join(here, "../../fixtures");
  const starterDocs = [
    { file: "sample-invoice.pdf", docType: "invoice" },
    { file: "sample-report.pdf", docType: "report" },
  ];
  for (const doc of starterDocs) {
    const bytes = readFileSync(join(fixtures, doc.file));
    await db.insert(documents).values({
      filename: doc.file,
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      docType: doc.docType,
      uploadedBy: user?.name ?? null,
      contentHex: bytes.toString("hex"),
    });
  }

  console.log(
    `Seeded ${SEED_PRODUCTS.length} products, 1 operator (${DEMO_EMAIL}), ${starterDocs.length} documents`,
  );
}

await seed();
await closeDb();
