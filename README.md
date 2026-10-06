# TS-SynthDesigner

**Synthetic data generation for TypeScript: schema-first trees, DAG dependency tracking, typed LLM calls.**

You describe the data once, as a schema. Every field gets a generator: a sampler, a Faker call, a
function or an LLM. Fields read each other, and the library works out the order. The TypeScript
compiler checks the wiring: a misspelled field, a generator of the wrong type or a missing input is
a red squiggle in your editor, not a failed run an hour into a batch of LLM calls.

Inspired by [NVIDIA NeMo Data Designer](https://github.com/NVIDIA-NeMo/DataDesigner), and ports two of its
tutorials (see [Examples](#examples)). This is an independent project, not affiliated with NVIDIA.

## Highlights

- **Compile-time checks.** Refs to fields are typed property access (`p.country`), so typos,
  type mismatches, unbound inputs and missing fields fail to compile.
- **Typed, validated LLM replies.** One schema gives the TypeScript type, the shape the model is
  told to reply in, and the check of each reply. An invalid reply is retried, with the model shown
  exactly what was wrong.
- **Dependencies as a DAG.** Fields can read siblings, their parent or the root of the record. The
  generation order comes from those reads, and cycles are reported up front.
- **Constrained and custom fields.** Rejection sampling with conditions on other fields, plus plain
  functions as generators, typed from their inputs.
- **Prompt building.** Tagged-template prompts whose holes are typed refs, conditional sections
  (`match`), JSON for nested values, and only the rows that need an LLM call make one.
- **Reproducible.** One seed gives the same data, at any batch size.

## Quick look

A person with three fields: `city` depends on `country`.

```ts
import { CategorySamplerGen, NumberSamplerGen, preview, rootRefs, s, SubCategorySamplerGen, TreeGen } from "ts-synthdesigner";

const Person = s.object({
  country: s.string(),
  city: s.string(),
  age: s.integer({ min: 0, max: 120 }),
});
const p = rootRefs(Person); // typed refs to Person's fields

const person = new TreeGen({
  schema: Person,
  fields: {
    country: new CategorySamplerGen({ values: { Canada: 2, Japan: 1 } }), // weighted
    city: new SubCategorySamplerGen({
      values: { Canada: ["Toronto", "Vancouver"], Japan: ["Tokyo", "Kyoto"] },
    }).bind({ category: p.country }), // city depends on country
    age: new NumberSamplerGen({ type: "uniform", low: 18, high: 90, integer: true }),
  },
});

const { records } = await preview({ gen: person, numRecords: 5, seed: 2026 });
// [{ country: "Japan", city: "Tokyo", age: 48 }, { country: "Japan", city: "Kyoto", age: 80 },
//  { country: "Canada", city: "Vancouver", age: 57 }, ...]
```

The same tree, built step by step, for loops, conditionals or fields added later. Each `field()` is
type-checked, and `build()` checks that every field has a generator:

```ts
const b = TreeGen.builder({ schema: Person });
b.field({ name: "country", gen: new CategorySamplerGen({ values: { Canada: 2, Japan: 1 } }) });
b.field({
  name: "city",
  gen: new SubCategorySamplerGen({
    values: { Canada: ["Toronto", "Vancouver"], Japan: ["Tokyo", "Kyoto"] },
  }).bind({ category: p.country }),
});
b.field({ name: "age", gen: new NumberSamplerGen({ type: "uniform", low: 18, high: 90, integer: true }) });
const samePerson = b.build();
```

Trees nest: a field can be another `TreeGen`, whose fields can read the parent (`parentRefs`) or the
top of the record (`rootRefs`).

## Compile-time checks

Each of these is a compile error:

```ts
p.cuntry;                     // no field 'cuntry' on Person

new TreeGen({
  schema: Person,
  fields: { country, city },  // 'age' has no generator
});

new TreeGen({
  schema: Person,
  fields: {
    country,
    city: new SubCategorySamplerGen({ values: { Canada: ["Toronto"] } }), // input 'category' not bound
    age: new CategorySamplerGen({ values: ["young", "old"] }),            // age is a number, this makes strings
  },
});

cityGen.bind({ category: p.age });                         // category is a string, age is a number
new NumberSamplerGen({ type: "gaussian", mean: 170, high: 200 }); // gaussian takes stddev, not high

CustomGen.bound({ inputs: { age: p.age }, fn: ({ age }) => age.toUpperCase() }); // age is a number
```

What types cannot see (bounds, enum values from an LLM, plain JavaScript) is checked at runtime:
every record is validated against its schema, and the error names the record and the field.

## LLM fields with typed replies

```ts
const Review = s.object({
  rating: s.integer({ min: 1, max: 5 }),
  mood: s.enum(["happy", "neutral", "mad"]),
  price: s.number({ min: 10, max: 1000, decimalPlaces: 2, description: "price paid, in USD" }),
  text: s.string({ description: "the review, nothing else" }),
});
const Order = s.object({ product: s.string(), customer: s.string(), review: Review });
const o = rootRefs(Order);

const order = new TreeGen({
  schema: Order,
  fields: {
    product: new CategorySamplerGen({ values: ["desk lamp", "kettle"] }),
    customer: new CategorySamplerGen({ values: ["Ada", "Linus"] }),
    review: new LLMStructuredGen({
      model: "writer",
      schema: Review,
      prompt: prompt`Write a review of a ${o.product} bought by ${o.customer}.`,
      maxAttempts: 3,
    }),
  },
});

const { records } = await preview({
  gen: order,
  numRecords: 10,
  seed: 1,
  providers: { openrouter: Provider.openRouter() }, // key from OPENROUTER_API_KEY
  models: { writer: { provider: "openrouter", model: "qwen/qwen3.8-flash", temperature: 1 } },
});
records[0].review.mood; // typed: "happy" | "neutral" | "mad"
```

The model is told the shape and the rules, generated from the schema, so they cannot drift from
what is validated. When a reply breaks them, the retry shows the model its reply and the problems:

```text
Review a kettle.

Reply with only a JSON object of this shape (plain JSON, no comments, no other text):
{
  "rating": integer,
  "mood": "happy" | "neutral" | "mad"
}

Fields:
- rating: an integer from 1 to 5
- mood: one of "happy", "neutral", "mad"

Your previous reply was:
{"rating": 7, "mood": "ecstatic"}

It had these problems:
- rating: expected an integer from 1 to 5, got 7
- mood: expected one of "happy", "neutral", "mad", got "ecstatic"

Reply again with the corrected JSON only.
```

Also:
- Numbers with `decimalPlaces` are rounded rather than rejected.
- `apiGuidedDecoding: true` asks the API to enforce the JSON Schema; replies are still validated.
- `onFailure: "default"` uses a fallback value instead of failing the run.
- `reasoningOf(o.review)` puts a reasoning model's thinking in a field of its own.

Providers: OpenAI-format endpoints (OpenAI, OpenRouter, NVIDIA, Ollama, vLLM) and Anthropic, with
retries and a concurrency limit. `MockProvider` answers without a network, for tests and demos.

## Constrained and custom fields

```ts
const e = rootRefs(Employee);

const employee = new TreeGen({
  schema: Employee,
  fields: {
    age: new NumberSamplerGen({ type: "uniform", low: 18, high: 70, integer: true }),
    role: new CategorySamplerGen({ values: ["intern", "engineer", "manager"] }),

    // Rejection sampling: redraw until the condition holds. The condition can read other fields.
    salary: ConditionalRejectionResamplerGen.bound({
      childGen: new NumberSamplerGen({ type: "gaussian", mean: 90_000, stddev: 30_000, decimalPlaces: 0 }),
      inputs: { role: e.role },
      accept: (salary, { role }) => salary > 20_000 && (role !== "intern" || salary < 50_000),
    }),

    // Any function. Its inputs are typed from the refs; randomness comes from the seeded ctx.rng.
    badge: CustomGen.bound({
      inputs: { role: e.role, age: e.age },
      fn: ({ role, age }, ctx) => `${role.toUpperCase()}-${age}-${ctx.rng.int(1000, 9999)}`,
    }),
  },
});
```

Also: `FunctionGen` for `field2 = f(field1)`, `ConstantGen` for a value shared by every row,
`FakerGen` for names, emails and addresses (faker-js, optional), and `.temp()` fields that other
fields can read but that are dropped from the output (the output type drops them too).

## Prompt building

A prompt is a tagged template. The refs in it are the fields it reads, so there is no separate
list of inputs to keep in sync:

```ts
const replyPrompt = prompt`Write a support reply about ${t.product}. Order details:
${json(t.details)}
`
  .match({
    inputs: { stars: t.stars, age: t.ageRange },
    cases: [
      { when: ({ stars }) => stars <= 2, then: prompt`Apologise; the customer gave ${t.stars} stars.` },
      { when: ({ age }) => age === "18-25", then: "Keep it casual." },
    ],
    otherwise: "Keep it formal.",
  })
  .append(" Reply with only the message.");
```

- `match` picks a section by the row's values. `when` gets typed inputs: comparing `ageRange` to
  `"18-24"`, which is not one of its values, is a compile error.
- A ref to an object has no obvious text form, so `${t.details}` is a compile error; `json(t.details)`
  writes it as indented JSON.
- Jinja-style `{{ name }}` is reported as an error instead of reaching the model as literal text.

Whole fields can be conditional too. With `MatchGen`, a row that matches no case gets no value, and
the LLM is only called for the rows that need it:

```ts
complaint: new MatchGen({
  inputs: { stars: t.stars },
  cases: [{
    when: ({ stars }) => stars <= 2,
    then: new LLMTextGen({ model: "writer", prompt: prompt`Why only ${t.stars} stars for ${t.product}?` }),
  }],
}), // complaint must be optional in the schema: s.string().optional()
```

## Examples

Two of NVIDIA Data Designer's tutorials, ported field for field:

- [`examples/product-reviews.ts`](examples/product-reviews.ts): "The Basics": samplers, a Faker
  customer as a nested tree, LLM text fields.
- [`examples/structured-reviews.ts`](examples/structured-reviews.ts): "Structured Outputs, Jinja
  Expressions, and Conditional Generation": typed LLM replies, derived fields, dropped fields,
  conditional prompts and skipped fields.

Each runs on OpenRouter and writes JSONL to `scratch/`. Put your key in the `OPENROUTER_API_KEY`
environment variable (or a file of that name in the repo root, which is gitignored), then:

```sh
npx tsx examples/product-reviews.ts 10
npx tsx examples/structured-reviews.ts 10
```

[`tests/examples.test.ts`](tests/examples.test.ts) is a tour of the API, including a block of
mistakes that must not compile; `npm test` fails if any of them starts compiling.

## Running it

Not on npm. Clone it and install:

```sh
git clone https://github.com/dattasid/TS-SynthDesigner.git
cd TS-SynthDesigner
npm install
npm test        # tsc, then vitest
```

`preview()` returns records in memory; `create()` writes them to a JSONL file batch by batch.

## Status

Working: everything above. Next: per-value seeding (so single rows can be regenerated), and lists of
generated objects (`s.array(Item)` with a generator per element), which Data Designer does not have.

## License

[Apache 2.0](LICENSE)
