import { describe, expect, it } from "vitest";
import {
  NumberSamplerGen,
  CategorySamplerGen,
  ConfigError,
  previewSync,
  refs,
  SubCategorySamplerGen,
  TreeGen,
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

// One Gen, reusable: which field feeds its `category` input is decided where it is bound.
const cityGen = new SubCategorySamplerGen({ id: "gen_city", values: cityMap });

const personFields = {
  name: new CategorySamplerGen({ id: "gen_names", values: { "John Smith": 1, "Jane Doe": 1 } }),
  country: new CategorySamplerGen<Country>({
    id: "gen_country",
    values: { "United States": 1, Canada: 1, India: 1, France: 1, Japan: 1 },
  }),
  city: cityGen.bind({ category: ref.country }),
  age: new NumberSamplerGen({ type: "uniform", low: 0, high: 100, integer: true }),
  heightCm: new NumberSamplerGen({ type: "gaussian", mean: 170, stddev: 10, decimalPlaces: 1 }),
};

describe("TreeGen", () => {
  it("generates typed Person records, reproducibly from a seed", () => {
    const person = new TreeGen<Person>({ id: "Person", fields: personFields });

    const first = previewSync({ gen: person, numRecords: 5, seed: 2026 });
    const again = previewSync({ gen: person, numRecords: 5, seed: first.seed });
    expect(again.records).toEqual(first.records);

    const other = previewSync({ gen: person, numRecords: 5, seed: 2027 });
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
    const a = previewSync({ gen: without, numRecords: 20, seed: 9 }).records;
    const b = previewSync({ gen: withEmail, numRecords: 20, seed: 9 }).records;
    expect(b.map(({ email: _email, ...rest }) => rest)).toEqual(a);
  });

  it("clone replaces some Gens; optional fields may be left out", () => {
    const adults = new TreeGen<Person>({ id: "Person", fields: personFields });
    const kids = adults.clone({
      id: "Kid",
      fields: { age: new NumberSamplerGen({ type: "uniform", low: 0, high: 12, integer: true }) },
    });
    const records = previewSync({ gen: kids, numRecords: 50, seed: 4 }).records;
    expect(records.every((r) => r.age <= 12)).toBe(true);
    expect(adults.fields.age).toBe(personFields.age); // the original is unchanged

    interface Pet {
      name: string;
      nickname?: string;
    }
    const pet = new TreeGen<Pet>({ fields: { name: new CategorySamplerGen({ values: ["Rex", "Tom"] }) } });
    expect(Object.keys(previewSync({ gen: pet, numRecords: 1, seed: 1 }).records[0]!)).toEqual(["name"]);
  });

  it("builder adds fields step by step; completeness is checked only against requiredKeys", () => {
    const b = TreeGen.builder<Person>({ id: "Person", requiredKeys: ["name", "country", "city", "age", "heightCm"] });
    for (const name of ["name", "country", "age", "heightCm"] as const) b.field({ name, gen: personFields[name] });
    const withCity = true;
    if (withCity) b.field({ name: "city", gen: personFields.city });
    const built = b.build();

    // Same Gens as the fields-object tree, so the same records.
    const direct = new TreeGen<Person>({ id: "Person", fields: personFields });
    expect(previewSync({ gen: built, numRecords: 5, seed: 8 }).records).toEqual(
      previewSync({ gen: direct, numRecords: 5, seed: 8 }).records,
    );

    expect(() => b.field({ name: "age", gen: personFields.age })).toThrow(
      new ConfigError("TreeBuilder 'Person': field 'age' was already added."),
    );
    const partial = TreeGen.builder<Person>({ id: "Person", requiredKeys: ["name", "age"] }).field({
      name: "name",
      gen: personFields.name,
    });
    expect(() => partial.build()).toThrow(new ConfigError("TreeBuilder 'Person': missing fields: age."));
  });

  it("reports bad dependencies when the tree is built, and bad types when it is compiled", () => {
    interface Loop {
      a: string;
      b: string;
    }
    const loop = refs<Loop>();
    const echo = new SubCategorySamplerGen({ values: { x: ["x"] } as Record<string, string[]> });
    expect(
      () =>
        new TreeGen<Loop>({
          id: "Loop",
          fields: {
            a: echo.bind({ category: loop.b }),
            b: echo.bind({ category: loop.a }),
          },
        }),
    ).toThrow(new ConfigError("TreeGen 'Loop': dependency cycle among fields: a, b."));

    // Without types (plain JavaScript, or a cast), declared input names are still checked at runtime.
    const untyped = cityGen as any;
    expect(() => new TreeGen<Person>({ fields: { ...personFields, city: untyped } })).toThrow(
      new ConfigError(
        "TreeGen: field 'city' needs inputs (category) but is not bound. Use .bind({ category: ... }).",
      ),
    );
    expect(() => untyped.bind({})).toThrow(new ConfigError("bound SubCategorySamplerGen 'gen_city': missing inputs: category."));
    expect(() => untyped.bind({ category: ref.country, extra: ref.age })).toThrow(
      new ConfigError("bound SubCategorySamplerGen 'gen_city': unknown inputs: extra. Inputs: category."),
    );

    // A ref made for a different type fails at runtime when its field is not in this tree.
    expect(
      () =>
        new TreeGen<{ city: string }>({
          fields: { city: cityGen.bind({ category: ref.country }) },
        }),
    ).toThrow(/reads 'self.country' \(input 'category'\), but 'country' is not a field of this tree/);
  });
});
