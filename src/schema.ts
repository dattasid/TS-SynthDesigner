import { roundTo } from "./distributions";
import { ConfigError } from "./errors";

/**
 * A small schema builder, for the data model of a tree and for JSON from LLMs. One definition gives
 * the static type, the runtime check, the JSON Schema (for APIs) and the short shape + notes (for
 * prompts), so they never drift:
 *
 *     const backStory = SchemaBuilder.object({
 *       childhood: SchemaBuilder.string({ description: "two sentences about where they grew up" }),
 *       happiness: SchemaBuilder.integer({ min: 1, max: 10 }),
 *       mood: SchemaBuilder.enum(["calm", "anxious"]),
 *     });
 *     type BackStory = Infer<typeof backStory>;
 *
 * Deliberately small: no unions, maps, refinements or transforms. `SchemaBuilder.date()` and `.temp()` are for
 * data models only: an LLM reply schema may not contain them (`llmProblems()`).
 */
export abstract class Schema<T> {
  /** Type only: the value type this schema checks. */
  declare readonly __type: T;

  constructor(readonly description: string | undefined) {
    if (description !== undefined && (typeof description !== "string" || description.trim() === "")) {
      throw new ConfigError(`schema: description must be non-empty text, got ${JSON.stringify(description)}.`);
    }
  }

  /** May be missing (in a reply: missing or null); the key is then left out of the value. */
  optional(): OptionalSchema<this> {
    return new OptionalSchema(this);
  }

  /**
   * A field that is generated and can be read by other fields (refs), but is dropped from the output
   * records: a value used on the way, like a customer used only in prompts. `Output<typeof X>` is
   * the type without these fields.
   */
  temp(): TempSchema<this> {
    return new TempSchema(this);
  }

  /** Why this schema cannot describe an LLM reply (e.g. it has a date), one line each; empty if it can. */
  llmProblems(_path = ""): string[] {
    return [];
  }

  /** The value if it fits, else a list of problems (`path: expected ..., got ...`) to show the LLM. */
  validate(value: unknown): { ok: true; value: T } | { ok: false; issues: string[] } {
    const issues: string[] = [];
    const checked = this.check(value, "", issues);
    return issues.length === 0 ? { ok: true, value: checked as T } : { ok: false, issues };
  }

  /** JSON Schema in the subset strict LLM APIs accept: every key required, no extra keys, optional = nullable. */
  abstract toJSONSchema(): Record<string, unknown>;

  /** @internal The value (null-free for optional object keys), or undefined after pushing to `issues`. */
  abstract check(value: unknown, path: string, issues: string[]): unknown;

  /** @internal The type as written in the short shape, e.g. `integer`, `"a" | "b"`, `string[]`. */
  abstract shape(indent: string): string;

  /** @internal What a valid value is, for notes and errors, e.g. "an integer from 1 to 10". */
  abstract expected(): string;

  /** Adds the description, and drops unset keywords (e.g. `maximum: undefined`). */
  protected withDescription(schema: Record<string, unknown>): Record<string, unknown> {
    const out = Object.fromEntries(Object.entries(schema).filter(([, v]) => v !== undefined));
    return this.description === undefined ? out : { ...out, description: this.description };
  }
}

/** The value type of a schema: `Infer<typeof backStory>`. */
export type Infer<S extends Schema<unknown>> = S["__type"];

const show = (value: unknown) => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

function fail(issues: string[], path: string, expected: string, value: unknown): undefined {
  issues.push(`${path || "reply"}: expected ${expected}, got ${show(value)}`);
  return undefined;
}

function checkBounds(name: string, low: number | undefined, high: number | undefined, integer: boolean): void {
  for (const [key, v] of [["min", low], ["max", high]] as const) {
    if (v !== undefined && !(integer ? Number.isSafeInteger(v) : Number.isFinite(v))) {
      throw new ConfigError(`s.${name}: ${key} must be ${integer ? "an integer" : "a finite number"}, got ${v}.`);
    }
  }
  if (low !== undefined && high !== undefined && low > high) throw new ConfigError(`s.${name}: min (${low}) is above max (${high}).`);
}

function range(low: number | undefined, high: number | undefined): string {
  if (low !== undefined && high !== undefined) return ` from ${low} to ${high}`;
  if (low !== undefined) return ` of at least ${low}`;
  if (high !== undefined) return ` of at most ${high}`;
  return "";
}

export interface DescribedParams {
  /** What the field means. Shown to the LLM in the notes (or the JSON Schema). */
  description?: string;
}

