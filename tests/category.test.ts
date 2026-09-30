import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CategorySamplerGen,
  ConfigError,
  GenerationError,
  previewSync,
  refs,
  SubCategorySamplerGen,
  TreeGen,
} from "../src/index";

describe("category samplers", () => {
  it("CategorySamplerGen picks values by weight", () => {
    // Weights sit next to their values; there is no separate weights array to get out of sync.
    const plan = new CategorySamplerGen({ values: { free: 6, pro: 3, enterprise: 1 } });
    const { records } = previewSync({ gen: plan, numRecords: 10_000, seed: 1 });
    const share = (v: string) => records.filter((r) => r === v).length / records.length;
    expect(share("free")).toBeCloseTo(0.6, 1);
    expect(share("pro")).toBeCloseTo(0.3, 1);
    expect(share("enterprise")).toBeCloseTo(0.1, 1);

    // A plain list means equal weights.
    const coin = new CategorySamplerGen({ values: ["heads", "tails"] });
    expect(new Set(previewSync({ gen: coin, numRecords: 100, seed: 1 }).records)).toEqual(new Set(["heads", "tails"]));

    expect(() => new CategorySamplerGen({ id: "plan", values: { free: 0, pro: 0 } })).toThrow(ConfigError);
  });

  it("SubCategorySamplerGen picks from the list for its category's value", () => {
    type Country = "Canada" | "France";
    interface Place {
      country: Country;
      city: string;
    }
    const ref = refs<Place>();
    const place = new TreeGen<Place>({
      fields: {
        // `city` is declared first but depends on `country`, so `country` is generated first.
        city: new SubCategorySamplerGen({
          values: {
            Canada: ["Toronto", "Vancouver"],
            France: { Paris: 3, Lyon: 1 }, // Paris three times as likely as Lyon
          },
        }).bind({ category: ref.country }),
        country: new CategorySamplerGen<Country>({ values: ["Canada", "France"] }),
      },
    });

    const { records } = previewSync({ gen: place, numRecords: 1_000, seed: 3 });
    for (const { country, city } of records) {
      expect(country === "Canada" ? ["Toronto", "Vancouver"] : ["Paris", "Lyon"]).toContain(city);
    }
    expect(Object.keys(records[0]!)).toEqual(["city", "country"]); // declaration order is kept

    // When the category field is a plain string, a value with no entry fails at generation time.
    interface Loose {
      country: string;
      city: string;
    }
    const loose = refs<Loose>();
    const broken = new TreeGen<Loose>({
      fields: {
        country: new CategorySamplerGen({ values: ["Canada", "Mexico"] }),
        city: new SubCategorySamplerGen({ values: { Canada: ["Toronto"] } }).bind({ category: loose.country }),
      },
    });
    expect(() => previewSync({ gen: broken, numRecords: 50, seed: 3 })).toThrow(GenerationError);
  });

  it("types stay plain strings, so values can come from a file", () => {
    // As if read from cities.json: JSON.parse gives no literal types, and none are needed.
    const cityMap: Record<string, Record<string, number> | string[]> = JSON.parse(
      '{ "Canada": ["Toronto", "Vancouver"], "France": { "Paris": 3, "Lyon": 1 } }',
    );
    const cityGen = new SubCategorySamplerGen({ values: cityMap });
    const inline = new SubCategorySamplerGen({ values: { Canada: ["Toronto"], France: { Paris: 3 } } });

    // The values never become part of the type, whether written inline or loaded.
    expectTypeOf(cityGen).toEqualTypeOf<SubCategorySamplerGen<string, string>>();
    expectTypeOf(inline).toEqualTypeOf<SubCategorySamplerGen<string, string>>();
    expectTypeOf(new CategorySamplerGen({ values: ["a", "b"] })).toEqualTypeOf<CategorySamplerGen<string>>();

    interface Place {
      country: string;
      city: string;
    }
    const place = new TreeGen<Place>({
      fields: {
        country: new CategorySamplerGen({ values: Object.keys(cityMap) }),
        city: cityGen.bind({ category: refs<Place>().country }),
      },
    });
    for (const { country, city } of previewSync({ gen: place, numRecords: 50, seed: 1 }).records) {
      const options = cityMap[country]!;
      expect(Array.isArray(options) ? options : Object.keys(options)).toContain(city);
    }
  });

  it("skew: rank-based weights for lists, most likely first", () => {
    const share = (gen: CategorySamplerGen, value: string) => {
      const { records } = previewSync({ gen, numRecords: 20_000, seed: 2 });
      return records.filter((r) => r === value).length / records.length;
    };
    const five = ["a", "b", "c", "d", "e"];

    // Zipf s = 1: weights 1, 1/2, 1/3, 1/4, 1/5, which normalize to about 44%, 22%, 15%, 11%, 9%.
    const zipf = new CategorySamplerGen({ values: five, skew: "zipf" });
    expect(share(zipf, "a")).toBeCloseTo(0.438, 1);
    expect(share(zipf, "e")).toBeCloseTo(0.088, 1);

    // Geometric r = 0.5: weights 1, 1/2, 1/4, 1/8, 1/16, about 52%, 26%, 13%, 6%, 3%.
    const geometric = new CategorySamplerGen({ values: five, skew: { geometric: 0.5 } });
    expect(share(geometric, "a")).toBeCloseTo(0.516, 1);
    expect(share(geometric, "e")).toBeCloseTo(0.032, 1);

    // SubCategory: each list is skewed on its own, so the first value's share depends on the list's length.
    interface Place {
      country: string;
      city: string;
    }
    const place = new TreeGen<Place>({
      fields: {
        country: new CategorySamplerGen({ values: ["Short", "Long"] }),
        city: new SubCategorySamplerGen({
          values: { Short: ["s1", "s2"], Long: ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"] },
          skew: "zipf",
        }).bind({ category: refs<Place>().country }),
      },
    });
    const { records } = previewSync({ gen: place, numRecords: 20_000, seed: 2 });
    const firstShare = (country: string, first: string) => {
      const inCountry = records.filter((r) => r.country === country);
      return inCountry.filter((r) => r.city === first).length / inCountry.length;
    };
    expect(firstShare("Short", "s1")).toBeCloseTo(0.667, 1); // 1 / (1 + 1/2)
    expect(firstShare("Long", "l1")).toBeCloseTo(0.341, 1); // 1 / (1 + 1/2 + ... + 1/10)

    expect(() => new CategorySamplerGen({ values: five, skew: { geometric: 2 } })).toThrow(ConfigError);
  });
});
