import { createRequire } from "node:module";

/**
 * Single source of truth for the CLI's reported version: package.json.
 * Read at runtime via createRequire so it works identically under the bun
 * shebang launcher, vitest, and a future compiled binary — no JSON-import
 * tsconfig flags needed.
 */
export const CAIRN_VERSION: string = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;
