import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildCatalog } from "../catalog/buildCatalog";
import { loadNetwork } from "../discovery/DiscoverySession";
import type { DiscoveryNetworkEntry } from "../discovery/networkLog";
import { mutationsOf } from "../discovery/networkLog";
import { journalSteps, readSessionJournal } from "../discovery/sessionJournal";
import type { ActionTemplate } from "./actionMatch";
import type { RecordedEntry } from "./conventions";

/**
 * What a convention export reads besides the recorded steps: the journal's
 * per-action URLs and mutations, and the project's reusable actions.
 */

/**
 * Recorded steps with their journal facts (URLs, mutations), in order.
 * `steps` (a live session's own record) wins over the journaled copies,
 * which went through the artifact redactor.
 */
export async function entriesFromJournal(
  dir: string,
  steps?: ReadonlyArray<{ step: Record<string, unknown>; index?: number }>,
): Promise<RecordedEntry[] | undefined> {
  const read = await readSessionJournal(dir);
  if (!read) return undefined;
  const performed = new Map<number, { urlBefore: string; urlAfter: string }>();
  for (const event of read.events) {
    if (event.type === "action.performed") {
      performed.set(event.index, {
        urlBefore: event.urlBefore,
        urlAfter: event.urlAfter,
      });
    }
  }
  const network = loadNetwork(dir);
  const recorded = steps ?? journalSteps(read.events).steps;
  return recorded.map(({ index, step }) =>
    entry(
      step,
      index,
      index !== undefined ? performed.get(index) : undefined,
      network,
    ),
  );
}

/** Entries of a session without a journal (no URLs known). */
export function entriesFromSteps(
  steps: ReadonlyArray<{ step: Record<string, unknown>; index?: number }>,
  network: readonly DiscoveryNetworkEntry[],
): RecordedEntry[] {
  return steps.map(({ step, index }) => entry(step, index, undefined, network));
}

function entry(
  step: Record<string, unknown>,
  index: number | undefined,
  urls: { urlBefore: string; urlAfter: string } | undefined,
  network: readonly DiscoveryNetworkEntry[],
): RecordedEntry {
  const mutations =
    index === undefined
      ? []
      : mutationsOf(network.filter((item) => item.action === index));
  return {
    step,
    ...(index !== undefined ? { index } : {}),
    ...urls,
    ...(mutations.length > 0 ? { mutations } : {}),
  };
}

/** A reusable action file read as a match template; undefined otherwise. */
async function readActionTemplate(
  file: string,
): Promise<ActionTemplate | undefined> {
  try {
    const doc = parseYaml(await readFile(file, "utf8")) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
    const record = doc as Record<string, unknown>;
    if ("outcomes" in record || !Array.isArray(record["steps"])) {
      return undefined;
    }
    if (typeof record["name"] !== "string") return undefined;
    const steps = (record["steps"] as unknown[]).filter(
      (step): step is Record<string, unknown> =>
        !!step && typeof step === "object" && !Array.isArray(step),
    );
    const vars = record["vars"];
    const defaults: ActionTemplate["defaults"] = {};
    if (vars && typeof vars === "object" && !Array.isArray(vars)) {
      for (const [key, value] of Object.entries(vars)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          defaults[key] = value;
        }
      }
    }
    return { name: record["name"], file, steps, defaults };
  } catch {
    return undefined;
  }
}

/**
 * The project's reusable actions, in priority order: the config
 * `authoring.template.imports` files first, then every action the catalog
 * finds. The first action of a name wins.
 */
export async function loadActionTemplates(opts: {
  configPath?: string;
  configDir: string;
  /** Absolute `authoring.template.imports`. */
  templateImports?: readonly string[];
}): Promise<{ actions: ActionTemplate[]; warnings: string[] }> {
  const files: string[] = [...(opts.templateImports ?? [])];
  const warnings: string[] = [];
  try {
    const catalog = await buildCatalog({
      cwd: opts.configDir,
      ...(opts.configPath ? { config: opts.configPath } : {}),
      kinds: ["actions"],
      maxRuns: 0,
    });
    for (const action of catalog.actions ?? []) {
      files.push(resolve(catalog.root, action.file));
    }
  } catch (e) {
    warnings.push(
      `action reuse skipped: the catalog could not be read (${(e as Error).message})`,
    );
  }
  const seen = new Set<string>();
  const actions: ActionTemplate[] = [];
  for (const file of new Set(files)) {
    const template = await readActionTemplate(file);
    if (!template || seen.has(template.name)) continue;
    seen.add(template.name);
    actions.push(template);
  }
  return { actions, warnings };
}
