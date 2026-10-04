import { createRequire } from "node:module";

/**
 * The running cairn's version: package.json, read at runtime so it is the
 * same under the bun launcher, vitest and a compiled binary.
 */
export const CAIRN_ENGINE_VERSION: string = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;
