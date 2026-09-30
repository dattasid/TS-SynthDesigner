import { Context, type ModelConfig } from "./context";
import type { Gen } from "./gen";
import { Plan } from "./plan";

export interface PreviewParams<T> {
  gen: Gen<T>;
  numRecords?: number;
  /** Omit for a random seed. The result reports the seed used. */
  seed?: number | readonly number[];
  /**
   * Records generated together (default 100). Async calls (LLMs) of one DAG level run in parallel
   * across the whole batch. Does not change the data: the same seed gives the same records at any size.
   */
  batchSize?: number;
  modelConfigs?: readonly ModelConfig[];
}

export interface PreviewResults<T> {
  records: T[];
  /** Pass this back as `seed` to get the same records again. */
  seed: readonly number[];
}

/**
 * Generates a few records in memory. Mirrors DataDesigner's `preview()`; `create()` (to disk) comes later.
 * Async because a tree may contain async Gens (LLMs); for trees without them, see `previewSync`.
 */
export async function preview<T>(params: PreviewParams<T>): Promise<PreviewResults<T>> {
  const { ctx, plan, batches } = setUp(params);
  const records: T[] = [];
  for (const size of batches) records.push(...(await plan.runBatch(ctx, size)));
  return { records, seed: ctx.seed };
}

/**
 * `preview()` without the Promise, for trees of sync Gens only (samplers, sync CustomGens). Throws
 * a GenerationError naming the field if a Gen turns out to be async.
 */
export function previewSync<T>(params: PreviewParams<T>): PreviewResults<T> {
  const { ctx, plan, batches } = setUp(params);
  const records: T[] = [];
  for (const size of batches) records.push(...(plan.runBatch(ctx, size, { sync: true }) as T[]));
  return { records, seed: ctx.seed };
}

function setUp<T>({ gen, numRecords = 10, seed, batchSize = 100, modelConfigs }: PreviewParams<T>) {
  if (!Number.isSafeInteger(numRecords) || numRecords < 0) {
    throw new RangeError(`numRecords must be an integer >= 0, got ${numRecords}.`);
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be an integer >= 1, got ${batchSize}.`);
  }
  const ctx = Context.create({ seed, modelConfigs });
  const plan = Plan.compile(gen); // once, reused for every batch
  const batches: number[] = [];
  for (let done = 0; done < numRecords; done += batchSize) batches.push(Math.min(batchSize, numRecords - done));
  return { ctx, plan, batches };
}