export class StringSchema extends Schema<string> {
  check(value: unknown, path: string, issues: string[]): unknown {
    return typeof value === "string" ? value : fail(issues, path, this.expected(), value);
  }
  toJSONSchema() {
    return this.withDescription({ type: "string" });
  }
  shape() {
    return "string";
  }
  expected() {
    return "a string";
  }
}

export interface NumberSchemaParams extends DescribedParams {
  min?: number;
  max?: number;
}

export interface DecimalSchemaParams extends NumberSchemaParams {
  /**
   * Decimals the number has, e.g. 2 for a price. Asked for in the prompt; a reply with more is
   * rounded, as DataDesigner does, not retried. (DataDesigner rounds the decimal text half up, so
   * 1.005 gives 1.01; this rounds the float, which is just under 1.005, so 1.00. See `roundTo`.)
   */
  decimalPlaces?: number;
}

export class NumberSchema extends Schema<number> {
  readonly min: number | undefined;
  readonly max: number | undefined;
  readonly decimalPlaces: number | undefined;

  constructor(readonly integer: boolean, { description, min, max, decimalPlaces }: DecimalSchemaParams) {
    super(description);
    checkBounds(integer ? "integer" : "number", min, max, integer);
    if (decimalPlaces !== undefined && !(Number.isInteger(decimalPlaces) && decimalPlaces >= 0 && decimalPlaces <= 15)) {
      throw new ConfigError(`SchemaBuilder.number: decimalPlaces must be an integer from 0 to 15, got ${decimalPlaces}.`);
    }
    this.min = min;
    this.max = max;
    this.decimalPlaces = decimalPlaces;
  }

  check(value: unknown, path: string, issues: string[]): unknown {
    if (typeof value !== "number" || !Number.isFinite(value)) return fail(issues, path, this.expected(), value);
    // Rounded before the bounds check, so 999.996 with max 1000 and 2 places is 1000.
    const v = roundTo(value, this.decimalPlaces);
    const ok = (!this.integer || Number.isInteger(v)) && (this.min === undefined || v >= this.min) && (this.max === undefined || v <= this.max);
    return ok ? v : fail(issues, path, this.expected(), value);
  }
  toJSONSchema() {
    // As text, not `multipleOf`: strict structured-output APIs do not all accept that keyword.
    const places = this.decimalPlaces === undefined ? undefined : `${this.decimalPlaces} decimal places`;
    const description = [this.description, places].filter((d) => d !== undefined).join("; ");
    const schema = { type: this.integer ? "integer" : "number", minimum: this.min, maximum: this.max };
    return Object.fromEntries(Object.entries({ ...schema, description: description || undefined }).filter(([, v]) => v !== undefined));
  }
  shape() {
    return this.integer ? "integer" : "number";
  }
  expected() {
    const places = this.decimalPlaces === undefined ? "" : ` with ${this.decimalPlaces} decimal places`;
    return (this.integer ? "an integer" : "a number") + range(this.min, this.max) + places;
  }
}

export class BooleanSchema extends Schema<boolean> {
  check(value: unknown, path: string, issues: string[]): unknown {
    return typeof value === "boolean" ? value : fail(issues, path, this.expected(), value);
  }
  toJSONSchema() {
    return this.withDescription({ type: "boolean" });
  }
  shape() {
    return "boolean";
  }
  expected() {
    return "true or false";
  }
}

/** A JavaScript `Date`. For data models only: JSON has no dates, so LLM reply schemas reject it. */
export class DateSchema extends Schema<Date> {
  check(value: unknown, path: string, issues: string[]): unknown {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : fail(issues, path, this.expected(), value);
  }
  override llmProblems(path = ""): string[] {
    return [`${path || "reply"}: SchemaBuilder.date() cannot be in an LLM reply (JSON has no dates); ask for SchemaBuilder.string() and convert with a FunctionGen.`];
  }
  toJSONSchema(): Record<string, unknown> {
    throw new ConfigError(this.llmProblems()[0]!);
  }
  shape() {
    return "date";
  }
  expected() {
    return "a valid Date";
  }
}

export class EnumSchema<V extends string> extends Schema<V> {
  readonly values: readonly V[];

