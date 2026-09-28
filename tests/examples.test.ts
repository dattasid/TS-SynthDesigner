// API-shape examples. Kept small on purpose; the detailed tests are in the other files.
import { expect, it } from "vitest";
import {
  CategorySamplerGen,
  Context,
  NumberSamplerGen,
  preview,
  refs,
  SubCategorySamplerGen,
  TreeGen,
} from "../src/index";

// Plain strings: the values can come from a hand-written list today and a data file tomorrow.
interface Person {
  name: string;
  country: string;
  city: string;
  age: number;
  heightCm: number;
}

it("a typed Person tree", () => {
  const refOfPerson = refs<Person>();

  const person = new TreeGen<Person>({
    id: "Person",
    fields: {
      name: new CategorySamplerGen({ values: ["John Smith", "Jane Doe"] }),
      country: new CategorySamplerGen({ values: { Canada: 2, France: 1, Japan: 1 } }),
      city: new SubCategorySamplerGen({
        parent: refOfPerson("country"),
        values: {
          Canada: ["Toronto", "Vancouver"],
          France: { Paris: 3, Lyon: 1 },
          Japan: ["Tokyo", "Osaka"],
        },
      }),
      age: new NumberSamplerGen({ type: "uniform", low: 18, high: 90, integer: true }),
      heightCm: new NumberSamplerGen({ type: "gaussian", mean: 170, stddev: 10, decimalPlaces: 1 }),
    },
  });

  const { records, seed } = preview({ gen: person, numRecords: 5, seed: 2026 });
  console.table(records);
  expect(preview({ gen: person, numRecords: 5, seed }).records).toEqual(records); // same seed, same data
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
  ref("nmae");

  const name = new CategorySamplerGen({ values: ["John Smith"] });
  const country = new CategorySamplerGen({ values: ["Canada"] });
  const city = new CategorySamplerGen({ values: ["Toronto"] });
  const age = new NumberSamplerGen({ type: "uniform", low: 18, high: 90, integer: true });
  const heightCm = new NumberSamplerGen({ type: "gaussian", mean: 170, stddev: 10 });

  new TreeGen<Person>({
    // @ts-expect-error heightCm has no Gen.
    fields: { name, country, city, age },
  });

  new TreeGen<Person>({
    fields: {
      // @ts-expect-error name is a string, but a number Gen produces numbers.
      name: new NumberSamplerGen({ type: "uniform", low: 0, high: 1 }),
      country,
      city,
      // @ts-expect-error age is a number, but a category Gen produces strings.
      age: new CategorySamplerGen({ values: ["young", "old"] }),
      heightCm,
    },
  });

  // @ts-expect-error each number type has its own params: gaussian needs stddev, not high.
  new NumberSamplerGen({ type: "gaussian", mean: 170, high: 200 });

  // Opt-in: when a field is a union of literals instead of `string`, subcategory maps are checked
  // for completeness. Contrived here; with plain `string` (as in Person) a missing parent value is
  // reported at generation time instead.
  interface Shirt {
    size: "S" | "M" | "L";
    color: string;
  }
  new SubCategorySamplerGen({
    parent: refs<Shirt>()("size"),
    // @ts-expect-error "L" is missing.
    values: { S: ["red"], M: ["red", "blue"] },
  });
}
