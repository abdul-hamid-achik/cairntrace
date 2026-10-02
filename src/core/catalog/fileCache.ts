import { readFile, stat } from "node:fs/promises";

/**
 * Per-process cache of derived file data keyed by path + mtime + size, so a
 * long-lived MCP server re-reading the catalog only re-parses files that
 * changed. Bounded: the oldest entries are dropped past `maxEntries`.
 */
export class FileCache<T> {
  private readonly entries = new Map<
    string,
    { mtimeMs: number; size: number; value: T }
  >();

  constructor(private readonly maxEntries = 5_000) {}

  /**
   * The cached value for `path`, or `derive(text)` when the file is new or
   * changed. Undefined when the file cannot be read or exceeds `maxBytes`.
   */
  async get(
    path: string,
    derive: (text: string) => T,
    maxBytes = 1024 * 1024,
  ): Promise<T | undefined> {
    let info;
    try {
      info = await stat(path);
    } catch {
      this.entries.delete(path);
      return undefined;
    }
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const hit = this.entries.get(path);
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
      return hit.value;
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return undefined;
    }
    const value = derive(text);
    this.entries.delete(path);
    this.entries.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }
}