  constructor(values: readonly V[], { description }: DescribedParams) {
    super(description);
    if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string")) {
      throw new ConfigError(`SchemaBuilder.enum: values must be a non-empty list of strings, got ${show(values)}.`);
    }
    if (new Set(values).size !== values.length) throw new ConfigError(`SchemaBuilder.enum: values repeat: ${show(values)}.`);
    this.values = [...values];
  }

  check(value: unknown, path: string, issues: string[]): unknown {
    return (this.values as readonly unknown[]).includes(value) ? value : fail(issues, path, this.expected(), value);
  }
  toJSONSchema() {
    return this.withDescription({ type: "string", enum: [...this.values] });
  }
  shape() {
    return this.values.map((v) => JSON.stringify(v)).join(" | ");
  }
  expected() {
    return this.values.length === 1 ? JSON.stringify(this.values[0]) : `one of ${this.values.map((v) => JSON.stringify(v)).join(", ")}`;
  }
}

export interface ArraySchemaParams extends DescribedParams {
  minItems?: number;
  maxItems?: number;
}

/** A list. Generic over the item schema (not just its value), so `Output` can drop temp fields inside items. */
export class ArraySchema<I extends Schema<unknown>> extends Schema<Infer<I>[]> {
  readonly minItems: number | undefined;
  readonly maxItems: number | undefined;

  constructor(readonly items: I, { description, minItems, maxItems }: ArraySchemaParams) {
    super(description);
    if (!(items instanceof Schema)) throw new ConfigError(`SchemaBuilder.array: the item schema must be made with SchemaBuilder.*, got ${show(items)}.`);
    if (items instanceof OptionalSchema) throw new ConfigError(`SchemaBuilder.array: items cannot be optional; use SchemaBuilder.array(x).optional() for an optional list.`);
    if (items instanceof TempSchema) throw new ConfigError(`SchemaBuilder.array: items cannot be temp; use SchemaBuilder.array(x).temp() for a temp list.`);
    checkBounds("array", minItems, maxItems, true);
    if ((minItems ?? 0) < 0) throw new ConfigError(`SchemaBuilder.array: minItems must be >= 0, got ${minItems}.`);
    this.minItems = minItems;
    this.maxItems = maxItems;
  }

  check(value: unknown, path: string, issues: string[]): unknown {
    if (!Array.isArray(value)) return fail(issues, path, this.expected(), value);
    const before = issues.length;
    if ((this.minItems !== undefined && value.length < this.minItems) || (this.maxItems !== undefined && value.length > this.maxItems)) {
      issues.push(`${path || "reply"}: expected ${this.countText()}, got ${value.length}`);
    }
    const out = value.map((item, i) => this.items.check(item, `${path}[${i}]`, issues));
    return issues.length === before ? out : undefined;
  }
  override llmProblems(path = ""): string[] {
    return this.items.llmProblems(`${path}[]`);
  }
  toJSONSchema() {
    return this.withDescription({ type: "array", items: this.items.toJSONSchema(), minItems: this.minItems, maxItems: this.maxItems });
  }
  shape(indent: string) {
    const item = this.items.shape(indent);
    return this.items instanceof EnumSchema && this.items.values.length > 1 ? `(${item})[]` : `${item}[]`;
  }
  expected() {
    const count = this.minItems === undefined && this.maxItems === undefined ? "" : `, ${this.countText()}`;
    return `a list of ${plural(this.items.expected())}${count}`;
  }
  private countText(): string {
    const { minItems: low, maxItems: high } = this;
    if (low !== undefined && high !== undefined) return low === high ? `exactly ${low} items` : `${low} to ${high} items`;
    return low !== undefined ? `at least ${low} items` : `at most ${high} items`;
  }
}

/** "an integer from 1 to 10" -> "integers from 1 to 10", for "a list of ...". */
function plural(expected: string): string {
  return expected
    .replace(/^an? (string|number|integer|object)\b/, "$1s")
    .replace(/^true or false$/, "true/false values")
    .replace(/^one of /, "values, each one of ");
}

/** A field that may be missing (or null) in the reply. Made by `.optional()`. */
export class OptionalSchema<S extends Schema<unknown>> extends Schema<Infer<S> | undefined> {
  constructor(readonly inner: S) {
    super(inner.description);
    if (inner instanceof OptionalSchema) throw new ConfigError(`schema: .optional() was called twice.`);
  }

  check(value: unknown, path: string, issues: string[]): unknown {
    return value === null || value === undefined ? undefined : this.inner.check(value, path, issues);
  }
  /** `.optional().temp()` is the way round: the temp marker goes outside. */
  override temp(): TempSchema<this> {
    return new TempSchema(this);
  }
  override llmProblems(path = ""): string[] {
    return this.inner.llmProblems(path);
  }
  toJSONSchema() {
    // Strict APIs require every key; "optional" is spelled as "or null".
    const { description, ...inner } = this.inner.toJSONSchema();
    return this.withDescription({ anyOf: [inner, { type: "null" }] });
  }
  shape(indent: string) {
    return `${this.inner.shape(indent)} | null`;
  }
  expected() {
    return `${this.inner.expected()}, or null`;
  }
}

