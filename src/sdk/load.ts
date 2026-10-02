import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runNodeScript,
  VERIFIER_SDK_SPECIFIER,
} from "../core/runner/nodeScripts";
import { VERIFIER_SDK_ENTRY } from "../core/runner/verifiers/script";
import type { SdkFixtureKey } from "./contract";

export const DEFAULT_LOAD_TIMEOUT_MS = 10_000;

export interface LoadedContract {
  description?: string;
  strict: boolean;
  dynamic: boolean;
  keys: SdkFixtureKey[];
  reason?: string;
}

/**
 * Import a verifier module in a Node child (killed after `timeoutMs`) and
 * read the contract defineVerifier() attached to its export. This EXECUTES
 * the module's top-level code with the caller's permissions — only for files
 * the caller trusts. Returns `undefined` when the module exports no SDK
 * verifier; throws when it cannot be imported.
 */
export async function loadVerifierContract(
  file: string,
  opts: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<LoadedContract | undefined> {
  const result = await runNodeScript({
    source: LOAD_SOURCE,
    ctx: {
      fileUrl: pathToFileURL(file).href,
      specifier: VERIFIER_SDK_SPECIFIER,
    },
    cwd: dirname(file),
    entryNames: [],
    timeoutMs: opts.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
    sdkEntry: VERIFIER_SDK_ENTRY,
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (!result.ok) {
    throw new Error(
      result.error?.message ??
        (result.stderr.trim() || "the module failed to load"),
    );
  }
  const found = result.result as {
    description?: string;
    fixtures: Omit<LoadedContract, "description">;
  } | null;
  if (!found) return undefined;
  return {
    ...(found.description ? { description: found.description } : {}),
    ...found.fixtures,
  };
}

/** Runs in the child: import the module, then ask the SDK what it exported. */
const LOAD_SOURCE = `
const mod = await import(ctx.fileUrl);
const sdk = await import(ctx.specifier);
for (const candidate of [mod.verify, mod.default]) {
  const contract = sdk.inspectVerifier(candidate);
  if (contract) return contract;
}
return null;
`;
