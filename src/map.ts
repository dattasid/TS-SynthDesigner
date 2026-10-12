import { ConfigError } from "./errors";
import { SourceRowGen } from "./custom";
import { preview, type PreviewParams, type PreviewResults } from "./preview";
import type { Infer, Output } from "./schema";
import { TreeGen, type AnyObjectSchema, type Fields } from "./tree";

export interface MapTreeParams<S extends AnyObjectSchema, K extends keyof Infer<S> & string> {
  id?: string;
  /** The schema of the new rows: the same shape as the source rows, or any other. */
  schema: S;
  /**
   * The field that holds the source row: row i gets `rows[i]`. Its schema says what the other fields
   * can read of it (refs like `r.src.title`); make it `.temp()` to leave it out of the output.
   */
  as: K;
  /** The source rows, e.g. the records of an earlier run. Extra keys are fine; they are dropped. */
  rows: readonly Infer<S>[K][];
  /** The Gens of every other field. */
  fields: Omit<Fields<Infer<S>>, K>;
}

/**
 * A tree that makes one new row per source row: `as` gets the source row (a `SourceRowGen` in
 * order), and the other fields are made from it. For `create()`, with `numRecords: rows.length`;
 * `mapRows` runs it for you.
 */
export function mapTree<S extends AnyObjectSchema, K extends keyof Infer<S> & string>({ id, schema, as, rows, fields }: MapTreeParams<S, K>): TreeGen<S> {
  if (Object.hasOwn(fields, as)) throw new ConfigError(`mapTree: '${as}' gets the source rows, so it cannot also be in fields.`);
  return new TreeGen<S>({ id, schema, fields: { ...fields, [as]: new SourceRowGen({ rows, pick: "ordered" }) } as unknown as Fields<Infer<S>> });
}

export type MapRowsParams<S extends AnyObjectSchema, K extends keyof Infer<S> & string> = MapTreeParams<S, K> &
  Omit<PreviewParams<TreeGen<S>>, "gen" | "numRecords">;

/**
 * A new row for each source row, in order: a map over an earlier run (or any dataset). The new rows
 * can have the same shape or another one:
 *
 *     const Summary = s.object({ bug: BugSource.temp(), oneLiner: s.string() });
 *     const r = rootRefs(Summary);
 *     const { records } = await mapRows({
 *       schema: Summary,
 *       as: "bug",
 *       rows: bugs,
 *       fields: { oneLiner: new LLMTextGen({ model: "fast", prompt: prompt`Summarize: ${json(r.bug)}` }) },
 *       seed, providers, models,
 *     });
 *
 * To let each row look at any row of an earlier run instead (pick one, search them), see `SourceRowGen`,
 * or a `CustomGen` holding the rows.
 */
export function mapRows<S extends AnyObjectSchema, K extends keyof Infer<S> & string>(params: MapRowsParams<S, K>): Promise<PreviewResults<Output<S>>> {
  const { id, schema, as, rows, fields, ...run } = params;
  return preview({ ...run, gen: mapTree({ id, schema, as, rows, fields }), numRecords: rows.length });
}
