import { Context, type ModelSpec } from "./context";
import type { LLMProvider } from "./llm/provider";
import type { Gen } from "./gen";
import { finisher, type RecordOf } from "./output";
import { Plan } from "./plan";

export interface PreviewParams<G extends Gen<unknown>> {
  /** What to generate: usually a TreeGen, whose records are checked against its schema and lose their `.temp()` fields. */
  gen: G;
  numRecords?: number;
  /**
   * Index of the first row (default 0); rows are numbered from here (`ctx.row.index`), and each row
   * depends only on the seed and its index. For runs to be joined, give each its own range:
   * `startIndex: previous.nextIndex`.
   */
  startIndex?: number;
  /** Omit for a random seed. The result reports the seed used. */
  seed?: number | readonly number[];
  /**
   * Records generated together (default 100). Async calls (LLMs) of one DAG level run in parallel
   * across the whole batch. Does not change the data: the same seed gives the same records at any size.
   */
  batchSize?: number;
  /** Name -> provider, for LLM Gens: `{ nvidia: Provider.nvidia() }`. */
  providers?: Readonly<Record<string, LLMProvider>>;
  /** Nickname -> model spec; LLM Gens name a nickname: `{ fast: { provider: "nvidia", model: "..." } }`. */
  models?: Readonly<Record<string, ModelSpec>>;
}

export interface PreviewResults<T> {
  records: T[];
  /** Pass this back as `seed` to get the same records again. */
  seed: readonly number[];
  /** The index after the last row: the `startIndex` for a run that continues this one. */
  nextIndex: number;
}

/**
 * Generates a few records in memory. Mirrors DataDesigner's `preview()`; `create()` writes them to a file.
 * Async because a tree may contain async Gens (LLMs); for trees without them, see `previewSync`.
 *
 * A tree's records are checked against its schema (a GenerationError names the record and the
 * problems), and their `.temp()` fields are dropped: the records are `Output<typeof Schema>`.
 */
export async function preview<G extends Gen<unknown>>(params: PreviewParams<G>): Promise<PreviewResults<RecordOf<G>>> {
  const { ctx, plan, batches } = setUp(params);
  const finish = finisher(params.gen);
  const records: RecordOf<G>[] = [];
  for (const size of batches) {
    const first = ctx.global.startIndex + records.length;
    for (const record of await plan.runBatch(ctx, size, { first })) records.push(finish(record, records.length) as RecordOf<G>);
  }
  return { records, seed: ctx.seed, nextIndex: ctx.global.startIndex + records.length };
}

/**
 * `preview()` without the Promise, for trees of sync Gens only (samplers, sync CustomGens). Throws
 * a GenerationError naming the field if a Gen turns out to be async.
 */
export function previewSync<G extends Gen<unknown>>(params: PreviewParams<G>): PreviewResults<RecordOf<G>> {
  const { ctx, plan, batches } = setUp(params);
  const finish = finisher(params.gen);
  const records: RecordOf<G>[] = [];
  for (const size of batches) {
    const first = ctx.global.startIndex + records.length;
    for (const record of plan.runBatch(ctx, size, { first, sync: true }) as unknown[]) records.push(finish(record, records.length) as RecordOf<G>);
  }
  return { records, seed: ctx.seed, nextIndex: ctx.global.startIndex + records.length };
}

export function setUp<G extends Gen<unknown>>({ gen, numRecords = 10, startIndex = 0, seed, batchSize = 100, providers, models }: PreviewParams<G>) {
  if (!Number.isSafeInteger(numRecords) || numRecords < 0) {
    throw new RangeError(`numRecords must be an integer >= 0, got ${numRecords}.`);
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be an integer >= 1, got ${batchSize}.`);
  }
  const ctx = Context.create({ seed, providers, models, startIndex, numRecords });
  const plan = Plan.compile(gen); // once, reused for every batch
  plan.checkContext(ctx);
  const batches: number[] = [];
  for (let done = 0; done < numRecords; done += batchSize) batches.push(Math.min(batchSize, numRecords - done));
  return { ctx, plan, batches };
}
