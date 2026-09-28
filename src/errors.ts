/** A Gen or tree is configured wrongly. Thrown when it is constructed, before anything is generated. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Generation hit a value the config cannot handle. Thrown while generating. */
export class GenerationError extends Error {
  override name = "GenerationError";
}
