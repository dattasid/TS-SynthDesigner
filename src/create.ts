import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { ConfigError, GenerationError } from "./errors";
import { setUp, type PreviewParams } from "./preview";

export interface CreateParams<T> extends PreviewParams<T> {
  numRecords: number;
  /** The JSONL file to write, one record per line. Missing folders are made. */
  path: string;
  /** Replace the file if it exists. Default false: an existing file is an error, so no run is lost by accident. */
  overwrite?: boolean;
}

export interface CreateResults {
  path: string;
  numRecords: number;
  /** Pass this back as `seed` to get the same records again. */
  seed: readonly number[];
}

/**
 * Generates records and writes them to a JSONL file. Mirrors DataDesigner's `create()`.
 *
 * Each batch (`batchSize` records) is written as soon as it is done, so memory stays at one batch,
 * and a run that fails part way keeps the batches before the failure.
 */
export async function create<T>(params: CreateParams<T>): Promise<CreateResults> {
  const { path, overwrite = false } = params;
  const { ctx, plan, batches } = setUp(params); // checks the params and the tree before the file is touched
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, overwrite ? "w" : "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new ConfigError(`create: ${path} exists; pass overwrite: true to replace it.`);
    throw error;
  });
  try {
    let written = 0;
    for (const size of batches) {
      const records = await plan.runBatch(ctx, size);
      const lines = records.map((record, i) => toLine(record, written + i));
      await file.write(lines.join(""));
      written += size;
    }
    return { path, numRecords: written, seed: ctx.seed };
  } finally {
    await file.close();
  }
}

function toLine(record: unknown, index: number): string {
  try {
    return JSON.stringify(record) + "\n";
  } catch (error) {
    // e.g. a bigint, or an object that refers to itself.
    throw new GenerationError(`create: record ${index} cannot be written as JSON: ${(error as Error).message}`);
  }
}
