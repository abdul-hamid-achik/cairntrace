import {
  CheckpointStore,
  type CheckpointInfo,
} from "../../../core/checkpoint/CheckpointStore";
import { emit, resolveFormat } from "../../format";

export interface ListOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * One checkpoint row of `cairn checkpoint list --json`. `health` is `ok`
 * (scoped, not expired), `expired`, or `unscoped` (no usable metadata:
 * captured before checkpoints recorded their baseUrl/env/ttl or by another
 * tool — still resumable). `staleMeta: true` = a sidecar exists but the
 * state file was rewritten after it, so it is ignored.
 */
export function checkpointRow(c: CheckpointInfo): Record<string, unknown> {
  return {
    name: c.name,
    path: c.path,
    sizeBytes: c.sizeBytes,
    modifiedAt: c.modifiedAt.toISOString(),
    health: c.health,
    ...(c.staleMeta ? { staleMeta: true } : {}),
    ...(c.meta?.env ? { env: c.meta.env } : {}),
    ...(c.meta?.baseUrl ? { baseUrl: c.meta.baseUrl } : {}),
    ...(c.meta?.createdAt ? { createdAt: c.meta.createdAt } : {}),
    ...(c.meta?.ttl ? { ttl: c.meta.ttl } : {}),
    ...(c.meta?.expiresAt ? { expiresAt: c.meta.expiresAt } : {}),
  };
}

export async function listCheckpointsCommand(opts: ListOptions): Promise<void> {
  const format = resolveFormat(opts, "md");
  const store = new CheckpointStore();
  const list = await store.list();

  const data = {
    root: store.root,
    checkpoints: list.map(checkpointRow),
  };

  process.stdout.write(
    emit(format, data, () => {
      if (list.length === 0) {
        return `# Checkpoints\n\n(empty — none saved at ${data.root})`;
      }
      const lines = [`# Checkpoints (${list.length})`, ""];
      for (const c of list) {
        const kb = (c.sizeBytes / 1024).toFixed(1);
        const scope = [
          c.meta?.env ? `env ${c.meta.env}` : undefined,
          c.meta?.baseUrl,
          c.meta?.expiresAt ? `expires ${c.meta.expiresAt}` : undefined,
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(
          `- **${c.name}** — ${c.health}${
            c.staleMeta ? " (stale scope ignored)" : ""
          } — ${kb} KB — ${c.modifiedAt.toISOString()}${
            scope ? ` — ${scope}` : ""
          }`,
        );
        lines.push(`    ${c.path}`);
      }
      return lines.join("\n");
    }),
  );
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}
