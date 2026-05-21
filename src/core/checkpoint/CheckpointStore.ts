import {
  access,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface CheckpointInfo {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export interface CheckpointSummary {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
  /** First ~400 bytes of the file as text for human inspection. */
  preview: string;
}

/**
 * Resolves checkpoint names to filesystem paths under `~/.cairntrace/checkpoints/`.
 * Cairntrace doesn't write the checkpoint file itself — agent-browser does via
 * `state save <path>`. CheckpointStore owns the path layout and read-side ops.
 */
export class CheckpointStore {
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? join(homedir(), ".cairntrace", "checkpoints");
  }

  /** Absolute path where the checkpoint with `name` should live. */
  pathFor(name: string): string {
    if (!/^[a-z][a-z0-9-_]*$/i.test(name)) {
      throw new Error(
        `invalid checkpoint name "${name}" — use letters, digits, hyphen, underscore (must start with a letter)`,
      );
    }
    return join(this.root, `${name}.json`);
  }

  /**
   * Resolve a `spec.session.resume:` value to an absolute path.
   * If the value contains a path separator or is already absolute, pass through.
   * Otherwise treat it as a name and look it up in the store.
   */
  resolveResume(value: string): string {
    if (isAbsolute(value)) return value;
    if (value.includes("/")) return value;
    return this.pathFor(value);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async exists(name: string): Promise<boolean> {
    try {
      await access(this.pathFor(name));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<CheckpointInfo[]> {
    try {
      const entries = await readdir(this.root);
      const checkpoints: CheckpointInfo[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const name = entry.slice(0, -".json".length);
        const path = join(this.root, entry);
        const s = await stat(path);
        checkpoints.push({
          name,
          path,
          sizeBytes: s.size,
          modifiedAt: s.mtime,
        });
      }
      return checkpoints.toSorted(
        (a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime(),
      );
    } catch {
      return [];
    }
  }

  async show(name: string): Promise<CheckpointSummary | undefined> {
    const path = this.pathFor(name);
    let s;
    try {
      s = await stat(path);
    } catch {
      return undefined;
    }
    const preview = await readFile(path, "utf8")
      .then((t) => t.slice(0, 400))
      .catch(() => "");
    return {
      name,
      path,
      sizeBytes: s.size,
      modifiedAt: s.mtime,
      preview,
    };
  }

  async delete(name: string): Promise<boolean> {
    const path = this.pathFor(name);
    try {
      await unlink(path);
      return true;
    } catch {
      return false;
    }
  }
}
