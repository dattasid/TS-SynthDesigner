import type { Context } from "../context";
import { WeightedTable } from "../distributions";
import { GenerationError } from "../errors";
import { BaseGen } from "../gen";

/**
 * Either a map of value to weight (`{ doctor: 2, lawyer: 1 }`), or a list of values with equal weights.
 * Weights are relative and need not sum to 1. A weight of 0 means the value is never picked.
 * Both forms are converted to one weight table when the Gen is constructed.
 */
export type CategoryValues<V extends string = string> = Readonly<Record<V, number>> | readonly V[];

export interface CategorySamplerParams<V extends string> {
  id?: string;
  /** `NoInfer`: the values never set `V`. `V` is `string` unless written explicitly. */
  values: CategoryValues<NoInfer<V>>;
}

/**
 * Picks one of `values`, by weight. Produces `string` by default, so values can come from a
 * hand-written list or a data file alike.
 *
 * Opt in to a union of literals by writing it: `new CategorySamplerGen<Country>({ ... })`. The values
 * are then checked against it (and the map form must give every literal a weight).
 */
export class CategorySamplerGen<V extends string = string> extends BaseGen<V> {
  readonly values: CategoryValues<V>;
  private readonly table: WeightedTable<V>;

  constructor({ id, values }: CategorySamplerParams<V>) {
    super(id);
    this.values = values;
    this.table = buildTable(values, (message) => this.check(false, message));
  }

  generate(_inputs: {}, ctx: Context): V {
    return this.table.pick(ctx.rng);
  }
}

export interface SubCategorySamplerParams<K extends string, V extends string> {
  id?: string;
  /**
   * For each category value (`K`), the values to pick from (`V`):
   * `{ Canada: ["Toronto"], France: { Paris: 3, Lyon: 1 } }`.
   * When `K` is a union of literals, a missing or unknown key is a compile error here.
   */
  values: Readonly<Record<NoInfer<K>, CategoryValues<NoInfer<V>>>>;
}

/**
 * Picks a value from the list for the value of its `category` input, e.g. a city within a country.
 * Bind the input to a field: `cityGen.bind({ category: person("country") })`.
 *
 * `K` (category keys) and `V` (values) are `string` unless written explicitly:
 * `new SubCategorySamplerGen<Size>({ ... })` makes the map cover every `Size`, and then only a field
 * of type `Size` can be bound to `category`. With plain `string`, a category value that has no entry
 * fails at generation time.
 */
export class SubCategorySamplerGen<K extends string = string, V extends string = string> extends BaseGen<
  V,
  { category: K }
> {
  readonly values: Readonly<Record<K, CategoryValues<V>>>;
  private readonly tables = new Map<string, WeightedTable<V>>();

  constructor({ id, values }: SubCategorySamplerParams<K, V>) {
    super(id);
    this.values = values;
    const entries = Object.entries(values) as [string, CategoryValues<V>][];
    this.check(entries.length > 0, "values must have at least one category value.");
    for (const [category, childValues] of entries) {
      const table = buildTable(childValues, (message) => this.check(false, `for category '${category}': ${message}`));
      this.tables.set(category, table);
    }
  }

  override get inputNames(): readonly string[] {
    return ["category"];
  }

  generate({ category }: { category: K }, ctx: Context): V {
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
