// API-shape examples. Kept small on purpose; the detailed tests are in the other files.
import { expect, it } from "vitest";
import {
  CategorySamplerGen,
  Context,
  GaussianSamplerGen,
  preview,
  refs,
  SubCategorySamplerGen,
  TreeGen,
  UniformSamplerGen,
} from "../src/index";

type Country = "Canada" | "France" | "Japan";// @AI remove this type. People might want to switch rapidly from hand written lists to data source of country names, city names etc. We dont want to hold them back with too much typing. But if we are checking something using this and other examples will be contrived, keep and add a note.

interface Person {
  name: string;
  country: Country;
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
      country: new CategorySamplerGen<Country>({ values: { Canada: 2, France: 1, Japan: 1 } }),
      city: new SubCategorySamplerGen({
        parent: refOfPerson("country"),
        values: {
          Canada: ["Toronto", "Vancouver"],
          France: { Paris: 3, Lyon: 1 },
          Japan: ["Tokyo", "Osaka"],
        },
      }),
      age: new UniformSamplerGen({ low: 18, high: 90, type: "int" }),
      heightCm: new GaussianSamplerGen({ mean: 170, stddev: 10, decimalPlaces: 1 }),
    },
  });

  const { records, seed } = preview({ gen: person, numRecords: 5, seed: 2026 });
  console.table(records);
  expect(preview({ gen: person, numRecords: 5, seed }).records).toEqual(records); // same seed, same data
});

it("a Gen on its own", () => {
  const ctx = Context.create({ seed: 1 });
  const dice = new UniformSamplerGen({ low: 1, high: 6, type: "int" }); // @AI I was thinking the numerical ones are very similar, to roll them into one with type: "uniform" | "poisson" etc
  console.log([1, 2, 3, 4, 5].map(() => dice.generate({}, ctx)));
});

// Mistakes the compiler catches. `npm test` runs tsc first, and each @ts-expect-error
// fails the build if its error goes away. Never called.
export function compileErrors(): void {
  const ref = refs<Person>();

  // @ts-expect-error 'nmae' is not a field of Person.
  ref("nmae");

  const name = new CategorySamplerGen({ values: ["John Smith"] });
  const country = new CategorySamplerGen<Country>({ values: ["Canada"] });
  const city = new CategorySamplerGen({ values: ["Toronto"] });
  const age = new UniformSamplerGen({ low: 18, high: 90, type: "int" });

  new TreeGen<Person>({
    // @ts-expect-error heightCm has no Gen.
    fields: { name, country, city, age },
  });

  new TreeGen<Person>({
    fields: {
      name, // @AI lets also try Number type gen for name, should be error
      country,
      city,
      // @ts-expect-error age is a number, but a category Gen produces strings.
      age: new CategorySamplerGen({ values: ["young", "old"] }),
      heightCm: new GaussianSamplerGen({ mean: 170, stddev: 10 }),
    },
  });

  new SubCategorySamplerGen({
    parent: ref("country"),
    // @ts-expect-error Japan is missing.
    values: { Canada: ["Toronto"], France: ["Paris"] },
  });
  // @AI So this test is just for showing me, its no op due to the @ts-expect-error ?
}
