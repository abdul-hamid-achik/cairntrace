/**
 * Pure helpers for `cairn run --repeat N` / `--matrix key=a,b[;key2=x,y]`.
 * No I/O: parsing, cartesian expansion, label + env stamping.
 */

export const MAX_REPEAT = 1000;
export const MAX_ITERATIONS = 5000;

export interface MatrixAxis {
  key: string;
  values: string[];
}

export interface RunIteration {
  /** 1-based position in the whole plan. */
  index: number;
  /** 1-based repeat number; undefined when `--repeat` was not given. */
  repeat?: number;
  /** One value per matrix axis (empty when no `--matrix`). */
  matrix: Record<string, string>;
}

export function parseRepeat(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`--repeat expects a positive integer, got "${raw}"`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_REPEAT) {
    throw new Error(`--repeat must be between 1 and ${MAX_REPEAT}`);
  }
  return n;
}

/**
 * Parse `key=a,b;key2=x,y` into ordered axes. Keys must be simple identifiers
 * (they become label keys and CAIRN_MATRIX_<KEY> env names); values are free
 * text without `,` or `;`.
 */
export function parseMatrix(raw: string | undefined): MatrixAxis[] {
  if (raw === undefined) return [];
  const axes: MatrixAxis[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(";")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--matrix expects key=a,b[;key2=x,y], got "${piece}"`);
    }
    const key = piece.slice(0, eq).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error(
        `--matrix key "${key}" must start with a letter and contain only letters, digits, "_" or "-"`,
      );
    }
    if (key === "repeat") {
      throw new Error('--matrix key "repeat" is reserved for --repeat');
    }
    const envName = matrixEnvName(key);
    if (seen.has(envName)) {
      throw new Error(`--matrix key "${key}" is declared more than once`);
    }
    seen.add(envName);
    const values = piece
      .slice(eq + 1)
      .split(",")
      .map((v) => v.trim());
    if (values.length === 0 || values.some((v) => v === "")) {
      throw new Error(`--matrix key "${key}" has an empty value`);
    }
    axes.push({ key, values: [...new Set(values)] });
  }
  if (axes.length === 0) {
    throw new Error("--matrix needs at least one key=a,b axis");
  }
  return axes;
}

/** `key-name` -> `CAIRN_MATRIX_KEY_NAME`. */
export function matrixEnvName(key: string): string {
  return `CAIRN_MATRIX_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Cartesian product; first axis varies slowest. */
export function expandMatrix(axes: MatrixAxis[]): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const axis of axes) {
    combos = combos.flatMap((c) =>
      axis.values.map((v) => ({ ...c, [axis.key]: v })),
    );
  }
  return combos;
}

/**
 * Build the ordered iteration plan. Repeats are the OUTER loop and matrix
 * combinations the inner one, so cohorts interleave (a,b,a,b,...) and slow
 * machine drift does not bias a single cohort.
 */
export function planIterations(
  repeat: number | undefined,
  axes: MatrixAxis[],
): RunIteration[] {
  const combos = expandMatrix(axes);
  const repeats = repeat ?? 1;
  const total = repeats * combos.length;
  if (total > MAX_ITERATIONS) {
    throw new Error(
      `--repeat/--matrix expand to ${total} runs; the maximum is ${MAX_ITERATIONS}`,
    );
  }
  const plan: RunIteration[] = [];
  for (let r = 1; r <= repeats; r++) {
    for (const matrix of combos) {
      plan.push({
        index: plan.length + 1,
        ...(repeat !== undefined ? { repeat: r } : {}),
        matrix,
      });
    }
  }
  return plan;
}

/** `key=value` labels for one iteration (`repeat=<i>` plus matrix pairs). */
export function iterationLabels(it: RunIteration): string[] {
  const out: string[] = [];
  if (it.repeat !== undefined) out.push(`repeat=${it.repeat}`);
  for (const [k, v] of Object.entries(it.matrix)) out.push(`${k}=${v}`);
  return out;
}

/** Env vars exported to hooks and spec `${env.X}` for one iteration. */
export function iterationEnv(it: RunIteration): Record<string, string> {
  const out: Record<string, string> = {};
  if (it.repeat !== undefined) out.CAIRN_REPEAT = String(it.repeat);
  for (const [k, v] of Object.entries(it.matrix)) out[matrixEnvName(k)] = v;
  return out;
}

export function describeIteration(it: RunIteration): string {
  const labels = iterationLabels(it);
  return labels.length > 0 ? labels.join(" ") : "(single)";
}
