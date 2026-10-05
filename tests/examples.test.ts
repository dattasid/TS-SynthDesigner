// API-shape examples. Kept small on purpose; the detailed tests are in the other files.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, expectTypeOf, it } from "vitest";
import { productReviewGen } from "../examples/product-reviews";
import { FakerGen } from "../src/faker";
import {
  CategorySamplerGen,
  Context,
  create,
  CustomGen,
  LLMStructuredGen,
  LLMTextGen,
  MatchGen,
  MockProvider,
  NumberSamplerGen,
  preview,
  prompt,
  reasoningOf,
  refs,
  rootRefs,
  s,
  SubCategorySamplerGen,
  TreeGen,
  type Infer,
} from "../src/index";

// Plain strings: the values can come from a hand-written list today and a data file tomorrow.
interface Person {
  name: string;
  country: string;
  city: string;
  birthCountry: string;
  birthCity: string;
  age: number;
  heightCm: number;
}

interface Pet {
  name: string;
  species: string;
}

it("a typed Person tree", async () => {
  const refOfPerson = refs<Person>();

  const countryGen = new CategorySamplerGen({ values: { Canada: 2, France: 1, Japan: 1 } });
  // A Gen with an input: its `category` is fed by whichever field it is bound to.
  const cityGen = new SubCategorySamplerGen({
    values: {
      Canada: ["Toronto", "Vancouver"],
      France: { Paris: 3, Lyon: 1 },
      Japan: ["Tokyo", "Osaka"],
    },
  });

  const person = new TreeGen<Person>({
    id: "Person",
    fields: {
      name: new CategorySamplerGen({ values: ["John Smith", "Jane Doe"] }),
      country: countryGen,
      city: cityGen.bind({ category: refOfPerson.country }),
      birthCountry: countryGen,
      birthCity: cityGen.bind({ category: refOfPerson.birthCountry }), // same Gen, different input
      age: new NumberSamplerGen({ type: "uniform", low: 18, high: 90, integer: true }),
      heightCm: new NumberSamplerGen({ type: "gaussian", mean: 170, stddev: 10, decimalPlaces: 1 }),
    },
  });

  const { records, seed } = await preview({ gen: person, numRecords: 5, seed: 2026 });
  console.table(records);
  expect((await preview({ gen: person, numRecords: 5, seed })).records).toEqual(records); // same seed, same data

  // A copy with some Gens replaced. It starts complete, so it stays complete.
  const kids = person.clone({
    id: "Kid",
    fields: { age: new NumberSamplerGen({ type: "uniform", low: 0, high: 12, integer: true }) },
  });
  console.table((await preview({ gen: kids, numRecords: 3, seed: 2026 })).records);
});

it("the same tree, step by step", async () => {
  // For loops, conditionals, or fields added later. Each field() is type-checked; completeness is
  // checked at build() only for requiredKeys (types are erased, so the builder can't know them otherwise).
  const b = TreeGen.builder<Pet>({ id: "Pet", requiredKeys: ["name", "species"] });
  b.field({ name: "name", gen: new CategorySamplerGen({ values: ["Rex", "Tom"] }) });
  b.field({ name: "species", gen: new CategorySamplerGen({ values: ["dog", "cat"] }) });
  const pet = b.build();
  console.table((await preview({ gen: pet, numRecords: 3, seed: 1 })).records);
});

interface Student {
  country: string;
  education: { university: string; univCity: string };
}

it("reading a value from the top of the record", async () => {
  // student.education.univCity reads student.country. The plan generates country first.
  const root = rootRefs<Student>("student");
  const cityGen = new SubCategorySamplerGen({ values: { Canada: ["Toronto", "Montreal"], Japan: ["Kyoto"] } });

  const student = new TreeGen<Student>({
    fields: {
      country: new CategorySamplerGen({ values: ["Canada", "Japan"] }),
      education: new TreeGen<Student["education"]>({
        fields: {
          university: new CategorySamplerGen({ values: ["State University", "Tech Institute"] }),
          univCity: cityGen.bind({ category: root.country }),
        },
      }),
    },
  });
  console.log((await preview({ gen: student, numRecords: 3, seed: 3 })).records);
});

