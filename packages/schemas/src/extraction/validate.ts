import type { ExtractedFields, SourceSpan } from "../generated/types"
import { validateExtractedFieldsShape } from "../generated/validators"
import type { ValidationResult } from "../validate"

/** JSON Schema checks the shape; this enforces the span's cross-field ordering. */
export function validateExtractedFields(
  value: unknown
): ValidationResult<ExtractedFields> {
  const shape = validateExtractedFieldsShape(value)
  if (!shape.ok) return shape
  const fields = shape.value
  const errors: string[] = []
  for (const key of [
    "action",
    "party",
    "reference_number",
    "amount",
    "due_date",
  ] as const) {
    const field = fields[key]
    if (field && !validSpan(field.span))
      errors.push(`$.${key}.span.end: must be greater than start`)
  }
  return errors.length === 0 ? shape : { ok: false, errors }
}

function validSpan(span: SourceSpan): boolean {
  return span.end > span.start
}
