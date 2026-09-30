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

/**
 * Rank-based weights for a list: the first value is the most likely, then less and less.
 * - `"zipf"` / `{ zipf: s }`: weight 1 / rank^s (s > 0, default 1). Like word frequencies or city
 *   sizes: a long, fairly fat tail. With 5 values and s = 1: about 44%, 22%, 15%, 11%, 9%.
 * - `{ geometric: r }`: weight r^(rank - 1) (0 < r <= 1). Drops off fast. With 5 values and
 *   r = 0.5: about 52%, 26%, 13%, 6%, 3%.
 * Shares depend on the list length (most for Zipf), since each list is normalized on its own.
 */
export type Skew = "zipf" | { readonly zipf: number } | { readonly geometric: number };

/**
 * `NoInfer`: the values never set `V`; `V` is `string` unless written explicitly.
 * `skew` needs the list form: a weight map already says how likely each value is.
 */
export type CategorySamplerParams<V extends string> = { id?: string } & (
  | { values: readonly NoInfer<V>[]; skew?: Skew }
  | { values: Readonly<Record<NoInfer<V>, number>>; skew?: never }
);

/**
 * Picks one of `values`, by weight. Produces `string` by default, so values can come from a
 * hand-written list or a data file alike.
 *
 * Opt in to a union of literals by writing it: `new CategorySamplerGen<Country>({ ... })`. The values
 * are then checked against it (and the map form must give every literal a weight).
 */
export class CategorySamplerGen<V extends string = string> extends BaseGen<V> {
  readonly values: CategoryValues<V>;
  readonly skew: Skew | undefined;
  private readonly table: WeightedTable<V>;

  constructor({ id, values, skew }: CategorySamplerParams<V>) {
    super(id);
    this.values = values;
    this.skew = skew;
    this.table = buildTable(values, skew, (message) => this.check(false, message));
  }

  generate(_inputs: {}, ctx: Context): V {
    return this.table.pick(ctx.rng);
  }
}

/**
 * `values`: for each category value (`K`), the values to pick from (`V`):
 * `{ Canada: ["Toronto"], France: { Paris: 3, Lyon: 1 } }`.
 * When `K` is a union of literals, a missing or unknown key is a compile error here.
 *
 * `skew` applies to each list on its own, by rank within that list, and needs every entry to be a list.
 */
export type SubCategorySamplerParams<K extends string, V extends string> = { id?: string } & (
  | { values: Readonly<Record<NoInfer<K>, readonly NoInfer<V>[]>>; skew?: Skew }
  | { values: Readonly<Record<NoInfer<K>, CategoryValues<NoInfer<V>>>>; skew?: never }
);

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
  readonly skew: Skew | undefined;
  private readonly tables = new Map<string, WeightedTable<V>>();

  constructor({ id, values, skew }: SubCategorySamplerParams<K, V>) {
    super(id);
    this.values = values;
    this.skew = skew;
    const entries = Object.entries(values) as [string, CategoryValues<V>][];
    this.check(entries.length > 0, "values must have at least one category value.");
    for (const [category, childValues] of entries) {
      const table = buildTable(childValues, skew, (message) => this.check(false, `for category '${category}': ${message}`));
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

function buildTable<V extends string>(
  values: CategoryValues<V>,
  skew: Skew | undefined,
  fail: (message: string) => void,
): WeightedTable<V> {
  if (skew !== undefined && !Array.isArray(values)) fail("skew needs values as a list; a weight map already sets the weights.");
  const entries: [V, number][] = Array.isArray(values)
    ? (values as readonly V[]).map((v, i) => [v, skew === undefined ? 1 : skewWeight(skew, i + 1, fail)])
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

/** The weight of the value at `rank` (1-based) under `skew`. */
function skewWeight(skew: Skew, rank: number, fail: (message: string) => void): number {
  if (skew === "zipf") return 1 / rank;
  if ("zipf" in skew) {
    if (!(Number.isFinite(skew.zipf) && skew.zipf > 0)) fail(`skew zipf must be > 0, got ${skew.zipf}.`);
    return 1 / rank ** skew.zipf;
  }
  if ("geometric" in skew) {
    if (!(skew.geometric > 0 && skew.geometric <= 1)) fail(`skew geometric must be in (0, 1], got ${skew.geometric}.`);
    return skew.geometric ** (rank - 1);
  }
  fail(`unknown skew ${JSON.stringify(skew)}.`);
  return 1;
}