interface Worker {
  age: number;
  country: string;
  education: { city: string };
  occupation: string;
  seniority: string;
}

it("custom Gens: plain functions, few types", async () => {
  const p = rootRefs<Worker>("worker");

  // Reusable: type the parameter once; the output type is inferred from the returns (TypeScript
  // keeps the returned literals, which still fit the string field).
  const occupationGen = new CustomGen({
    fn: ({ age, country }: { age: number; country: string }) =>
      age < 22 ? "Student" : country === "Canada" && age > 60 ? "Retired" : "Engineer",
  });
  expectTypeOf(occupationGen).toEqualTypeOf<CustomGen<"Student" | "Retired" | "Engineer", { age: number; country: string }>>();

  const worker = new TreeGen<Worker>({
    fields: {
      age: new NumberSamplerGen({ type: "uniform", low: 18, high: 70, integer: true }),
      country: new CategorySamplerGen({ values: ["Canada", "Japan"] }),
      education: new TreeGen<Worker["education"]>({
        fields: { city: new CategorySamplerGen({ values: ["Toronto", "Kyoto"] }) },
      }),
      occupation: occupationGen.bind({ age: p.age, country: p.country }),

      // One-off: refs first, then the function. No annotations: age is a number and city a string,
      // taken from the refs. Reads a value nested inside education.
      seniority: CustomGen.bound({
        inputs: { age: p.age, city: p.education.city },
        fn: ({ age, city }, ctx) => {
          const base = age < 30 ? "junior" : "senior";
          return city === "Kyoto" && ctx.rng.random() < 0.5 ? `${base} (remote)` : base;
        },
      }),
    },
  });

  const { records } = await preview({ gen: worker, numRecords: 5, seed: 3 });
  console.table(records.map(({ education, ...w }) => ({ ...w, city: education.city })));
  for (const w of records) expect(w.seniority.startsWith(w.age < 30 ? "junior" : "senior")).toBe(true);
});

interface Customer {
  sex: "male" | "female";
  firstName: string;
  lastName: string;
  email: string;
}

it("names, emails, addresses: faker-js", async () => {
  // FakerGen has its own entry point ("ts-datadesigner/faker"), so faker loads only when used.
  // faker draws from the field's stream: the same seed gives the same people.
  const c = refs<Customer>();
  const customer = new TreeGen<Customer>({
    fields: {
      sex: new CategorySamplerGen<Customer["sex"]>({ values: ["male", "female"] }),
      firstName: FakerGen.bound({ inputs: { sex: c.sex }, fn: (f, { sex }) => f.person.firstName(sex) }),
      lastName: new FakerGen({ fn: (f) => f.person.lastName() }),
      email: FakerGen.bound({ inputs: { firstName: c.firstName, lastName: c.lastName }, fn: (f, names) => f.internet.email(names) }),
    },
  });
  console.table((await preview({ gen: customer, numRecords: 3, seed: 5 })).records);
});

it("DataDesigner's tutorial: product reviews (examples/product-reviews.ts)", async () => {
  // The whole tutorial, ported field for field. examples/product-reviews.run.ts runs it on a real model.
  const { records } = await preview({
    gen: productReviewGen,
    numRecords: 2,
    seed: 1,
    providers: { mock: new MockProvider() }, // echoes the prompt
    models: { writer: { provider: "mock", model: "echo" } },
  });
  const [first] = records;
  expect(first!.customerReview).toContain(`named ${first!.customer.firstName} from ${first!.customer.city}`);
  expect(first!.customerReview).toContain(first!.productName); // reads the other LLM field
  console.log(records);
});

