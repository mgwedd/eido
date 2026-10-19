// JSON Schema source of truth for intents and extractions; types, validators and the
// prompt and grammar constants are generated from it.
export const SCHEMA_VERSION = 0

export * from "./generated/types"
export {
  INTENT_KINDS,
  INTENT_PROMPT_TEXT,
  INTENT_RESULT_JSON_SCHEMA,
} from "./generated/prompt"
export {
  INTENT_JSON_SCHEMA,
  validateIntent,
  validateIntentResult,
} from "./generated/validators"
export type { JsonSchema, ValidationResult } from "./validate"
