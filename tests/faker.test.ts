import { base, de, en } from "@faker-js/faker";
import { describe, expect, it } from "vitest";
import { FAKER_DEFAULT_REF_DATE, FakerGen } from "../src/faker";
import { CategorySamplerGen, ConfigError, Context, NumberSamplerGen, previewSync, refs, s, TreeGen, type Infer } from "../src/index";

const Customer = s.object({
  sex: s.enum(["male", "female"]),
  firstName: s.string(),
  lastName: s.string(),
  age: s.integer(),
  birthDate: s.string(),
});
type Customer = Infer<typeof Customer>;

const c = refs(Customer);

const customerFields = {
  sex: new CategorySamplerGen<Customer["sex"]>({ values: ["male", "female"] }),
  firstName: FakerGen.bound({ inputs: { sex: c.sex }, fn: (f, { sex }) => f.person.firstName(sex) }),
  lastName: new FakerGen({ fn: (f) => f.person.lastName() }),
  age: new NumberSamplerGen({ type: "uniform", low: 18, high: 70, integer: true }),
  birthDate: FakerGen.bound({
    inputs: { age: c.age },
    fn: (f, { age }) => f.date.birthdate({ mode: "age", min: age, max: age }).toISOString().slice(0, 10),
  }),
};
const customer = new TreeGen({ id: "customer", schema: Customer, fields: customerFields });

describe("FakerGen", () => {
  it("is reproducible from the run's seed, and draws from its field's own stream", () => {
    const { records } = previewSync({ gen: customer, numRecords: 20, seed: 7 });
    expect(previewSync({ gen: customer, numRecords: 20, seed: 7 }).records).toEqual(records);
    expect(previewSync({ gen: customer, numRecords: 20, seed: 8 }).records).not.toEqual(records);

    // Another field drawing more randomness does not move faker's values. The schema is extended by
    // spreading, so the fields made with refs(Customer) still fit.
    const Busier = s.object({ ...Customer.fields, email: s.string() });
    const busier = new TreeGen({
      schema: Busier,
      fields: { ...customerFields, email: new FakerGen({ fn: (f) => f.internet.email() }) },
    });
    const withEmail = previewSync({ gen: busier, numRecords: 20, seed: 7 }).records;
    expect(withEmail.map(({ email: _, ...rest }) => rest)).toEqual(records);
  });

  it("reads other fields: first names follow sex, birth dates follow age", () => {
    const { records } = previewSync({ gen: customer, numRecords: 50, seed: 1 });
    const female = new Set(en.person!.first_name!.female);
    const male = new Set(en.person!.first_name!.male);
    for (const r of records) {
      expect((r.sex === "female" ? female : male).has(r.firstName)).toBe(true);
      // Relative to the fixed default reference date, so the same on any day.
      const refYear = new Date(FAKER_DEFAULT_REF_DATE).getUTCFullYear();
      expect(refYear - Number(r.birthDate.slice(0, 4)) - r.age).toBeGreaterThanOrEqual(0);
      expect(refYear - Number(r.birthDate.slice(0, 4)) - r.age).toBeLessThanOrEqual(1);
    }
  });

  it("takes a locale and a reference date", () => {
    const tree = new TreeGen({
      schema: s.object({ lastName: s.string(), joined: s.string() }),
      fields: {
        lastName: new FakerGen({ locale: [de, en, base], fn: (f) => f.person.lastName() }),
        joined: new FakerGen({ refDate: "2000-06-01", fn: (f) => f.date.past({ years: 1 }).toISOString() }),
      },
    });
    const german = new Set(de.person!.last_name!.generic);
    for (const r of previewSync({ gen: tree, numRecords: 20, seed: 2 }).records) {
      expect(german.has(r.lastName)).toBe(true);
      expect(r.joined >= "1999-06-01" && r.joined < "2000-06-01").toBe(true);
    }
  });

  it("rejects faker.seed(), async fns and bad dates", () => {
    const ctx = Context.create({ seed: 1 });
    expect(() => new FakerGen({ fn: (f) => f.seed(3) }).generate({}, ctx)).toThrow(/seed the run/);
    expect(() => new FakerGen({ fn: async (f) => f.person.lastName() }).generate({}, ctx)).toThrow(/must be synchronous/);
    expect(() => new FakerGen({ refDate: "someday", fn: (f) => f.person.lastName() })).toThrow(ConfigError);
  });

  it("is typed by fn's return", () => {
    new TreeGen({
      schema: s.object({ age: s.integer() }),
      // @ts-expect-error a string Gen for a number field
      fields: { age: new FakerGen({ fn: (f) => f.person.firstName() }) },
    });
    // @ts-expect-error firstName takes "male" | "female", and sex is a plain string here
    FakerGen.bound({ inputs: { sex: refs(s.object({ sex: s.string() })).sex }, fn: (f, { sex }) => f.person.firstName(sex) });
  });
});
