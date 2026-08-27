import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export const DEFAULT_DATABASE_URL =
  process.env.DEMO_DATABASE_URL ?? "postgres://cairn:cairn@localhost:5433/cairn";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

let cached: PostgresJsDatabase<typeof schema> | null = null;
let connection: ReturnType<typeof postgres> | null = null;

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (cached) {
    return cached;
  }
  connection = postgres(databaseUrl(), { max: 4 });
  cached = drizzle({ client: connection, schema });
  return cached;
}

export async function closeDb(): Promise<void> {
  if (connection) {
    await connection.end();
    connection = null;
    cached = null;
  }
}
