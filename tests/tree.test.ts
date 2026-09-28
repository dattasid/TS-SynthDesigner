import { describe, expect, it } from "vitest";
import {
  CategorySamplerGen,
  ConfigError,
  GaussianSamplerGen,
  preview,
  refs,
  SubCategorySamplerGen,
  TreeGen,
  UniformSamplerGen,
} from "../src/index";

type Country = "United States" | "Canada" | "India" | "France" | "Japan";

interface Person {
  name: string;
  country: Country;
  city: string;
  age: number;
  heightCm: number;
}

// Record<Country, ...>: leaving out a country, or misspelling one, is a compile error.
const cityMap: Record<Country, Record<string, number>> = {
  "United States": { "New York": 1, Chicago: 1 },
  Canada: { Toronto: 1, Vancouver: 1 },
  India: { Mumbai: 1, Bengaluru: 1 },
  France: { Paris: 1, Lyon: 1 },
  Japan: { Tokyo: 1, Osaka: 1 },
};

const ref = refs<Person>();

const personFields = {
  name: new CategorySamplerGen({ id: "gen_names", values: { "John Smith": 1, "Jane Doe": 1 } }),
  country: new CategorySamplerGen<Country>({
    id: "gen_country",
    values: { "United States": 1, Canada: 1, India: 1, France: 1, Japan: 1 },
  }),
  city: new SubCategorySamplerGen({ id: "gen_city", parent: ref("country"), values: cityMap }),
  age: new UniformSamplerGen({ low: 0, high: 100, type: "int" }),
  heightCm: new GaussianSamplerGen({ mean: 170, stddev: 10, decimalPlaces: 1 }),
};

describe("TreeGen", () => {
  it("generates typed Person records, reproducibly from a seed", () => {
    const person = new TreeGen<Person>({ id: "Person", fields: personFields });

    const first = preview({ gen: person, numRecords: 5, seed: 2026 });
    const again = preview({ gen: person, numRecords: 5, seed: first.seed });
    expect(again.records).toEqual(first.records);

    const other = preview({ gen: person, numRecords: 5, seed: 2027 });
    expect(other.records).not.toEqual(first.records);

    // Adding a field does not change the other fields' values.
    interface PersonWithEmail extends Person {
      email: string;
    }
    const withEmail = new TreeGen<PersonWithEmail>({
      fields: {
        email: new CategorySamplerGen({ values: ["a@example.com", "b@example.com"] }),
        ...personFields,
      },
    });
    const without = new TreeGen<Person>({ fields: personFields });

    // Each field draws from its own stream, forked from the seed and the field name.
    const a = preview({ gen: without, numRecords: 20, seed: 9 }).records;
    const b = preview({ gen: withEmail, numRecords: 20, seed: 9 }).records;
    expect(b.map(({ email: _email, ...rest }) => rest)).toEqual(a);
  });

  it("reports bad dependencies when the tree is built, and bad types when it is compiled", () => {
    interface Loop {
      a: string;
      b: string;
    }
    const loop = refs<Loop>();
    expect(
      () =>
        new TreeGen<Loop>({
          id: "Loop",
          fields: {
            a: new SubCategorySamplerGen({ parent: loop("b"), values: { x: ["x"] } }),
            b: new SubCategorySamplerGen({ parent: loop("a"), values: { x: ["x"] } }),
          },
        }),
    ).toThrow(new ConfigError("TreeGen 'Loop': dependency cycle among fields: a, b."));

    // A ref made for a different type fails at runtime when its field is not in this tree.
    expect(
      () =>
        new TreeGen<{ city: string }>({
          fields: { city: new SubCategorySamplerGen({ parent: ref("country"), values: cityMap }) },
        }),
    ).toThrow(/depends on 'country' \(via 'parent'\), which is not a field of this tree/);
  });
});
