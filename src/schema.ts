import { ConfigError } from "./errors";

/**
 * A small schema builder for JSON from LLMs. One definition gives the static type, the runtime
 * check, the JSON Schema (for APIs) and the short shape + notes (for prompts), so they never drift:
 *
 *     const backStory = s.object({
 *       childhood: s.string({ description: "two sentences about where they grew up" }),
 *       happiness: s.integer({ min: 1, max: 10 }),
 *       mood: s.enum(["calm", "anxious"]),
 *     });
 *     type BackStory = Infer<typeof backStory>;
 *
 * To check a schema against an existing interface: `const backStory: Schema<BackStory> = s.object({...})`.
 *
 * Deliberately small: only what LLM APIs accept as JSON Schema. No refinements or transforms; a
 * schema that needs those has outgrown this builder (use zod).
 */
export abstract class Schema<T> {
  /** Type only: the value type this schema checks. */
  declare readonly __type: T;

  constructor(readonly description: string | undefined) {
    if (description !== undefined && (typeof description !== "string" || description.trim() === "")) {
      throw new ConfigError(`schema: description must be non-empty text, got ${JSON.stringify(description)}.`);
    }
  }

  /** Missing or null in a reply is allowed; the key is then left out of the value. */
  optional(): OptionalSchema<T> {
    return new OptionalSchema(this);
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

export class NumberSchema extends Schema<number> {
  readonly min: number | undefined;
  readonly max: number | undefined;

  constructor(readonly integer: boolean, { description, min, max }: NumberSchemaParams) {
    super(description);
    checkBounds(integer ? "integer" : "number", min, max, integer);
    this.min = min;
    this.max = max;
  }

  check(value: unknown, path: string, issues: string[]): unknown {
    const ok =
      typeof value === "number" &&
      Number.isFinite(value) &&
      (!this.integer || Number.isInteger(value)) &&
      (this.min === undefined || value >= this.min) &&
      (this.max === undefined || value <= this.max);
    return ok ? value : fail(issues, path, this.expected(), value);
  }
  toJSONSchema() {
    return this.withDescription({ type: this.integer ? "integer" : "number", minimum: this.min, maximum: this.max });
  }
  shape() {
    return this.integer ? "integer" : "number";
  }
  expected() {
    return (this.integer ? "an integer" : "a number") + range(this.min, this.max);
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

export class EnumSchema<V extends string> extends Schema<V> {
  readonly values: readonly V[];

  constructor(values: readonly V[], { description }: DescribedParams) {
    super(description);
    if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string")) {
      throw new ConfigError(`s.enum: values must be a non-empty list of strings, got ${show(values)}.`);
    }
    if (new Set(values).size !== values.length) throw new ConfigError(`s.enum: values repeat: ${show(values)}.`);
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

export class ArraySchema<T> extends Schema<T[]> {
  readonly minItems: number | undefined;
  readonly maxItems: number | undefined;

  constructor(readonly items: Schema<T>, { description, minItems, maxItems }: ArraySchemaParams) {
    super(description);
    if (!(items instanceof Schema)) throw new ConfigError(`s.array: the item schema must be made with s.*, got ${show(items)}.`);
    if (items instanceof OptionalSchema) throw new ConfigError(`s.array: items cannot be optional; use s.array(x).optional() for an optional list.`);
    checkBounds("array", minItems, maxItems, true);
    if ((minItems ?? 0) < 0) throw new ConfigError(`s.array: minItems must be >= 0, got ${minItems}.`);
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
export class OptionalSchema<T> extends Schema<T | undefined> {
  constructor(readonly inner: Schema<T>) {
    super(inner.description);
    if (inner instanceof OptionalSchema) throw new ConfigError(`schema: .optional() was called twice.`);
  }

  check(value: unknown, path: string, issues: string[]): unknown {
    return value === null || value === undefined ? undefined : this.inner.check(value, path, issues);
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

type Fields = Record<string, Schema<unknown>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OptionalKeys<F extends Fields> = { [K in keyof F]: F[K] extends OptionalSchema<any> ? K : never }[keyof F];

/** The value type of an object schema: optional fields become optional keys. */
export type ObjectValue<F extends Fields> = Simplify<
  { [K in Exclude<keyof F, OptionalKeys<F>>]: Infer<F[K]> } & { [K in OptionalKeys<F>]?: Exclude<Infer<F[K]>, undefined> }
>;

export class ObjectSchema<F extends Fields> extends Schema<ObjectValue<F>> {
  readonly fields: Readonly<F>;

  constructor(fields: F, { description }: DescribedParams) {
    super(description);
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
      throw new ConfigError(`s.object: fields must be an object of schemas, got ${show(fields)}.`);
    }
    if (Object.keys(fields).length === 0) throw new ConfigError(`s.object: needs at least one field.`);
    for (const [key, field] of Object.entries(fields)) {
      if (!(field instanceof Schema)) throw new ConfigError(`s.object: field '${key}' must be made with s.*, got ${show(field)}.`);
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
      if (!Object.hasOwn(record, key) && !(field instanceof OptionalSchema)) {
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

/** The schema builder. See `Schema`. */
export const s = {
  string: (params: DescribedParams = {}) => new StringSchema(params.description),
  number: (params: NumberSchemaParams = {}) => new NumberSchema(false, params),
  integer: (params: NumberSchemaParams = {}) => new NumberSchema(true, params),
  boolean: (params: DescribedParams = {}) => new BooleanSchema(params.description),
  enum: <const V extends string>(values: readonly V[], params: DescribedParams = {}) => new EnumSchema<V>(values, params),
  array: <T>(items: Schema<T>, params: ArraySchemaParams = {}) => new ArraySchema<T>(items, params),
  object: <F extends Fields>(fields: F, params: DescribedParams = {}) => new ObjectSchema<F>(fields, params),
};
