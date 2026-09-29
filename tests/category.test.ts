import { describe, expect, it } from "vitest";
import {
  CategorySamplerGen,
  ConfigError,
  GenerationError,
  preview,
  refs,
  SubCategorySamplerGen,
  TreeGen,
} from "../src/index";

describe("category samplers", () => {
  it("CategorySamplerGen picks values by weight", () => {
    // Weights sit next to their values; there is no separate weights array to get out of sync.
    const plan = new CategorySamplerGen({ values: { free: 6, pro: 3, enterprise: 1 } });
    const { records } = preview({ gen: plan, numRecords: 10_000, seed: 1 });
    const share = (v: string) => records.filter((r) => r === v).length / records.length;
    expect(share("free")).toBeCloseTo(0.6, 1);
    expect(share("pro")).toBeCloseTo(0.3, 1);
    expect(share("enterprise")).toBeCloseTo(0.1, 1);

    // A plain list means equal weights.
    const coin = new CategorySamplerGen({ values: ["heads", "tails"] });
    expect(new Set(preview({ gen: coin, numRecords: 100, seed: 1 }).records)).toEqual(new Set(["heads", "tails"]));

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
        }).bind({ category: ref("country") }),
        country: new CategorySamplerGen<Country>({ values: ["Canada", "France"] }),
      },
    });

    const { records } = preview({ gen: place, numRecords: 1_000, seed: 3 });
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
        city: new SubCategorySamplerGen({ values: { Canada: ["Toronto"] } }).bind({ category: loose("country") }),
      },
    });
    expect(() => preview({ gen: broken, numRecords: 50, seed: 3 })).toThrow(GenerationError);
  });
});
