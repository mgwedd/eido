// Narrowing helpers for Gmail's JSON responses, which are external input: each field is checked,
// nothing is cast.

export type JsonObject = Record<string, unknown>

export function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined
  return Object.fromEntries(Object.entries(value))
}

export function optionalString(
  object: JsonObject | undefined,
  key: string
): string | undefined {
  const value = object?.[key]
  return typeof value === "string" ? value : undefined
}

export function objects(
  object: JsonObject | undefined,
  key: string
): JsonObject[] {
  const value = object?.[key]
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: unknown) => {
    const item = asObject(entry)
    return item === undefined ? [] : [item]
  })
}

export function strings(object: JsonObject | undefined, key: string): string[] {
  const value = object?.[key]
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry: unknown): entry is string => typeof entry === "string"
  )
}
