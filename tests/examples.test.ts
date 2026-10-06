// API-shape examples. Kept small on purpose; the detailed tests are in the other files.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, expectTypeOf, it } from "vitest";
import { productReviewGen } from "../examples/product-reviews";
import { bugReportGen } from "../examples/bug-report-triage";
import { structuredReviewGen } from "../examples/structured-reviews";
import { FakerGen } from "../src/faker";
import {
  CategorySamplerGen,
  Context,
  create,
  ConstantGen,
  CustomGen,
  FunctionGen,
  LLMStructuredGen,
  LLMTextGen,
  MatchGen,
  MockProvider,
  NumberSamplerGen,
  preview,
  previewSync,
  prompt,
  reasoningOf,
  refs,
  rootRefs,
  s,
  showRef,
  SubCategorySamplerGen,
  TreeGen,
  type Infer,
} from "../src/index";

// The data model is a schema: one definition gives the type (Infer), the runtime check of every
// record, and the refs. Plain strings: values can come from a hand-written list today and a data
// file tomorrow.
const Person = s.object({
  name: s.string(),
  country: s.string(),
  city: s.string(),
  birthCountry: s.string(),
  birthCity: s.string(),
  age: s.integer({ min: 0 }),
  heightCm: s.number({ decimalPlaces: 1 }),
});
type Person = Infer<typeof Person>; // { name: string; country: string; ... }

const Pet = s.object({ name: s.string(), species: s.string() });

