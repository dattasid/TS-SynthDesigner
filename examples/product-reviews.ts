// DataDesigner's first tutorial, "The Basics" (docs/notebook_source/1-the-basics.py): a product
// review dataset. Same columns, values and prompts; run it with examples/product-reviews.run.ts.
import { FakerGen } from "../src/faker";
import { CategorySamplerGen, LLMTextGen, NumberSamplerGen, prompt, refs, rootRefs, SubCategorySamplerGen, TreeGen } from "../src/index";

// DataDesigner's person sampler gives a fixed set of columns; here the customer is a type of our
// own, with only the fields we want.
export interface Customer {
  sex: "male" | "female";
  firstName: string;
  lastName: string;
  age: number;
  city: string;
  state: string;
}

export interface ProductReview {
  productCategory: string;
  productSubcategory: string;
  targetAgeRange: string;
  customer: Customer;
  numberOfStars: number;
  reviewStyle: string;
  productName: string;
  customerReview: string;
}

const c = refs<Customer>();

// PersonFromFakerSamplerParams(age_range=[18, 70], locale="en_US"), as a tree of its own.
export const customerGen = new TreeGen<Customer>({
  fields: {
    sex: new CategorySamplerGen<Customer["sex"]>({ values: ["male", "female"] }),
    firstName: FakerGen.bound({ inputs: { sex: c.sex }, fn: (f, { sex }) => f.person.firstName(sex) }),
    lastName: new FakerGen({ fn: (f) => f.person.lastName() }),
    age: new NumberSamplerGen({ type: "uniform", low: 18, high: 70, integer: true }),
    // As in DataDesigner's Faker person, city and state are drawn independently: "Austin, Maine" happens.
    city: new FakerGen({ fn: (f) => f.location.city() }),
    state: new FakerGen({ fn: (f) => f.location.state() }),
  },
});

const r = rootRefs<ProductReview>("productReview");

/** Its LLM fields use the model nickname "writer"; the run script maps it to a model. */
export const productReviewGen = new TreeGen<ProductReview>({
  id: "productReview",
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
