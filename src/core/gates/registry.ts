import { join } from "node:path";
import { findConfigFile, loadConfig } from "../config/loader";
import type { GateNode } from "./schema";

type Registry = Readonly<Record<string, GateNode>>;

const byContext = new WeakMap<object, Promise<Registry>>();

/**
 * The `gates:` registry a services / webServer readiness wait resolves names
 * against: the caller's (`ctx.gates`) when it passed one, else the one of
 * the cairntrace.config.yml found from `ctx.configDir` (loaded once per
 * context object). `${secrets.X}` in gates stays late-bound either way —
 * probes resolve it from the phase's scoped environment.
 */
export function gatesRegistryFor(ctx: {
  gates?: Registry | undefined;
  configDir: string;
}): Promise<Registry> {
  if (ctx.gates) return Promise.resolve(ctx.gates);
  let cached = byContext.get(ctx);
  if (!cached) {
    cached = loadGatesRegistry(ctx.configDir);
    byContext.set(ctx, cached);
  }
  return cached;
}

async function loadGatesRegistry(configDir: string): Promise<Registry> {
  try {
    const configPath = await findConfigFile(configDir);
    if (!configPath) return {};
    const loaded = await loadConfig(
      join(configDir, "__gates__.yml"),
      configPath,
    );
    return loaded?.config.gates ?? {};
  } catch {
    // The run already loaded this config; a name that cannot be resolved
    // here fails its wait as an unknown gate.
    return {};
  }
}