/**
 * A field generated and readable by refs, but dropped from output records. Made by `.temp()`; to
 * combine with optional, write `.optional().temp()`.
 */
export class TempSchema<S extends Schema<unknown>> extends Schema<Infer<S>> {
  constructor(readonly inner: S) {
    super(inner.description);
    if (inner instanceof TempSchema) throw new ConfigError(`schema: .temp() was called twice.`);
  }

  override optional(): never {
    throw new ConfigError(`schema: write .optional().temp(), not .temp().optional().`);
  }
  override temp(): never {
    throw new ConfigError(`schema: .temp() was called twice.`);
  }
  check(value: unknown, path: string, issues: string[]): unknown {
    return this.inner.check(value, path, issues);
  }
  override llmProblems(path = ""): string[] {
    return [`${path || "reply"}: .temp() fields cannot be in an LLM reply (they are dropped from output records, which a reply is not).`];
  }
  toJSONSchema(): Record<string, unknown> {
    throw new ConfigError(this.llmProblems()[0]!);
  }
  shape(indent: string) {
    return this.inner.shape(indent);
  }
  expected() {
    return this.inner.expected();
  }
}

const isOptional = (field: Schema<unknown>) =>
  field instanceof OptionalSchema || (field instanceof TempSchema && field.inner instanceof OptionalSchema);

type Fields = Record<string, Schema<unknown>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
/** The schema under a `.temp()` marker. */
type Unmarked<S> = S extends TempSchema<infer I> ? I : S;
type OptionalKeys<F extends Fields> = { [K in keyof F]: Unmarked<F[K]> extends OptionalSchema<any> ? K : never }[keyof F];
type TempKeys<F extends Fields> = { [K in keyof F]: F[K] extends TempSchema<any> ? K : never }[keyof F];

/** The value type of an object schema: optional fields become optional keys. Temp fields are included. */
export type ObjectValue<F extends Fields> = Simplify<
  { [K in Exclude<keyof F, OptionalKeys<F>>]: Infer<F[K]> } & { [K in OptionalKeys<F>]?: Exclude<Infer<F[K]>, undefined> }
>;

/**
 * The type of output records: `Infer<typeof X>` without the `.temp()` fields, at every depth
 * (nested objects and list items too). `Infer` is what refs see; `Output` is what `preview` returns.
 */
export type Output<S> =
  S extends ObjectSchema<infer F>
    ? Simplify<
        { [K in Exclude<keyof F, OptionalKeys<F> | TempKeys<F>>]: Output<F[K]> } & {
          [K in Exclude<OptionalKeys<F>, TempKeys<F>>]?: Exclude<Output<Unmarked<F[K]>>, undefined>;
        }
      >
    : S extends ArraySchema<infer I>
      ? Output<I>[]
      : S extends OptionalSchema<infer I>
        ? Output<I> | undefined
        : S extends Schema<infer T>
          ? T
          : never;

export interface ObjectSchemaParams extends DescribedParams {
  /**
   * What to call this object in messages: refs made from it show as `person.country` instead of
   * `root.country`. An identifier, e.g. "person".
   */
  name?: string;
}

export class ObjectSchema<F extends Fields> extends Schema<ObjectValue<F>> {
  readonly fields: Readonly<F>;
  readonly name: string | undefined;