it("conditional fields: MatchGen (DataDesigner's conditional params and skipped columns)", async () => {
  interface Review {
    ageRange: string;
    stars: number;
    style: string;
    complaint?: string; // optional: skipped for happy customers
  }
  const r = rootRefs<Review>("review");
  const review = new TreeGen<Review>({
    fields: {
      ageRange: new CategorySamplerGen({ values: ["18-25", "25-50", "50+"] }),
      stars: new NumberSamplerGen({ type: "uniform", low: 1, high: 5, integer: true }),
      // Cases are tried in order; `then` and `otherwise` are a Gen or a plain value.
      style: new MatchGen({
        inputs: { age: r.ageRange },
        cases: [{ when: ({ age }) => age === "18-25", then: "rambling" }],
        otherwise: new CategorySamplerGen({ values: { brief: 2, detailed: 2, rambling: 1 } }),
      }),
      // No otherwise: undefined when no case holds, so the field must be optional. The LLM is only
      // called for the rows that need it.
      complaint: new MatchGen({
        inputs: { stars: r.stars },
        cases: [{ when: ({ stars }) => stars <= 2, then: new LLMTextGen({ model: "fast", prompt: prompt`Why ${r.stars} stars?` }) }],
      }),
    },
  });
  const { records } = await preview({
    gen: review,
    numRecords: 4,
    seed: 1,
    providers: { mock: new MockProvider() },
    models: { fast: { provider: "mock", model: "echo" } },
  });
  console.table(records);
});

it("conditional prompt text: match, in place of Jinja's {% if %}", () => {
  interface Review {
    ageRange: string;
    stars: number;
    product: string;
  }
  const r = rootRefs<Review>("review");
  // Cases are tried in order. The inputs are typed from the refs: `stars` is a number here.
  const review = prompt`Write a review of ${r.product}. `
    .match({
      inputs: { age: r.ageRange, stars: r.stars },
      cases: [
        { when: ({ stars }) => stars <= 2, then: prompt`Say what went wrong with ${r.product}.` },
        { when: ({ age }) => age === "18-25", then: "Be informal and conversational." },
      ],
      otherwise: "Be formal and structured.",
    })
    .append(" Reply with only the review.");
  // A Prompt is text with holes; an LLM Gen fills them per row. Here by hand:
  expect(review.render((key) => ({ "review.product": "Mug", "review.ageRange": "18-25", "review.stars": 4 })[key])).toBe(
    "Write a review of Mug. Be informal and conversational. Reply with only the review.",
  );
});

it("an LLM field", async () => {
  interface Profile {
    name: string;
    occupation: string;
    bio: string;
  }
  const p = rootRefs<Profile>("profile");
  const profile = new TreeGen<Profile>({
    fields: {
      name: new CategorySamplerGen({ values: ["Ada", "Linus"] }),
      occupation: new CategorySamplerGen({ values: ["engineer", "teacher"] }),
      // The refs in the prompt are the fields it reads: no bind(), and a typo is a compile error.
      bio: new LLMTextGen({ model: "fast", prompt: prompt`Write a one-line bio for ${p.name}, a ${p.occupation}.` }),
    },
  });

  // For real: providers: { nvidia: Provider.nvidia() },
  //           models: { fast: { provider: "nvidia", model: "meta/llama-3.1-8b-instruct", temperature: 0.9 } }
  const { records } = await preview({
    gen: profile,
    numRecords: 3,
    seed: 1,
    providers: { mock: new MockProvider() }, // echoes the prompt
    models: { fast: { provider: "mock", model: "echo" } },
  });
  console.table(records);
});

