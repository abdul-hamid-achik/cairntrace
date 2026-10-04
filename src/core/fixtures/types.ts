import type { DatasourceSession } from "../datasources";
import type { EnvironmentDatasourceSet } from "../datasources/resolve";
import type {
  FixtureDefinition,
  FixtureScope,
  FixtureVerbName,
} from "./schema";

/** Everything an adapter needs to run one verb of one fixture. */
export interface FixtureVerbContext {
  name: string;
  verb: FixtureVerbName;
  scope: FixtureScope;
  /** The fixture definition with every placeholder of this verb resolved. */
  fixture: FixtureDefinition;
  /** The resolved verb (`fixture[verb]`). */
  verbDef: unknown;
  /** Resolved parameters (`with:`). */
  params: Readonly<Record<string, unknown>>;
  /** The fixture's current outputs (reset / verify / teardown). */
  outputs: Readonly<Record<string, unknown>>;
  /** Resolved `owner.marker`, when declared. */
  marker?: Readonly<Record<string, unknown>>;
  exactlyOne: boolean;
  /**
   * Whether this consumer may write here (environment policy and the write
   * opt-ins). `verify` is read-only either way; a mongosh verify script,
   * which cannot be proven read-only, only runs while this is true.
   */
  writesAllowed: boolean;
  /** Relative files (exec node scripts, mongo scripts) resolve here. */
  configDir: string;
  /** Already-filtered child environment (no vault controls). */
  childEnv: Readonly<Record<string, string | undefined>>;
  /** Non-secret CAIRN_* context (env, base URL, run id, …). */
  contextEnv: Readonly<Record<string, string>>;
  selectedTvaultKeys?: Iterable<string>;
  datasources: DatasourceSession;
  /** The environment's datasources (the mongo script transport reads them). */
  datasourceSet?: EnvironmentDatasourceSet;
  envName: string;
  vars: Readonly<Record<string, unknown>>;
  baseUrl?: string;
  /** Epoch ms when the verb is abandoned. */
  deadline: number;
  signal?: AbortSignal;
  /** Literal secret values to scrub from errors (adapters add to it). */
  secrets: Set<string>;
}

/** What a verb produced: the document outputs are read from. */
export interface FixtureVerbOutcome {
  result?: unknown;
  /** One line for narration (`2 ops: matched 1, modified 1`). */
  detail?: string;
}

/** A verb failed; the message is already scrubbed of known secrets. */
export class FixtureVerbError extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "FixtureVerbError";
  }
}

export function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}
