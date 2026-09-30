// API-shape examples. Kept small on purpose; the detailed tests are in the other files.
import { expect, it } from "vitest";
import {
  CategorySamplerGen,
  Context,
  NumberSamplerGen,
  preview,
  refs,
  rootRefs,
  SubCategorySamplerGen,
  TreeGen,
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

it("a typed Person tree", () => {
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

  const { records, seed } = preview({ gen: person, numRecords: 5, seed: 2026 });
  console.table(records);
  expect(preview({ gen: person, numRecords: 5, seed }).records).toEqual(records); // same seed, same data

  // A copy with some Gens replaced. It starts complete, so it stays complete.
  const kids = person.clone({
    id: "Kid",
    fields: { age: new NumberSamplerGen({ type: "uniform", low: 0, high: 12, integer: true }) },
  });
  console.table(preview({ gen: kids, numRecords: 3, seed: 2026 }).records);
});

it("the same tree, step by step", () => {
  // For loops, conditionals, or fields added later. Each field() is type-checked; completeness is
  // checked at build() only for requiredKeys (types are erased, so the builder can't know them otherwise).
  const b = TreeGen.builder<Pet>({ id: "Pet", requiredKeys: ["name", "species"] });
  b.field({ name: "name", gen: new CategorySamplerGen({ values: ["Rex", "Tom"] }) });
  b.field({ name: "species", gen: new CategorySamplerGen({ values: ["dog", "cat"] }) });
  const pet = b.build();
  console.table(preview({ gen: pet, numRecords: 3, seed: 1 }).records);
});

interface Student {
  country: string;
  education: { university: string; univCity: string };
}

it("reading a value from the top of the record", () => {
  // student.education.univCity reads student.country. The plan generates country first.
  const root = rootRefs<Student>();
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
  console.log(preview({ gen: student, numRecords: 3, seed: 3 }).records);
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
  rootRefs<Student>().countryy;
  rootRefs<Student>().education.univCity; // fine

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