it("an LLM field with a JSON reply", async () => {
  // One definition: the type, the validation, and what the model is told about the reply.
  const backStory = s.object({
    childhood: s.string({ description: "two sentences about where they grew up" }),
    happiness: s.integer({ min: 1, max: 10 }),
    mood: s.enum(["calm", "anxious"]),
  });
  interface Profile {
    name: string;
    backStory: Infer<typeof backStory>;
  }
  const p = rootRefs<Profile>("profile");
  const profile = new TreeGen<Profile>({
    fields: {
      name: new CategorySamplerGen({ values: ["Ada", "Linus"] }),
      // The reply is parsed, checked against the schema (retried with the problems if invalid) and typed.
      backStory: new LLMStructuredGen({ model: "fast", prompt: prompt`Invent a backstory for ${p.name}.`, schema: backStory }),
    },
  });

  const mock = new MockProvider({ respond: () => '{"childhood": "Grew up by the sea.", "happiness": 7, "mood": "calm"}' });
  const { records } = await preview({
    gen: profile,
    numRecords: 2,
    seed: 1,
    providers: { mock },
    models: { fast: { provider: "mock", model: "m" } },
  });
  console.table(records.map(({ name, backStory }) => ({ name, ...backStory })));
  console.log(mock.requests[0]!.prompt); // the prompt with the shape and field notes added
  expectTypeOf(records[0]!.backStory.mood).toEqualTypeOf<"calm" | "anxious">();
});

it("an LLM's reasoning in its own field", async () => {
  interface Answer {
    question: string;
    answer: string;
    answerReasoning?: string; // optional: only reasoning models on some providers send it
  }
  const a = rootRefs<Answer>("answer");
  const qa = new TreeGen<Answer>({
    fields: {
      question: new CategorySamplerGen({ values: ["Why is the sky blue?", "Why is grass green?"] }),
      answer: new LLMTextGen({ model: "thinker", prompt: prompt`Answer in one line: ${a.question}` }),
      answerReasoning: reasoningOf(a.answer), // works for LLMStructuredGen fields too
    },
  });

  // For real: providers: { openRouter: Provider.openRouter() }, models: { thinker: { provider: "openRouter", model: "qwen/qwen3.8-flash" } }
  const mock = new MockProvider({ respond: () => ({ text: "Light scatters.", reasoning: "Rayleigh scattering..." }) });
  const { records } = await preview({ gen: qa, numRecords: 2, seed: 1, providers: { mock }, models: { thinker: { provider: "mock", model: "m" } } });
  console.table(records);
});

it("writing records to a JSONL file", async () => {
  const pet = new TreeGen<Pet>({
    id: "Pet",
    fields: {
      name: new CategorySamplerGen({ values: ["Rex", "Tom"] }),
      species: new CategorySamplerGen({ values: ["dog", "cat"] }),
    },
  });
  // Same params as preview, plus the path. Batches are written as they finish.
  const { path, numRecords, seed } = await create({ gen: pet, numRecords: 1000, seed: 1, path: join(tmpdir(), "pets.jsonl"), overwrite: true });
  console.log(`${numRecords} records in ${path} (seed ${seed})`);
});

it("a Gen on its own", () => {
  const ctx = Context.create({ seed: 1 });
  const dice = new NumberSamplerGen({ type: "uniform", low: 1, high: 6, integer: true });
  console.log([1, 2, 3, 4, 5].map(() => dice.generate({}, ctx)));
});

