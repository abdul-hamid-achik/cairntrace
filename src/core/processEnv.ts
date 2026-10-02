/** Credentials that are valid only for the dedicated remote publisher. */
const PUBLISHER_ONLY_ENV_KEYS = new Set(["FILECHEAP_INGEST_TOKEN"]);
const TVAULT_CONTROL_PREFIX = "TVAULT_";
const CAIRN_TVAULT_ENV = "CAIRN_TVAULT_ENV";

/**
 * The publisher is a narrow trust boundary, not another project process.
 * Preserve only the operating-system values needed to locate and execute the
 * binary plus the two values that define the file.cheap publication request.
 */
const PUBLISHER_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "FCHEAP_BIN",
  "FILECHEAP_ARTIFACT_SERVICE_URL",
  "FILECHEAP_INGEST_TOKEN",
]);

function filterTargetEnv(
  env: Record<string, string | undefined>,
  allowedTvaultKeys: ReadonlySet<string> = new Set(),
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !PUBLISHER_ONLY_ENV_KEYS.has(entry[0]) &&
        entry[0] !== CAIRN_TVAULT_ENV &&
        (!entry[0].startsWith(TVAULT_CONTROL_PREFIX) ||
          allowedTvaultKeys.has(entry[0])),
    ),
  );
}

/**
 * Whether `targetChildEnv` withholds `key` from project children because it
 * is a credential (the file.cheap ingest token, a `TVAULT_*` client value).
 * `CAIRN_TVAULT_ENV` is withheld too but names an environment, not a secret,
 * so it is not reported here.
 */
export function isWithheldFromTargetChildren(key: string): boolean {
  return (
    PUBLISHER_ONLY_ENV_KEYS.has(key) || key.startsWith(TVAULT_CONTROL_PREFIX)
  );
}

/**
 * Build an environment for browser/spec/service children. Undefined entries,
 * publisher-only credentials, and TinyVault client controls are removed.
 */
export function targetChildEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return filterTargetEnv(env);
}

/**
 * Preserve a TinyVault-prefixed value only when the invocation selected that
 * exact key as target input. All other TinyVault variables remain controls
 * for the vault client and must not cross into project processes.
 */
export function targetChildEnvWithSelectedTvaultKeys(
  env: Record<string, string | undefined>,
  selectedKeys: Iterable<string>,
): Record<string, string> {
  return filterTargetEnv(env, new Set(selectedKeys));
}

/** Non-secret run context exported to precondition shells and run hooks. */
export interface CairnContextEnvInput {
  /** Resolved environment name (`--env` > spec `environment:` > config default). */
  environment?: string;
  baseUrl?: string;
  runToken?: string;
  runId?: string;
  runDir?: string;
  /** Directory holding the resolved cairntrace.config.yml. */
  configDir?: string;
}

/**
 * `CAIRN_ENV`, `CAIRN_BASE_URL`, `CAIRN_RUN_TOKEN`, `CAIRN_RUN_ID`,
 * `CAIRN_RUN_DIR` and `CAIRN_CONFIG_DIR` for project children, omitting what
 * is not known yet (a `--before` hook runs before any run directory exists).
 * Values are identifiers and paths only — never secrets — so callers layer
 * them over the already-filtered child environment.
 */
export function cairnContextEnv(
  input: CairnContextEnvInput,
): Record<string, string> {
  const entries: Array<[string, string | undefined]> = [
    ["CAIRN_ENV", input.environment],
    ["CAIRN_BASE_URL", input.baseUrl],
    ["CAIRN_RUN_TOKEN", input.runToken],
    ["CAIRN_RUN_ID", input.runId],
    ["CAIRN_RUN_DIR", input.runDir],
    ["CAIRN_CONFIG_DIR", input.configDir],
  ];
  return Object.fromEntries(
    entries.filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[1] !== "",
    ),
  );
}

/**
 * file.cheap publication is the sole child authorized to receive the ingest
 * credential. Construct its environment explicitly instead of allowing
 * ambient inheritance.
 */
export function fcheapPublisherEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && PUBLISHER_ENV_KEYS.has(entry[0]),
    ),
  );
}
