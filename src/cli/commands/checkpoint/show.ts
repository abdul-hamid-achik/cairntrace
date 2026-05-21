import { CheckpointStore } from "../../../core/checkpoint/CheckpointStore";
import { emit, resolveFormat } from "../../format";

export interface ShowOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function showCheckpointCommand(
  name: string,
  opts: ShowOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const store = new CheckpointStore();
  const summary = await store.show(name);

  if (!summary) {
    process.stderr.write(`No checkpoint named "${name}" at ${store.root}\n`);
    process.exit(2);
  }

  const data = {
    name: summary.name,
    path: summary.path,
    sizeBytes: summary.sizeBytes,
    modifiedAt: summary.modifiedAt.toISOString(),
    preview: summary.preview,
  };

  process.stdout.write(
    emit(format, data, (d) => {
      const kb = (d.sizeBytes / 1024).toFixed(1);
      return [
        `# Checkpoint: ${d.name}`,
        `Path: ${d.path}`,
        `Size: ${kb} KB`,
        `Modified: ${d.modifiedAt}`,
        "",
        "## Preview",
        "```json",
        d.preview,
        d.preview.length >= 400 ? "…" : "",
        "```",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  );
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}
