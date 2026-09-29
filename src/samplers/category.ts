import type { Context } from "../context";
import { WeightedTable } from "../distributions";
import { GenerationError } from "../errors";
import { BaseGen, type BoundGen, type Ref } from "../gen";

/**
 * Either a map of value to weight (`{ doctor: 2, lawyer: 1 }`), or a list of values with equal weights.
 * Weights are relative and need not sum to 1. A weight of 0 means the value is never picked.
 */
export type CategoryValues<V extends string> = Readonly<Record<V, number>> | readonly V[];

export interface CategorySamplerParams<V extends string> {
  id?: string;
  values: CategoryValues<V>;
}

/** Picks one of `values`, by weight. */
export class CategorySamplerGen<V extends string> extends BaseGen<V> {
  readonly values: CategoryValues<V>;
  private readonly table: WeightedTable<V>;

  constructor({ id, values }: CategorySamplerParams<V>) {
    super(id);
    this.values = values;
    this.table = buildTable(values, (message) => this.check(false, message));
  }

  generate(_deps: {}, ctx: Context): V {
    return this.table.pick(ctx.rng);
  }
}

/** For each category value, its CategoryValues: `{ Canada: ["Toronto"], France: { Paris: 3, Lyon: 1 } }`. */
export type SubCategoryValues = Readonly<Record<string, CategoryValues<string>>>;

/** The values a SubCategorySamplerGen can produce: every list item and map key in `M`. */
export type SubCategoryOutput<M extends SubCategoryValues> = {
  [K in keyof M]: M[K] extends readonly (infer X)[] ? X : keyof M[K];
}[keyof M] &
  string;

export interface SubCategorySamplerParams<M extends SubCategoryValues> {
  id?: string;
  /**
   * For each category value, the values to pick from. When the field bound to `category` is a union
   * of literals (`"S" | "M" | "L"`), a literal with no key here is a compile error at `bind()`; for a
   * plain `string` field it fails at generation time.
   */
  values: M;
}

/**
 * Picks a value from the list for the value of its `category` input, e.g. a city within a country.
 * Bind the input to a field: `cityGen.bind({ category: person("country") })`.
 */
export class SubCategorySamplerGen<const M extends SubCategoryValues> extends BaseGen<
  SubCategoryOutput<M>,
  { category: string }
> {
  readonly values: M;
  private readonly tables = new Map<string, WeightedTable<SubCategoryOutput<M>>>();

  constructor({ id, values }: SubCategorySamplerParams<M>) {
    super(id);
    this.values = values;
    const entries = Object.entries(values) as [string, CategoryValues<SubCategoryOutput<M>>][];
    this.check(entries.length > 0, "values must have at least one category value.");
    for (const [category, childValues] of entries) {
      const table = buildTable(childValues, (message) => this.check(false, `for category '${category}': ${message}`));
      this.tables.set(category, table);
    }
  }

  /**
   * Like `BaseGen.bind`, plus a completeness check: when the bound field is a union of literals,
   * every literal must have an entry in `values`. The error names the missing ones.
   */
  override bind<F extends string>(inputs: { category: Ref<F> & CoversAll<F, keyof M & string> }): BoundGen<SubCategoryOutput<M>> {
    return super.bind(inputs);
  }

  generate({ category }: { category: string }, ctx: Context): SubCategoryOutput<M> {
    const table = this.tables.get(category);
    if (!table) {
      throw new GenerationError(
        `${this.describe()} at ${ctx.pathString}: category '${category}' has no entry in values. ` +
          `Known categories: ${[...this.tables.keys()].join(", ")}.`,
      );
    }
    return table.pick(ctx.rng);
  }
}

/** `unknown` (no constraint) when `F` is plain `string` or fully covered by `P`; otherwise names what is missing. */
type CoversAll<F extends string, P extends string> = string extends F
  ? unknown
  : [F] extends [P]
    ? unknown
    : { missingCategories: Exclude<F, P> };

function buildTable<V extends string>(values: CategoryValues<V>, fail: (message: string) => void): WeightedTable<V> {
  const entries: [V, number][] = Array.isArray(values)
    ? (values as readonly V[]).map((v) => [v, 1])
    : (Object.entries(values) as [V, number][]);
  if (entries.length === 0) fail("values must not be empty.");
  if (Array.isArray(values) && new Set(values).size !== values.length) fail("values must not contain duplicates.");
  for (const [value, weight] of entries) {
    if (!Number.isFinite(weight) || weight < 0) fail(`weight of '${value}' must be finite and >= 0, got ${weight}.`);
  }
  if (!entries.some(([, weight]) => weight > 0)) fail("at least one weight must be > 0.");
  return new WeightedTable(
    entries.map(([value]) => value),
    entries.map(([, weight]) => weight),
  );
}
