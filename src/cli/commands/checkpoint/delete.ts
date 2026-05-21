import { CheckpointStore } from "../../../core/checkpoint/CheckpointStore";

export async function deleteCheckpointCommand(name: string): Promise<void> {
  const store = new CheckpointStore();
  const ok = await store.delete(name);
  if (!ok) {
    process.stderr.write(`No checkpoint named "${name}" at ${store.root}\n`);
    process.exit(2);
  }
  process.stdout.write(`Deleted ${name}\n`);
}
