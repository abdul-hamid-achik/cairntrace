/**
 * Tiny worker-pool: process N items concurrently, preserve input order.
 * Returns results indexed by input position. No external deps.
 */
export async function runPool<T, R>(
  items: readonly T[],
  parallel: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.floor(parallel));
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(width, items.length); w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = next++;
          if (idx >= items.length) return;
          results[idx] = await work(items[idx]!, idx);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}
