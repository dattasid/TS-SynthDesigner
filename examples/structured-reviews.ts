// DataDesigner's second tutorial, "Structured Outputs, Jinja Expressions, and Conditional Generation"
// (docs/notebook_source/2-structured-outputs-and-jinja-expressions.py). Same columns, values and
// prompts. Runs on OpenRouter into scratch/structured-reviews.jsonl:
//   npx tsx examples/structured-reviews.ts [numRecords]
// Needs an OpenRouter key in the env var OPENROUTER_API_KEY or in a file of that name.
// Imported (by the tests), it only defines the generator.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CategorySamplerGen,
  create,
  FunctionGen,
  LLMStructuredGen,
  LLMTextGen,
  match,
  MatchGen,
  prompt,
  Provider,
  rootRefs,
  SchemaBuilder,
  SubCategorySamplerGen,
  TreeGen,
  type Infer,
  type Output,
} from "../src/index";
import { Customer, customerGen } from "./product-reviews";

const s = SchemaBuilder;

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

// The tutorial's Pydantic models, as LLM reply schemas.
export const Product = s.object({
  name: s.string({ description: "The name of the product" }),
  description: s.string({ description: "A description of the product" }),
  // Decimal(ge=10, le=1000, decimal_places=2). A JS number, not a decimal: fine for a demo.
  price: s.number({ description: "The price of the product", min: 10, max: 1000, decimalPlaces: 2 }),
}, { name: "product" });

export const ProductReview = s.object({
  rating: s.integer({ description: "The rating of the product", min: 1, max: 5 }),
  customerMood: s.enum(["irritated", "mad", "happy", "neutral", "excited"], { description: "The mood of the customer" }),
  review: s.string({ description: "A review of the product" }),
}, { name: "customerReview" });

export const StructuredReview = s.object({
  // drop=True: generated and readable by the other fields, but not in the records.
  customer: Customer.temp(),
  productCategory: s.string(),
  productSubcategory: s.string(),
  targetAgeRange: s.string(),
  reviewStyle: s.string(),
  customerName: s.string(),
  customerAge: s.integer(),
  product: Product,
  customerReview: ProductReview,
  // Skipped (undefined) unless the rating is low, so optional.
  complaintAnalysis: s.string().optional(),
  actionItems: s.string().optional(),
  reviewSummary: s.string(),
}, { name: "review" });
export type StructuredReview = Infer<typeof StructuredReview>;
/** A record as written: no customer. */
export type StructuredReviewRecord = Output<typeof StructuredReview>;

const r = rootRefs(StructuredReview);

/** Its LLM fields use the model nickname "writer"; `models` above (or a test's mock) says what it is. */
export const structuredReviewGen = new TreeGen({
  id: "structuredReview",
  schema: StructuredReview,
  fields: {
    // PersonFromFakerSamplerParams(); tutorial 1's customer tree. (DataDesigner's default ages are
    // 18-114; this one's are 18-70.)
    customer: customerGen,
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

    // conditional_params: always rambling for 18-25, else the weighted sample.
    reviewStyle: new MatchGen({
      inputs: { age: r.targetAgeRange },
      cases: [{ when: ({ age }) => age === "18-25", then: "rambling" }],
      otherwise: new CategorySamplerGen({
        values: { rambling: 1, brief: 2, detailed: 2, "structured with bullet points": 1 },
      }),
    }),

    // Jinja expressions, as functions. "{{ customer.age }}" is text in DataDesigner; here a number.
    customerName: FunctionGen.bound({
      inputs: { first: r.customer.firstName, last: r.customer.lastName },
      fn: ({ first, last }) => `${first} ${last}`,
    }),
    customerAge: FunctionGen.bound({ inputs: { age: r.customer.age }, fn: ({ age }) => age }),

    product: new LLMStructuredGen({
      model: "writer",
      schema: Product,
      prompt: prompt`Create a product in the '${r.productCategory}' category, focusing on products  related to '${r.productSubcategory}'. The target age range of the ideal customer is ${r.targetAgeRange} years old. The product should be priced between $10 and $1000.`,
    }),

    // {% if %} / {% else %} in the prompt, as a match.
    customerReview: new LLMStructuredGen({
      model: "writer",
      schema: ProductReview,
      prompt: prompt`Your task is to write a review for the following product:

Product Name: ${r.product.name}
Product Description: ${r.product.description}
Price: ${r.product.price}

Imagine your name is ${r.customerName} and you are from ${r.customer.city}, ${r.customer.state}. Write the review in a style that is '${r.reviewStyle}'.`
        .match({
          inputs: { age: r.targetAgeRange },
          cases: [{ when: ({ age }) => age === "18-25", then: "Make sure the review is more informal and conversational.\n" }],
          otherwise: "Make sure the review is more formal and structured.\n",
        })
        .append("The review field should contain only the review, no other text."),
    }),

    // skip.when "rating > 2": a match without otherwise is undefined for the rows no case takes,
    // and only the low-rated rows call the LLM.
    complaintAnalysis: new MatchGen({
      inputs: { rating: r.customerReview.rating },
      cases: [{
        when: ({ rating }) => rating <= 2,
        then: new LLMTextGen({
          model: "writer",
          prompt: prompt`A customer reviewed '${r.product.name}' (${r.productCategory} / ${r.productSubcategory}).

Review: ${r.customerReview.review}
Rating: ${r.customerReview.rating}/5
Mood: ${r.customerReview.customerMood}

Write a short root-cause analysis of why this customer is unhappy and suggest one concrete improvement the product team could make.`,
        }),
      }],
    }),

    // Skip propagation is not automatic here: the skip is spelled out, on the field it depends on.
    actionItems: new MatchGen({
      inputs: { analysis: r.complaintAnalysis },
      cases: [{
        when: ({ analysis }) => analysis !== undefined,
        then: new LLMTextGen({
          model: "writer",
          prompt: prompt`Based on this complaint analysis:
${r.complaintAnalysis}

List 2-3 concrete action items for the product team.`,
        }),
      }],
    }),

    // propagate_skip=False: always generated, with the analysis only when there is one.
    reviewSummary: new LLMTextGen({
      model: "writer",
      prompt: prompt`Summarize this product review in one sentence:
Product: ${r.product.name}
Rating: ${r.customerReview.rating}/5
Review: ${r.customerReview.review}
${match({
  inputs: { analysis: r.complaintAnalysis },
  cases: [{ when: ({ analysis }) => analysis !== undefined, then: prompt`Complaint analysis: ${r.complaintAnalysis}\n` }],
})}`,
    }),
  },
});

// Run only when executed directly, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const numRecords = Number(process.argv[2] ?? 10);
  const path = "scratch/structured-reviews.jsonl";
  const { seed } = await create({ gen: structuredReviewGen, numRecords, path, overwrite: true, seed: 2026, providers, models });
  console.log(`${numRecords} records in ${path} (seed ${seed.join(",")})`);
}
