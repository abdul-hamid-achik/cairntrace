import { CAIRN_ENGINE_VERSION } from "../core/engineVersion";

/**
 * Single source of truth for the CLI's reported version: package.json (see
 * core/engineVersion.ts, which config `requires.cairntrace` checks against).
 */
export const CAIRN_VERSION: string = CAIRN_ENGINE_VERSION;
