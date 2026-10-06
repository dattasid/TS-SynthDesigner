// DataDesigner's first tutorial, "The Basics" (docs/notebook_source/1-the-basics.py): a product
// review dataset. Same columns, values and prompts. Runs on OpenRouter into scratch/product-reviews.jsonl:
//   npx tsx examples/product-reviews.ts [numRecords]
// Needs an OpenRouter key in the env var OPENROUTER_API_KEY or in a file of that name.
// Imported (by the tests, by tutorial 2), it only defines the generator.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FakerGen } from "../src/faker";
import { CategorySamplerGen, create, LLMTextGen, NumberSamplerGen, prompt, Provider, refs, rootRefs, s, SubCategorySamplerGen, TreeGen, type Infer } from "../src/index";

// The tutorial's model config: the LLM fields ask for "writer", and this says what it is.
// temperature 1, top_p 0.95, max 2048 tokens, thinking off.
const providers = {
  openrouter: Provider.openRouter({ apiKey: existsSync("OPENROUTER_API_KEY") ? { file: "OPENROUTER_API_KEY" } : { env: "OPENROUTER_API_KEY" } }),
};
const models = {
  writer: {
    provider: "openrouter",
    model: "qwen/qwen3.8-flash",
    temperature: 1,
    topP: 0.95,
    maxTokens: 2048,
    extra: { reasoning: { enabled: false } },
  },
};

// DataDesigner's person sampler gives a fixed set of columns; here the customer is a type of our
// own, with only the fields we want.
export const Customer = s.object({
  gender: s.enum(["male", "female"]),
  firstName: s.string(),
  lastName: s.string(),
  age: s.integer({ min: 18, max: 70 }),
  city: s.string(),
  state: s.string(),
}, { name: "customer" });
export type Customer = Infer<typeof Customer>;

export const ProductReview = s.object({
  productCategory: s.string(),
  productSubcategory: s.string(),
  targetAgeRange: s.string(),
  customer: Customer,
  numberOfStars: s.integer({ min: 1, max: 5 }),
  reviewStyle: s.string(),
  productName: s.string(),
  customerReview: s.string(),
}, { name: "productReview" });
export type ProductReview = Infer<typeof ProductReview>;

const c = refs(Customer);

// PersonFromFakerSamplerParams(age_range=[18, 70], locale="en_US"), as a tree of its own.
export const customerGen = new TreeGen({
  schema: Customer,
  fields: {
    gender: new CategorySamplerGen<Customer["gender"]>({ values: ["male", "female"] }),
    firstName: FakerGen.bound({ inputs: { sex: c.gender }, fn: (f, { sex }) => f.person.firstName(sex) }),
    lastName: new FakerGen({ fn: (f) => f.person.lastName() }),
    age: new NumberSamplerGen({ type: "uniform", low: 18, high: 70, integer: true }),
    // As in DataDesigner's Faker person, city and state are drawn independently: "Austin, Maine" happens.
    city: new FakerGen({ fn: (f) => f.location.city() }),
    state: new FakerGen({ fn: (f) => f.location.state() }),
  },
});

const r = rootRefs(ProductReview);

/** Its LLM fields use the model nickname "writer"; `models` above (or a test's mock) says what it is. */
export const productReviewGen = new TreeGen({
  id: "productReview",
  schema: ProductReview,
  fields: {
    productCategory: new CategorySamplerGen({
      values: ["Electronics", "Clothing", "Home & Kitchen", "Books", "Home Office"],
    }),
    productSubcategory: new SubCategorySamplerGen({
      values: {
        Electronics: ["Smartphones", "Laptops", "Headphones", "Cameras", "Accessories"],
        Clothing: ["Men's Clothing", "Women's Clothing", "Winter Coats", "Activewear", "Accessories"],
        "Home & Kitchen": ["Appliances", "Cookware", "Furniture", "Decor", "Organization"],
        Books: ["Fiction", "Non-Fiction", "Self-Help", "Textbooks", "Classics"],
        "Home Office": ["Desks", "Chairs", "Storage", "Office Supplies", "Lighting"],
      },
    }).bind({ category: r.productCategory }),
    targetAgeRange: new CategorySamplerGen({ values: ["18-25", "25-35", "35-50", "50-65", "65+"] }),

    customer: customerGen,
    // DataDesigner samples a float in [1, 5) and converts it to int, so 5 stars almost never comes up.
    // Here the bounds are both included.
    numberOfStars: new NumberSamplerGen({ type: "uniform", low: 1, high: 5, integer: true }),
    reviewStyle: new CategorySamplerGen({
      values: { rambling: 1, brief: 2, detailed: 2, "structured with bullet points": 1 },
    }),

    productName: new LLMTextGen({
      model: "writer",
      prompt: prompt`You are a helpful assistant that generates product names. DO NOT add quotes around the product name.

Come up with a creative product name for a product in the '${r.productCategory}' category, focusing on products related to '${r.productSubcategory}'. The target age range of the ideal customer is ${r.targetAgeRange} years old. Respond with only the product name, no other text.`,
    }),
    customerReview: new LLMTextGen({
      model: "writer",
      prompt: prompt`You are a customer named ${r.customer.firstName} from ${r.customer.city}, ${r.customer.state}. You are ${r.customer.age} years old and recently purchased a product called ${r.productName}. Write a review of this product, which you gave a rating of ${r.numberOfStars} stars. The style of the review should be '${r.reviewStyle}'. Respond with only the review, no other text.`,
    }),
  },
});

// Run only when executed directly, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const numRecords = Number(process.argv[2] ?? 10);
  const path = "scratch/product-reviews.jsonl";
  const { seed } = await create({ gen: productReviewGen, numRecords, path, overwrite: true, seed: 2026, providers, models });
  console.log(`${numRecords} records in ${path} (seed ${seed.join(",")})`);
}
