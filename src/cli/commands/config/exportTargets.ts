import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Config } from "../../../core/schema/config.v1";

/**
 * `cairn config validate` for `export.targets`: every profile must be usable
 * as an export request on its own — modes that combine, an input and a host
 * config that exist, and a host config that can be read statically and whose
 * `testDir` / `testMatch` would find the tree it writes. Problems are
 * `export.targets.<name>.<field>: <why>`.
 */
export async function validateExportTargets(
  config: Config,
  configDir: string,
): Promise<string[]> {
  const targets = config.export?.targets;
  if (!targets || Object.keys(targets).length === 0) return [];
  const problems: string[] = [];
  const { resolveExportModes } = await import("../export");
  const { exportMapProblems, loadExportMap } = await import(
    "../../../core/exporters/exportMap"
  );
  const { assertHostFlags, prepareHost } = await import("../exportHost");
  const abs = (path: string): string =>
    isAbsolute(path) ? path : resolve(configDir, path);
  for (const [name, target] of Object.entries(targets)) {
    const at = `export.targets.${name}`;
    try {
      resolveExportModes({
        ...(target.preconditions
          ? { preconditions: target.preconditions }
          : {}),
        ...(target.verifiers ? { verifiers: target.verifiers } : {}),
        ...(target.gateEnv ? { gateEnv: target.gateEnv } : {}),
        ...(target.into ? { into: abs(target.into) } : {}),
        // A target without `into` writes wherever its flags say (--out-dir /
        // --project): the global / manifest modes are checked when it runs.
      });
    } catch (e) {
      const message = (e as Error).message;
      // Needs-a-destination errors are only an error when nothing else can
      // supply the destination, which only the command line knows.
      if (!/needs --project, --into/.test(message)) {
        problems.push(`${at}: ${message}`);
      }
    }
    if (target.input && !existsSync(abs(target.input))) {
      problems.push(
        `${at}.input: ${target.input} does not exist (relative to the config directory)`,
      );
    }
    if (target.mapFile !== undefined) {
      const mapPath = abs(target.mapFile);
      if (!existsSync(mapPath) || !statSync(mapPath).isFile()) {
        problems.push(
          `${at}.mapFile: ${target.mapFile} does not exist (relative to the config directory)`,
        );
      } else {
        try {
          const loaded = loadExportMap(mapPath);
          for (const problem of exportMapProblems(loaded)) {
            problems.push(`${at}.mapFile: ${problem}`);
          }
        } catch (e) {
          problems.push(`${at}.mapFile: ${(e as Error).message}`);
        }
      }
    }
    if (target.hostConfig === undefined) continue;
    try {
      assertHostFlags({
        hostConfig: target.hostConfig,
        ...(target.into ? { into: target.into } : {}),
      });
    } catch (e) {
      problems.push(`${at}.hostConfig: ${(e as Error).message}`);
      continue;
    }
    const hostPath = abs(target.hostConfig);
    if (!existsSync(hostPath) || !statSync(hostPath).isFile()) {
      problems.push(
        `${at}.hostConfig: ${target.hostConfig} does not exist (relative to the config directory)`,
      );
      continue;
    }
    try {
      await prepareHost(
        { hostConfig: hostPath, into: abs(target.into!) },
        target.lang ?? "ts",
        abs(target.into!),
      );
    } catch (e) {
      problems.push(`${at}.hostConfig: ${(e as Error).message}`);
    }
  }
  return problems;
}
