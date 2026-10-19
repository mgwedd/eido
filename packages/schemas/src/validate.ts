// Minimal JSON Schema validator for the keyword subset the codegen allows (see
// scripts/codegen.mjs). Dependency-free; the generated validators call it with the schemas
// generated from schemas/*.schema.json.

export interface JsonSchema {
  readonly $schema?: string
  readonly title?: string
  readonly description?: string
  readonly type?:
    "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: false
  readonly items?: JsonSchema
  readonly minItems?: number
  readonly maxItems?: number
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly oneOf?: readonly JsonSchema[]
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
  readonly minimum?: number
  readonly maximum?: number
  readonly format?: "date-time"
}

export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; errors: string[] }

const RFC_3339 =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/

function typeName(value: unknown): string {
  if (value === null) return "null"
  return Array.isArray(value) ? "array" : typeof value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function matchesType(
  type: NonNullable<JsonSchema["type"]>,
  value: unknown
): boolean {
  switch (type) {
    case "object":
      return isRecord(value)
    case "array":
      return Array.isArray(value)
    case "integer":
      return Number.isInteger(value)
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    default:
      return typeName(value) === type
  }
}

function validateOneOf(
  schema: JsonSchema,
  value: unknown,
  path: string
): string[] {
  const variants = (schema.oneOf ?? []).map((variant) =>
    validate(variant, value, path)
  )
  const matches = variants.filter((errors) => errors.length === 0).length
  if (matches === 1) return []
  if (matches > 1) return [`${path}: matches more than one variant`]
  // Report the variant the value claims to be (its const keys match), else the closest one.
  const claimed = (schema.oneOf ?? []).flatMap((variant, index) =>
    isRecord(value) && discriminatorMatches(variant, value)
      ? [variants[index] ?? []]
      : []
  )
  const candidates = claimed.length > 0 ? claimed : variants
  return candidates.reduce((best, errors) =>
    errors.length < best.length ? errors : best
  )
}

function discriminatorMatches(
  variant: JsonSchema,
  value: Record<string, unknown>
): boolean {
  const consts = Object.entries(variant.properties ?? {}).filter(
    ([, child]) => "const" in child
  )
  return (
    consts.length > 0 &&
    consts.every(([key, child]) => value[key] === child.const)
  )
}

function validateObject(
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string
): string[] {
  const errors: string[] = []
  const properties = schema.properties ?? {}
  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push(`${path}.${key}: required`)
  }
  for (const [key, child] of Object.entries(value)) {
    const childSchema = properties[key]
    if (childSchema) {
      errors.push(...validate(childSchema, child, `${path}.${key}`))
    } else if (schema.additionalProperties === false) {
      errors.push(`${path}.${key}: unknown key`)
    }
  }
  return errors
}

function validateArray(
  schema: JsonSchema,
  value: unknown[],
  path: string
): string[] {
  const errors: string[] = []
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(`${path}: needs at least ${schema.minItems} items`)
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push(`${path}: allows at most ${schema.maxItems} items`)
  }
  const items = schema.items
  if (items) {
    value.forEach((item, index) =>
      errors.push(...validate(items, item, `${path}[${index}]`))
    )
  }
  return errors
}

function validateString(
  schema: JsonSchema,
  value: string,
  path: string
): string[] {
  const errors: string[] = []
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: needs at least ${schema.minLength} characters`)
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push(`${path}: allows at most ${schema.maxLength} characters`)
  }
  if (
    schema.pattern !== undefined &&
    !new RegExp(schema.pattern, "u").test(value)
  ) {
    errors.push(`${path}: does not match pattern ${schema.pattern}`)
  }
  if (schema.format === "date-time" && !RFC_3339.test(value)) {
    errors.push(`${path}: not an RFC 3339 date-time`)
  }
  return errors
}

function validateNumber(
  schema: JsonSchema,
  value: number,
  path: string
): string[] {
  const errors: string[] = []
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: must be at least ${schema.minimum}`)
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${path}: must be at most ${schema.maximum}`)
  }
  return errors
}

export function validate(
  schema: JsonSchema,
  value: unknown,
  path = "$"
): string[] {
  if (schema.oneOf) return validateOneOf(schema, value, path)
  if ("const" in schema && value !== schema.const) {
    return [`${path}: must be ${JSON.stringify(schema.const)}`]
  }
  if (schema.type && !matchesType(schema.type, value)) {
    return [`${path}: expected ${schema.type}, got ${typeName(value)}`]
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [
      `${path}: must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`,
    ]
  }
  if (isRecord(value)) return validateObject(schema, value, path)
  if (Array.isArray(value)) return validateArray(schema, value, path)
  if (typeof value === "string") return validateString(schema, value, path)
  if (typeof value === "number") return validateNumber(schema, value, path)
  return []
}
