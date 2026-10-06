// FakerGen lives in its own entry point, "ts-synthdesigner/faker", so that faker-js (a large, optional
// peer dependency) is only loaded by projects that use it.
import { base, en, Faker, type LocaleDefinition, type Randomizer } from "@faker-js/faker";
import type { Context } from "./context";
import type { RefValues } from "./custom";
import { ConfigError, GenerationError } from "./errors";
import { BaseGen, BoundGen, type Ref } from "./gen";
import type { Rng } from "./rng";

/**
 * The date faker's relative dates count from (`faker.date.past()`, `birthdate({ mode: "age" })`, ...)
 * unless `refDate` is given. Fixed, not "now", so a seed gives the same data on any day.
 */
export const FAKER_DEFAULT_REF_DATE = "2025-01-01T00:00:00.000Z";

export interface FakerGenParams<Out, Inputs> {
  id?: string;
  /**
   * Makes the value with `faker`. Type the second parameter to declare inputs; `Out` is inferred from
   * the return. Must be synchronous.
   */
  fn: (faker: Faker, inputs: Inputs) => Out;
  /**
   * faker locale data, e.g. `[de, en, base]` from "@faker-js/faker" (the first that defines a thing
   * wins). Default `[en, base]`.
   */
  locale?: LocaleDefinition | LocaleDefinition[];
  /** See `FAKER_DEFAULT_REF_DATE`. Pass `new Date()` for dates relative to today (not reproducible). */
  refDate?: Date | string | number;
}

export interface FakerGenBoundParams<R extends Record<string, Ref<unknown>>, Out> {
  id?: string;
  /** Which fields feed the inputs: `{ sex: c.sex }`. */
  inputs: R;
  /** Makes the value with `faker`. Its input types come from the refs. */
  fn: (faker: Faker, inputs: RefValues<R>) => Out;
  locale?: LocaleDefinition | LocaleDefinition[];
  refDate?: Date | string | number;
}

/**
 * Names, addresses, emails, dates, ... from faker-js (https://fakerjs.dev). The counterpart of
 * DataDesigner's Faker-based person sampler, one value per field:
 *
 *     import { FakerGen } from "ts-synthdesigner/faker";
 *
 *     lastName: new FakerGen({ fn: (f) => f.person.lastName() }),
 *     firstName: FakerGen.bound({ inputs: { sex: c.sex }, fn: (f, { sex }) => f.person.firstName(sex) }),
 *
 * faker draws from the field's own random stream, so the data is reproducible from the run's seed,
 * like every other Gen. `faker.seed()` is therefore not allowed; seed the run instead.
 */
export class FakerGen<Out, Inputs = {}> extends BaseGen<Out, Inputs> {
  readonly fn: (faker: Faker, inputs: Inputs) => Out;
  private readonly randomizer = new FieldRandomizer();
  private readonly faker: Faker;

  constructor({ id, fn, locale = [en, base], refDate = FAKER_DEFAULT_REF_DATE }: FakerGenParams<Out, Inputs>) {
    super(id);
    this.check(typeof fn === "function", "fn must be a function.");
    const date = new Date(refDate);
    this.check(!Number.isNaN(date.getTime()), `refDate is not a valid date: ${JSON.stringify(refDate)}.`);
    this.fn = fn;
    this.faker = new Faker({ locale, randomizer: this.randomizer });
    this.faker.setDefaultRefDate(date);
  }

  /** The one-off form: a FakerGen already bound to `inputs`, ready to be a field. */
  static bound<const R extends Record<string, Ref<unknown>>, Out>({ inputs, ...params }: FakerGenBoundParams<R, Out>): BoundGen<Out> {
    return new FakerGen<Out, RefValues<R>>(params).bind(inputs as never);
  }

  generate(inputs: Inputs, ctx: Context): Out {
    this.randomizer.rng = ctx.rng;
    let value: Out;
    try {
      value = this.fn(this.faker, inputs);
    } finally {
      this.randomizer.rng = undefined;
    }
    if (value instanceof Promise) {
      throw new GenerationError(`${this.describe()} at ${ctx.pathString}: fn must be synchronous (faker draws only while it runs).`);
    }
    return value;
  }
}

/** faker's random source: the stream of the field being generated, swapped in for each call. */
class FieldRandomizer implements Randomizer {
  rng: Rng | undefined;

  next(): number {
    if (!this.rng) throw new ConfigError("this Faker belongs to a FakerGen and only draws inside its fn.");
    return this.rng.random();
  }

  seed(): void {
    throw new ConfigError("FakerGen draws from the field's random stream; seed the run (e.g. preview({ seed })) instead of faker.seed().");
  }
}
