/**
 * Minimal journal-driven migration runner for the demo app.
 * Applies every entry in drizzle/meta/_journal.json exactly once,
 * tracking applied tags in cairn_demo_migrations.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { databaseUrl } from "./client";

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, "../drizzle");

export async function runMigrations(): Promise<string[]> {
  const journal = JSON.parse(readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const sql = postgres(databaseUrl(), { max: 1 });
  const applied: string[] = [];
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS cairn_demo_migrations (
        tag text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const entry of journal.entries) {
      const file = join(drizzleDir, `${entry.tag}.sql`);
      if (!existsSync(file)) {
        throw new Error(`Migration ${entry.tag} listed in journal but missing on disk`);
      }
      const [done] = await sql<{ tag: string }[]>`
        SELECT tag FROM cairn_demo_migrations WHERE tag = ${entry.tag}
      `;
      if (done) {
        continue;
      }
      await sql.unsafe(readFileSync(file, "utf8"));
      await sql`INSERT INTO cairn_demo_migrations (tag) VALUES (${entry.tag})`;
      applied.push(entry.tag);
    }
  } finally {
    await sql.end();
  }
  return applied;
}

if (import.meta.main) {
  const applied = await runMigrations();
  console.log(
    applied.length > 0
      ? `Applied migrations: ${applied.join(", ")}`
      : "Demo schema already up to date",
  );
}
