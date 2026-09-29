import { Context, type ModelConfig } from "./context";
import type { Gen } from "./gen";
import { Plan } from "./plan";

export interface PreviewParams<T> {
  gen: Gen<T>;
  numRecords?: number;
  /** Omit for a random seed. The result reports the seed used. */
  seed?: number | readonly number[];
  modelConfigs?: readonly ModelConfig[];
}

export interface PreviewResults<T> {
  records: T[];
  /** Pass this back as `seed` to get the same records again. */
  seed: readonly number[];
}

/** Generates a few records in memory. Mirrors DataDesigner's `preview()`; `create()` (to disk) comes later. */
export function preview<T>({ gen, numRecords = 10, seed, modelConfigs }: PreviewParams<T>): PreviewResults<T> {
  if (!Number.isSafeInteger(numRecords) || numRecords < 0) {
    throw new RangeError(`numRecords must be an integer >= 0, got ${numRecords}.`);
  }
  const ctx = Context.create({ seed, modelConfigs });
  const plan = Plan.compile(gen); // once, reused for every record
  const records: T[] = [];
  for (let i = 0; i < numRecords; i++) records.push(plan.run(ctx));
  return { records, seed: ctx.seed };
}