  constructor(fields: F, { description, name }: ObjectSchemaParams) {
    super(description);
    if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(name))) {
      throw new ConfigError(`SchemaBuilder.object: name must be an identifier like "person", got ${JSON.stringify(name)}.`);
    }
    this.name = name;
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
      throw new ConfigError(`SchemaBuilder.object: fields must be an object of schemas, got ${show(fields)}.`);
    }
    if (Object.keys(fields).length === 0) throw new ConfigError(`SchemaBuilder.object: needs at least one field.`);
    for (const [key, field] of Object.entries(fields)) {
      if (!(field instanceof Schema)) throw new ConfigError(`SchemaBuilder.object: field '${key}' must be made with SchemaBuilder.*, got ${show(field)}.`);
    }
    this.fields = { ...fields };
  }

  /**
   * Keys not in the schema are dropped. They are only reported (to help the LLM fix a misspelled
   * key) when a field is missing too.
   */
  check(value: unknown, path: string, issues: string[]): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(issues, path, "an object", value);
    const before = issues.length;
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let missing = false;
    for (const [key, field] of Object.entries(this.fields)) {
      const at = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(record, key) && !isOptional(field)) {
        issues.push(`${at}: missing`);
        missing = true;
        continue;
      }
      const v = field.check(record[key], at, issues);
      if (v !== undefined) out[key] = v;
    }
    if (missing) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(this.fields, key)) issues.push(`${path ? `${path}.` : ""}${key}: not a field of this object`);
      }
    }
    return issues.length === before ? out : undefined;
  }

  override llmProblems(path = ""): string[] {
    return Object.entries(this.fields).flatMap(([key, field]) => field.llmProblems(path ? `${path}.${key}` : key));
  }

  /**
   * A schema with only these fields, like TypeScript's `Pick`. The field schemas are the same objects,
   * so refs made from this schema fit trees of the smaller one. (To add fields, spread:
   * `SchemaBuilder.object({ ...Person.fields, email: SchemaBuilder.string() })`.)
   */
  pick<const K extends keyof F & string>(...keys: K[]): ObjectSchema<Pick<F, K>> {
    for (const key of keys) {
      if (!Object.hasOwn(this.fields, key)) throw new ConfigError(`pick: '${key}' is not a field. Fields: ${Object.keys(this.fields).join(", ")}.`);
    }
    return new ObjectSchema(Object.fromEntries(keys.map((k) => [k, this.fields[k]])) as Pick<F, K>, { description: this.description, name: this.name });
  }

  /** The keys of `.temp()` fields, at this level. */
  get tempKeys(): string[] {
    return Object.keys(this.fields).filter((k) => this.fields[k] instanceof TempSchema);
  }

  /** The keys that may be missing (`.optional()`, also under `.temp()`). */
  get optionalKeys(): string[] {
    return Object.keys(this.fields).filter((k) => isOptional(this.fields[k]!));
  }

  toJSONSchema() {
    const properties = Object.fromEntries(Object.entries(this.fields).map(([k, f]) => [k, f.toJSONSchema()]));
    return this.withDescription({ type: "object", properties, required: Object.keys(this.fields), additionalProperties: false });
  }

  shape(indent: string) {
    const inner = indent + "  ";
    const lines = Object.entries(this.fields).map(([k, f]) => `${inner}${JSON.stringify(k)}: ${f.shape(inner)}`);
    return `{\n${lines.join(",\n")}\n${indent}}`;
  }

  expected() {
    return "an object";
  }

  /**
   * One line per field (nested ones as `address.city`, list items as `jobs[].title`): its
   * description, then what a valid value is. Generated, so it always matches the schema.
   */
  notes(): string[] {
    const lines: string[] = [];
    const walkFields = (object: ObjectSchema<Fields>, prefix: string) => {
      for (const [key, field] of Object.entries(object.fields)) {
        const path = prefix + key;
        const optional = field instanceof OptionalSchema;
        const inner = optional ? field.inner : field;
        const nested = inner instanceof ObjectSchema ? inner : inner instanceof ArraySchema && inner.items instanceof ObjectSchema ? inner.items : undefined;
        // A described string needs no "a string"; a plain nested object needs no line of its own.
        const what = inner instanceof StringSchema && field.description ? "" : inner.expected();
        if (!(inner instanceof ObjectSchema && !field.description && !optional)) {
          lines.push(`- ${path}: ${[field.description, what, optional ? "optional (null if unknown)" : ""].filter(Boolean).join("; ")}`);
        }
        if (nested) walkFields(nested, inner instanceof ArraySchema ? `${path}[].` : `${path}.`);
      }
    };
    walkFields(this as ObjectSchema<Fields>, "");
    return lines;
  }
}

/**
 * The schema builder. See `Schema`. Short to alias, as the examples do:
 *
 *     const s = SchemaBuilder;
 *     const Person = s.object({ name: s.string(), age: s.integer({ min: 0 }) });
 */
export const SchemaBuilder = {
  string: (params: DescribedParams = {}) => new StringSchema(params.description),
  number: (params: DecimalSchemaParams = {}) => new NumberSchema(false, params),
  integer: (params: NumberSchemaParams = {}) => new NumberSchema(true, params),
  boolean: (params: DescribedParams = {}) => new BooleanSchema(params.description),
  enum: <const V extends string>(values: readonly V[], params: DescribedParams = {}) => new EnumSchema<V>(values, params),
  date: (params: DescribedParams = {}) => new DateSchema(params.description),
  array: <I extends Schema<unknown>>(items: I, params: ArraySchemaParams = {}) => new ArraySchema<I>(items, params),
  object: <F extends Fields>(fields: F, params: ObjectSchemaParams = {}) => new ObjectSchema<F>(fields, params),
};