it("a typed Person tree", async () => {
  const refOfPerson = refs(Person);

  const countryGen = new CategorySamplerGen({ values: { Canada: 2, France: 1, Japan: 1 } });
  // A Gen with an input: its `category` is fed by whichever field it is bound to.
  const cityGen = new SubCategorySamplerGen({
    values: {
      Canada: ["Toronto", "Vancouver"],
      France: { Paris: 3, Lyon: 1 },
      Japan: ["Tokyo", "Osaka"],
    },
  });

  const person = new TreeGen({
    schema: Person,
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
  // For loops, conditionals, or fields added later. Each field() is type-checked; build() checks
  // that every schema key has a Gen.
  const b = TreeGen.builder({ schema: Pet, id: "Pet" });
  b.field({ name: "name", gen: new CategorySamplerGen({ values: ["Rex", "Tom"] }) });
  b.field({ name: "species", gen: new CategorySamplerGen({ values: ["dog", "cat"] }) });
  const pet = b.build();
  console.table((await preview({ gen: pet, numRecords: 3, seed: 1 })).records);
});

const Education = s.object({ university: s.string(), univCity: s.string() });
const Student = s.object({ country: s.string(), education: Education });

it("reading a value from the top of the record", async () => {
  // student.education.univCity reads student.country. The plan generates country first.
  const root = rootRefs(Student);
  const cityGen = new SubCategorySamplerGen({ values: { Canada: ["Toronto", "Montreal"], Japan: ["Kyoto"] } });

  const student = new TreeGen({
    schema: Student,
    fields: {
      country: new CategorySamplerGen({ values: ["Canada", "Japan"] }),
      education: new TreeGen({
        schema: Education, // the very schema at Student.education
        fields: {
          university: new CategorySamplerGen({ values: ["State University", "Tech Institute"] }),
          univCity: cityGen.bind({ category: root.country }),
        },
      }),
    },
  });
  console.log((await preview({ gen: student, numRecords: 3, seed: 3 })).records);
});

const WorkerEducation = s.object({ city: s.string() });
const Worker = s.object({
  age: s.integer(),
  country: s.string(),
  education: WorkerEducation,
  occupation: s.string(),
  seniority: s.string(),
});

it("temp fields: made, read by other fields, dropped from the records", () => {
  // DataDesigner's drop=True. The record type is Output<typeof Letter>: without the temp fields.
  const Letter = s.object({
    firstName: s.string().temp(),
    lastName: s.string().temp(),
    greeting: s.string(),
  });
  const l = rootRefs(Letter);
  const letter = new TreeGen({
    schema: Letter,
    fields: {
      firstName: new CategorySamplerGen({ values: ["Ada", "Linus"] }),
      lastName: new CategorySamplerGen({ values: ["Byron", "Torvalds"] }),
      greeting: FunctionGen.bound({ inputs: { f: l.firstName, n: l.lastName }, fn: ({ f, n }) => `Dear ${f} ${n},` }),
    },
  });
  const { records } = previewSync({ gen: letter, numRecords: 2, seed: 1 });
  expectTypeOf(records[0]!).toEqualTypeOf<{ greeting: string }>();
  console.table(records); // only greeting
  // Every record is also checked against the schema at runtime: what the types cannot see (bounds,
  // casts, plain JavaScript) is a GenerationError naming the record and field.
});

it("derived and constant fields: FunctionGen, ConstantGen", () => {
  const Scene = s.object({ setting: s.string(), mood: s.string() });
  const Character = s.object({ scene: Scene, firstName: s.string(), lastName: s.string(), fullName: s.string() });
  const c = rootRefs(Character);
  // Made elsewhere: by another run with numRecords: 1, read from a file, or typed in.
  const scene: Infer<typeof Scene> = { setting: "a lighthouse in a storm", mood: "tense" };
  const character = new TreeGen({
    schema: Character,
    fields: {
      scene: new ConstantGen({ value: scene }), // every row; refs read into it: c.scene.setting
      firstName: new CategorySamplerGen({ values: ["Ada", "Linus"] }),
      lastName: new CategorySamplerGen({ values: ["Byron", "Torvalds"] }),
      // field2 = f(field1): FunctionGen is CustomGen under the name you would look for.
      fullName: FunctionGen.bound({ inputs: { f: c.firstName, l: c.lastName }, fn: ({ f, l }) => `${f} ${l}` }),
    },
  });
  console.table(previewSync({ gen: character, numRecords: 3, seed: 1 }).records);
});

it("custom Gens: plain functions, few types", async () => {
  const p = rootRefs(Worker);

  // Reusable: type the parameter once; the output type is inferred from the returns (TypeScript
  // keeps the returned literals, which still fit the string field).
  const occupationGen = new CustomGen({
    fn: ({ age, country }: { age: number; country: string }) =>
      age < 22 ? "Student" : country === "Canada" && age > 60 ? "Retired" : "Engineer",
  });
  expectTypeOf(occupationGen).toEqualTypeOf<CustomGen<"Student" | "Retired" | "Engineer", { age: number; country: string }>>();

  const worker = new TreeGen({
    schema: Worker,
    fields: {
      age: new NumberSamplerGen({ type: "uniform", low: 18, high: 70, integer: true }),
      country: new CategorySamplerGen({ values: ["Canada", "Japan"] }),
      education: new TreeGen({
        schema: WorkerEducation,
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

const Customer = s.object({ sex: s.enum(["male", "female"]), firstName: s.string(), lastName: s.string(), email: s.string() });
type Customer = Infer<typeof Customer>;

it("names, emails, addresses: faker-js", async () => {
  // FakerGen has its own entry point ("ts-synthdesigner/faker"), so faker loads only when used.
  // faker draws from the field's stream: the same seed gives the same people.
  const c = refs(Customer);
  const customer = new TreeGen({
    schema: Customer,
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
  // The whole tutorial, ported field for field. run examples/product-reviews.ts directly for a real model.
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

it("DataDesigner's tutorial 2: structured replies, expressions, skipped fields (examples/structured-reviews.ts)", async () => {
  // A mock that answers like a model: JSON for the structured fields, alternating low and high ratings.
  let reviews = 0;
  const mock = new MockProvider({
    respond: ({ prompt }) =>
      prompt.startsWith("Create a product")
        ? `{"name": "Desk Lamp", "description": "A lamp.", "price": 24.999}`
        : prompt.startsWith("Your task is to write a review")
          ? JSON.stringify({ rating: reviews++ % 2 === 0 ? 1 : 5, customerMood: "neutral", review: "It is a lamp." })
          : `echo: ${prompt}`,
  });
  const { records } = await preview({
    gen: structuredReviewGen,
    numRecords: 8,
    seed: 1,
    providers: { mock },
    models: { writer: { provider: "mock", model: "echo" } },
  });
  for (const x of records) {
    expect("customer" in x).toBe(false); // a .temp() field: read by customerName, then dropped
    expect(x.product.price).toBe(25); // rounded to 2 decimals
    if (x.targetAgeRange === "18-25") expect(x.reviewStyle).toBe("rambling");
    if (x.customerReview.rating <= 2) {
      expect(x.complaintAnalysis).toContain("Rating: 1/5");
      expect(x.actionItems).toContain(x.complaintAnalysis);
      expect(x.reviewSummary).toContain(`Complaint analysis: ${x.complaintAnalysis}`);
    } else {
      expect(x.complaintAnalysis).toBeUndefined();
      expect(x.actionItems).toBeUndefined();
      expect(x.reviewSummary).not.toContain("Complaint analysis");
    }
  }
  const reviewPrompts = mock.requests.filter((q) => q.prompt.startsWith("Your task is to write a review"));
  expect(reviewPrompts.some((q) => q.prompt.includes("more formal and structured"))).toBe(true);
  // 8 products, 8 reviews, 8 summaries, and 2 more calls per low rating.
  expect(mock.requests).toHaveLength(24 + 2 * records.filter((x) => x.customerReview.rating <= 2).length);
  console.log(records[0]);
});

it("bug-report triage: a typed LLM reply feeding another, an incident note for the worst (examples/bug-report-triage.ts)", async () => {
  let triages = 0;
  const mock = new MockProvider({
    respond: ({ prompt }) =>
      prompt.startsWith("You are ")
        ? JSON.stringify({ title: "Cart empties", stepsToReproduce: ["Add an item", "Pay"], expected: "Paid", actual: "Cart is empty" })
        : prompt.startsWith("You triage bugs")
          ? JSON.stringify({ component: "payments", priority: triages++ % 3 === 0 ? "P0" : "P2", duplicateLikely: false, rationale: "Blocks checkout." })
          : `echo: ${prompt}`,
  });
  const { records } = await preview({
    gen: bugReportGen,
    numRecords: 12,
    seed: 1,
    providers: { mock },
    models: { writer: { provider: "mock", model: "echo" } },
  });
  for (const b of records) {
    expect("reporter" in b).toBe(false); // .temp(): shapes the prompt, then dropped
    const { platform, os, browser } = b.environment;
    if (platform !== "web") expect(browser).toBe("native app");
    else expect(browser === "native app" || (browser === "Safari" && os !== "macOS")).toBe(false);
    expect(b.environment.appVersion).toMatch(/^4\.\d+\.\d$/);
    const worst = b.severity === "critical" || b.triage.priority === "P0";
    expect(b.incidentNote !== undefined).toBe(worst);
    expect(b.ticketText.includes('"Incident" section')).toBe(worst);
  }
  const reportPrompts = mock.requests.filter((q) => q.prompt.startsWith("You are "));
  expect(reportPrompts.some((q) => q.prompt.includes("numbered steps"))).toBe(true);
  expect(reportPrompts.some((q) => q.prompt.includes("not technical"))).toBe(true);
});

it("conditional fields: MatchGen (DataDesigner's conditional params and skipped columns)", async () => {
  const Review = s.object({
    ageRange: s.string(),
    stars: s.integer({ min: 1, max: 5 }),
    style: s.string(),
    complaint: s.string().optional(), // optional: skipped for happy customers
  });
  const r = rootRefs(Review);
  const review = new TreeGen({
    schema: Review,
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
  // `name` labels the schema in messages: refs show as review.product, not root.product.
  const Review = s.object({ ageRange: s.string(), stars: s.integer(), product: s.string() }, { name: "review" });
  const r = rootRefs(Review);
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
  const row: Record<string, unknown> = { "review.product": "Mug", "review.ageRange": "18-25", "review.stars": 4 };
  expect(review.render((_key, ref) => row[showRef(ref)])).toBe(
    "Write a review of Mug. Be informal and conversational. Reply with only the review.",
  );
});

it("an LLM field", async () => {
  const Profile = s.object({ name: s.string(), occupation: s.string(), bio: s.string() });
  const p = rootRefs(Profile);
  const profile = new TreeGen({
    schema: Profile,
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
  const Profile = s.object({ name: s.string(), backStory }); // the reply schema is a field of the data model
  const p = rootRefs(Profile);
  const profile = new TreeGen({
    schema: Profile,
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
  const Answer = s.object({
    question: s.string(),
    answer: s.string(),
    answerReasoning: s.string().optional(), // optional: only reasoning models on some providers send it
  });
  const a = rootRefs(Answer);
  const qa = new TreeGen({
    schema: Answer,
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
  const pet = new TreeGen({
    schema: Pet,
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
  const ref = refs(Person);

  // @ts-expect-error 'nmae' is not a field of Person.
  ref.nmae;

  const name = new CategorySamplerGen({ values: ["John Smith"] });
  const country = new CategorySamplerGen({ values: ["Canada"] });
  const city = new CategorySamplerGen({ values: ["Toronto"] });
  const birthCountry = country;
  const birthCity = city;
  const age = new NumberSamplerGen({ type: "uniform", low: 18, high: 90, integer: true });
  const heightCm = new NumberSamplerGen({ type: "gaussian", mean: 170, stddev: 10 });

  new TreeGen({
    schema: Person,
    // @ts-expect-error heightCm has no Gen.
    fields: { name, country, city, birthCountry, birthCity, age },
  });

  new TreeGen({
    schema: Person,
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
  TreeGen.builder({ schema: Pet }).field({ name: "species", gen: heightCm });

  // @ts-expect-error root refs are typed too: Student has no 'countryy'. Refs are plain property access, any depth.
  rootRefs(Student).countryy;
  rootRefs(Student).education.univCity; // fine

  const w = rootRefs(Worker);
  CustomGen.bound({
    inputs: { age: w.age },
    // @ts-expect-error age is a number (from the ref), so it has no toUpperCase.
    fn: ({ age }) => age.toUpperCase(),
  });

  new TreeGen({
    schema: Worker.pick("age", "seniority"),
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
  colorBySize.bind({ category: refs(s.object({ size: s.enum(["S", "M", "L"]) })).size }); // fine
  // @ts-expect-error Ref<string> is not a Ref<Size>.
  colorBySize.bind({ category: refs(s.object({ size: s.string() })).size });
}