// Mistakes the compiler catches. This function is never called, so it does nothing at runtime.
// `npm test` runs tsc first: each line below must be a compile error, and if one stops being
// an error, the @ts-expect-error above it is "unused" and tsc fails the build.
export function compileErrors(): void {
  const ref = refs<Person>();

  // @ts-expect-error 'nmae' is not a field of Person.
  ref.nmae;

  const name = new CategorySamplerGen({ values: ["John Smith"] });
  const country = new CategorySamplerGen({ values: ["Canada"] });
  const city = new CategorySamplerGen({ values: ["Toronto"] });
  const birthCountry = country;
  const birthCity = city;
  const age = new NumberSamplerGen({ type: "uniform", low: 18, high: 90, integer: true });
  const heightCm = new NumberSamplerGen({ type: "gaussian", mean: 170, stddev: 10 });

  new TreeGen<Person>({
    // @ts-expect-error heightCm has no Gen.
    fields: { name, country, city, birthCountry, birthCity, age },
  });

  new TreeGen<Person>({
    fields: {
      // @ts-expect-error name is a string, but a number Gen produces numbers.
      name: new NumberSamplerGen({ type: "uniform", low: 0, high: 1 }),
      country,
      city,
      birthCountry,
      // @ts-expect-error a Gen with an unbound input (category) cannot be a field; call bind() first.
      birthCity: new SubCategorySamplerGen({ values: { Canada: ["Toronto"] } }),
      // @ts-expect-error age is a number, but a category Gen produces strings.
      age: new CategorySamplerGen({ values: ["young", "old"] }),
      heightCm,
    },
  });

  // @ts-expect-error builder fields are type-checked too: species is a string.
  TreeGen.builder<Pet>().field({ name: "species", gen: heightCm });

  // @ts-expect-error root refs are typed too: Student has no 'countryy'. Refs are plain property access, any depth.
  rootRefs<Student>("student").countryy;
  rootRefs<Student>("student").education.univCity; // fine

  const w = rootRefs<Worker>("worker");
  CustomGen.bound({
    inputs: { age: w.age },
    // @ts-expect-error age is a number (from the ref), so it has no toUpperCase.
    fn: ({ age }) => age.toUpperCase(),
  });

  new TreeGen<Pick<Worker, "age" | "seniority">>({
    fields: {
      age: new NumberSamplerGen({ type: "uniform", low: 18, high: 70, integer: true }),
      // @ts-expect-error the function returns a number, but seniority is a string.
      seniority: CustomGen.bound({ inputs: { age: w.age }, fn: ({ age }) => age * 2 }),
    },
  });

  const occupationGen = new CustomGen({ fn: ({ age }: { age: number }) => (age < 22 ? "Student" : "Engineer") });
  // @ts-expect-error the input 'age' is not bound.
  occupationGen.bind({});

  // Rank-based weights for a list: first is most common. Only for lists, since a map already has weights.
  new CategorySamplerGen({ values: ["Smith", "Jones", "Taylor", "Brown"], skew: "zipf" });
  // @ts-expect-error skew needs values as a list, not a weight map.
  new CategorySamplerGen({ values: { Smith: 3, Jones: 1 }, skew: "zipf" });
  // @ts-expect-error the same for subcategories: every entry must be a list.
  new SubCategorySamplerGen({ values: { Canada: ["Toronto"], France: { Paris: 3 } }, skew: "zipf" });

  // @ts-expect-error each number type has its own params: gaussian needs stddev, not high.
  new NumberSamplerGen({ type: "gaussian", mean: 170, high: 200 });

  // @ts-expect-error bind() takes a Ref of the input's type: age is a number, category is a string.
  new SubCategorySamplerGen({ values: { Canada: ["Toronto"] } }).bind({ category: ref.age });

  // Opt-in literal types: write the key type, and the map must cover it. Contrived here; with plain
  // `string` keys (the default, as for cities above) a missing category is reported at generation time.
  type Size = "S" | "M" | "L";
  new SubCategorySamplerGen<Size>({
    // @ts-expect-error Property 'L' is missing.
    values: { S: ["red"], M: ["red", "blue"] },
  });

  // A Gen keyed by Size only accepts a Size field: a plain string field could hold anything.
  const colorBySize = new SubCategorySamplerGen<Size>({ values: { S: ["red"], M: ["blue"], L: ["green"] } });
  colorBySize.bind({ category: refs<{ size: Size }>().size }); // fine
  // @ts-expect-error Ref<string> is not a Ref<Size>.
  colorBySize.bind({ category: refs<{ size: string }>().size });
}
