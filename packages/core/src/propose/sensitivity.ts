import type { Intent } from "@eido/schemas"
import type { ModelClient } from "../inference/types"

// Core local sensitivity classifier (issue #304).
// Runs local deterministic rules and/or a local model (never a cloud API) over proposed text.
// Fails closed: an error or timeout yields "sensitive".
// Model output can only escalate; absence means "not flagged", never "normal" or "safe".

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/
const PHONE_PATTERN =
  /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/
const LONG_DIGITS_PATTERN = /\b\d{12,}\b/

const SENSITIVE_TERMS_PATTERN = new RegExp(
  "\\b(" +
    // Health / Medical
    "doctor|physician|hospital|clinic|patient|diagnosis|prescription|medication|treatment|disease|illness|psychiatrist|psychologist|therapy|therapist|surgery|medical|cardiology|oncology|biopsy|vaccine|" +
    // Legal
    "lawyer|attorney|lawsuit|litigation|court|subpoena|affidavit|plaintiff|defendant|settlement|contract|nda|legal|juror|verdict|indictment|prosecutor|" +
    // Money / Financial / Identifiers
    "salary|mortgage|ssn|social security|bank account|routing number|credit card|wire transfer|tax return|w-2|1099|financial aid|payroll" +
    ")\\b",
  "i"
)

export interface SensitivityClassifierOptions {
  model?: ModelClient
  timeoutMs?: number
  signal?: AbortSignal
}

const SENSITIVITY_JSON_SCHEMA = {
  type: "object",
  properties: {
    sensitive: { type: "boolean" },
  },
  required: ["sensitive"],
  additionalProperties: false,
}

const SYSTEM_PROMPT =
  'You are a local data sensitivity classifier. Determine whether the provided text contains sensitive personal information, including health or medical details, legal matters, financial records, government IDs, or private credentials. Respond strictly with JSON: {"sensitive": true} if the text contains sensitive information, or {"sensitive": false} if it does not.'

function matchesRules(text: string): boolean {
  return (
    EMAIL_PATTERN.test(text) ||
    PHONE_PATTERN.test(text) ||
    LONG_DIGITS_PATTERN.test(text) ||
    SENSITIVE_TERMS_PATTERN.test(text)
  )
}

/**
 * Classifies text for sensitivity.
 * Returns "sensitive" if rules match, if the model classifies it as sensitive,
 * or if the model call errors / times out (fail-closed).
 * Returns undefined if not flagged (never "normal").
 */
export async function classifySensitivity(
  text: string,
  options?: SensitivityClassifierOptions
): Promise<"sensitive" | undefined> {
  if (!text || text.trim() === "") return undefined

  if (matchesRules(text)) {
    return "sensitive"
  }

  if (options?.model === undefined) {
    return undefined
  }

  try {
    const signal = options.signal
    let timer: NodeJS.Timeout | undefined
    const timeoutController = new AbortController()
    if (signal) {
      signal.addEventListener("abort", () => timeoutController.abort(), {
        once: true,
      })
    }
    const timeoutPromise =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timeoutController.abort()
              reject(new Error("classifier timeout"))
            }, options.timeoutMs)
          })
        : undefined

    try {
      const call = options.model.complete(
        {
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: text }],
          jsonSchema: SENSITIVITY_JSON_SCHEMA,
          maxTokens: 32,
          temperature: -1,
        },
        { signal: timeoutController.signal }
      )

      const result = timeoutPromise
        ? await Promise.race([call, timeoutPromise])
        : await call

      let parsed: unknown
      try {
        parsed = JSON.parse(result.text)
      } catch {
        // Model output not parseable as JSON -> fail closed
        return "sensitive"
      }

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "sensitive" in parsed &&
        parsed.sensitive === true
      ) {
        return "sensitive"
      }

      return undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    // Fail closed: a classifier error or timeout in core marks the proposal sensitive.
    return "sensitive"
  }
}

/** Extracts candidate free text from an intent. */
export function extractIntentFreeText(intent: Intent): string[] {
  const texts: string[] = []
  if (
    "args" in intent &&
    typeof intent.args === "object" &&
    intent.args !== null
  ) {
    const args = intent.args as Record<string, unknown>
    for (const key of ["title", "notes", "text", "body", "content"]) {
      const val = args[key]
      if (typeof val === "string" && val.trim()) texts.push(val)
    }
    if (Array.isArray(args.checklist)) {
      for (const item of args.checklist) {
        if (typeof item === "string" && item.trim()) texts.push(item)
      }
    }
  }
  return texts
}

/**
 * Classifies an intent. If any free text is sensitive (or on classifier error),
 * returns a new intent with `sensitivity: "sensitive"`.
 */
export async function classifyIntentSensitivity(
  intent: Intent,
  options?: SensitivityClassifierOptions
): Promise<Intent> {
  if ("sensitivity" in intent && intent.sensitivity === "sensitive") {
    return intent
  }
  const texts = extractIntentFreeText(intent)
  for (const text of texts) {
    const res = await classifySensitivity(text, options)
    if (res === "sensitive") {
      return { ...intent, sensitivity: "sensitive" }
    }
  }
  return intent
}
