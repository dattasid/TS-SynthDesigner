import { describe, expect, it } from "vitest";
import { ConfigError, s, type Infer, type Schema } from "../src/index";

const backStory = s.object({
  childhood: s.string({ description: "two sentences about where they grew up" }),
  happiness: s.integer({ min: 1, max: 10, description: "how happy they are now" }),
  mood: s.enum(["calm", "anxious"]),
  hobbies: s.array(s.string(), { maxItems: 3 }),
  nickname: s.string().optional(),
  address: s.object({ city: s.string(), zip: s.string({ description: "5 digits" }) }),
  jobs: s.array(s.object({ title: s.string(), years: s.number({ min: 0 }) }), { description: "past jobs, oldest first" }),
});
type BackStory = Infer<typeof backStory>;

const good = {
  childhood: "Grew up by the sea.",
  happiness: 7,
  mood: "calm",
  hobbies: ["chess"],
  address: { city: "Pune", zip: "41100" },
  jobs: [{ title: "baker", years: 2.5 }],
};

describe("schema builder", () => {
  it("validates a good value and returns it typed; optional keys may be missing or null", () => {
    const result = backStory.validate(good);
    expect(result).toEqual({ ok: true, value: good });
    if (result.ok) {
      const value: BackStory = result.value;
      expect(value.mood).toBe("calm");
    }
    // null for an optional field: the key is left out of the value.
    expect(backStory.validate({ ...good, nickname: null })).toEqual({ ok: true, value: good });
    expect(backStory.validate({ ...good, nickname: "Sam" })).toEqual({ ok: true, value: { ...good, nickname: "Sam" } });
  });

  it("lists every problem with its path, worded for the LLM to fix", () => {
    const result = backStory.validate({
      ...good,
      happiness: 12,
      mood: "happy",
      hobbies: ["a", "b", "c", 4],
      address: { city: "Pune" },
      jobs: [{ title: "baker", years: "two" }],
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        "happiness: expected an integer from 1 to 10, got 12",
        'mood: expected one of "calm", "anxious", got "happy"',
        "hobbies: expected at most 3 items, got 4",
        "hobbies[3]: expected a string, got 4",
        "address.zip: missing",
        'jobs[0].years: expected a number of at least 0, got "two"',
      ],
    });
    // A misspelled key is reported when a field is missing; otherwise extra keys are dropped silently.
    const { childhood, ...rest } = good;
    expect(backStory.validate({ ...rest, childhod: childhood })).toEqual({
      ok: false,
      issues: ["childhood: missing", "childhod: not a field of this object"],
    });
    expect(backStory.validate({ ...good, extra: 1 })).toEqual({ ok: true, value: good });
    expect(backStory.validate([1])).toEqual({ ok: false, issues: ["reply: expected an object, got [1]"] });
    expect(s.integer().validate(2.5)).toEqual({ ok: false, issues: ["reply: expected an integer, got 2.5"] });
  });

  it("writes JSON Schema in the strict-API subset: all keys required, no extra keys, optional = nullable", () => {
    expect(backStory.toJSONSchema()).toEqual({
      type: "object",
      properties: {
        childhood: { type: "string", description: "two sentences about where they grew up" },
        happiness: { type: "integer", minimum: 1, maximum: 10, description: "how happy they are now" },
        mood: { type: "string", enum: ["calm", "anxious"] },
        hobbies: { type: "array", items: { type: "string" }, maxItems: 3 },
        nickname: { anyOf: [{ type: "string" }, { type: "null" }] },
        address: {
          type: "object",
          properties: { city: { type: "string" }, zip: { type: "string", description: "5 digits" } },
          required: ["city", "zip"],
          additionalProperties: false,
        },
        jobs: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, years: { type: "number", minimum: 0 } },
            required: ["title", "years"],
            additionalProperties: false,
          },
          description: "past jobs, oldest first",
        },
      },
      required: ["childhood", "happiness", "mood", "hobbies", "nickname", "address", "jobs"],
      additionalProperties: false,
    });
  });

  it("writes a short shape and generated notes for prompts", () => {
    expect(backStory.shape("")).toBe(
      [
        "{",
        '  "childhood": string,',
        '  "happiness": integer,',
        '  "mood": "calm" | "anxious",',
        '  "hobbies": string[],',
        '  "nickname": string | null,',
        '  "address": {',
        '    "city": string,',
        '    "zip": string',
        "  },",
        '  "jobs": {',
        '    "title": string,',
        '    "years": number',
        "  }[]",
        "}",
      ].join("\n"),
    );
    expect(backStory.notes()).toEqual([
      "- childhood: two sentences about where they grew up",
      "- happiness: how happy they are now; an integer from 1 to 10",
      '- mood: one of "calm", "anxious"',
      "- hobbies: a list of strings, at most 3 items",
      "- nickname: a string; optional (null if unknown)",
      "- address.city: a string",
      "- address.zip: 5 digits",
      "- jobs: past jobs, oldest first; a list of objects",
      "- jobs[].title: a string",
      "- jobs[].years: a number of at least 0",
    ]);
  });

  it("decimalPlaces: asked for in the prompt, replies rounded before the bounds check", () => {
    const product = s.object({ price: s.number({ min: 10, max: 1000, decimalPlaces: 2, description: "the price in dollars" }) });
    expect(product.validate({ price: 19.999 })).toEqual({ ok: true, value: { price: 20 } });
    expect(product.validate({ price: 12.345 })).toEqual({ ok: true, value: { price: 12.35 } });
    expect(product.validate({ price: 1000.004 })).toEqual({ ok: true, value: { price: 1000 } });
    expect(product.validate({ price: 1000.01 })).toEqual({ ok: false, issues: ["price: expected a number from 10 to 1000 with 2 decimal places, got 1000.01"] });
    expect(product.notes()).toEqual(["- price: the price in dollars; a number from 10 to 1000 with 2 decimal places"]);
    expect(product.toJSONSchema().properties).toEqual({
      price: { type: "number", minimum: 10, maximum: 1000, description: "the price in dollars; 2 decimal places" },
    });
    // @ts-expect-error integers have no decimal places
    s.integer({ decimalPlaces: 2 });
    expect(() => s.number({ decimalPlaces: 1.5 })).toThrow(ConfigError);
  });

  it("rejects bad definitions when they are made", () => {
    expect(() => s.integer({ min: 5, max: 1 })).toThrow(ConfigError);
    expect(() => s.integer({ min: 1.5 })).toThrow(/min must be an integer/);
    expect(() => s.enum([])).toThrow(ConfigError);
    expect(() => s.enum(["a", "a"])).toThrow(/repeat/);
    expect(() => s.object({})).toThrow(/at least one field/);
    expect(() => s.object({ a: "string" as never })).toThrow(/field 'a' must be made with s/);
    expect(() => s.array(s.string().optional())).toThrow(/cannot be optional/);
    expect(() => s.string().optional().optional()).toThrow(/twice/);
  });
});

// Type checks only (tsc runs them; vitest never calls this).
export function typeChecks(): void {
  const b = {} as BackStory;
  const mood: "calm" | "anxious" = b.mood;
  const nick: string | undefined = b.nickname;
  const years: number = b.jobs[0]!.years;
  void [mood, nick, years];
  // @ts-expect-error mood is "calm" | "anxious", not any string.
  const m: BackStory["mood"] = "happy";
  // @ts-expect-error nickname is optional, so it may be undefined.
  const n: string = b.nickname;
  // @ts-expect-error 'hapiness' is not a field.
  void b.hapiness;
  void [m, n];

  // Checking a schema against an existing interface.
  interface Pet {
    name: string;
    age: number;
  }
  const pet: Schema<Pet> = s.object({ name: s.string(), age: s.integer() });
  // @ts-expect-error age is missing from the schema.
  const pet2: Schema<Pet> = s.object({ name: s.string() });
  // @ts-expect-error age is a string in the schema, a number in Pet.
  const pet3: Schema<Pet> = s.object({ name: s.string(), age: s.string() });
  void [pet, pet2, pet3];
}
