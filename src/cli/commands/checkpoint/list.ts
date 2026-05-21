import { CheckpointStore } from "../../../core/checkpoint/CheckpointStore";
import { emit, resolveFormat } from "../../format";

export interface ListOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function listCheckpointsCommand(opts: ListOptions): Promise<void> {
  const format = resolveFormat(opts, "md");
  const store = new CheckpointStore();
  const list = await store.list();

  const data = {
    root: store.root,
    checkpoints: list.map((c) => ({
      name: c.name,
      path: c.path,
      sizeBytes: c.sizeBytes,
      modifiedAt: c.modifiedAt.toISOString(),
    })),
  };

  process.stdout.write(
    emit(format, data, (d) => {
      if (d.checkpoints.length === 0) {
        return `# Checkpoints\n\n(empty — none saved at ${d.root})`;
      }
      const lines = [`# Checkpoints (${d.checkpoints.length})`, ""];
      for (const c of d.checkpoints) {
        const kb = (c.sizeBytes / 1024).toFixed(1);
        lines.push(`- **${c.name}** — ${kb} KB — ${c.modifiedAt}`);
        lines.push(`    ${c.path}`);
      }
      return lines.join("\n");
    }),
  );
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}
