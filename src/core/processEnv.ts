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
