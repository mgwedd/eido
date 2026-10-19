// Generates src/generated/* from schemas/*.schema.json: types, validators and the prompt and
// grammar constants, so the prompt text, the llama-server grammar and the gate's validation
// all come from the same JSON Schema files.
// Dependency-free on purpose: this runs in CI and near the gate's type surface.
// Run: node packages/schemas/scripts/codegen.mjs [--schemas <dir>] [--out <dir>]

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, "..")

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? fallback : resolve(process.argv[index + 1])
}

const schemaDir = argValue("--schemas", join(pkgRoot, "schemas"))
const outDir = argValue("--out", join(pkgRoot, "src", "generated"))

// Keywords llama.cpp's schema-to-grammar converter supports, plus pure annotations.
// Anything else fails the codegen, because the grammar would silently ignore it.
const GRAMMAR_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "enum",
  "const",
  "oneOf",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "format",
])
const ANNOTATION_KEYWORDS = new Set([
  "$schema",
  "title",
  "description",
  "$comment",
])
const SUPPORTED_FORMATS = new Set(["date-time"])

function pascalCase(name) {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("")
}

function propertyKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
}

function loadSchemas() {
  const files = readdirSync(schemaDir)
    .filter((file) => file.endsWith(".schema.json"))
    .sort()
  const schemas = new Map()
  for (const file of files) {
    schemas.set(file, JSON.parse(readFileSync(join(schemaDir, file), "utf8")))
  }
  return schemas
}

function schemaName(schemas, file, base = file.replace(/\.schema\.json$/, "")) {
  return pascalCase(schemas.get(file)?.title ?? base)
}

// Inlines {"$ref": "<file>.schema.json"} so the output has no references (llama.cpp needs
// a self-contained schema) and fails on any keyword the grammar does not support.
function resolveSchema(schemas, schema, path) {
  if (typeof schema.$ref === "string") {
    const target = schemas.get(schema.$ref)
    if (!target) throw new Error(`${path}: unknown $ref ${schema.$ref}`)
    return resolveSchema(schemas, target, schema.$ref)
  }

  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!GRAMMAR_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      throw new Error(
        `${path}: keyword "${key}" is not supported by llama.cpp's grammar`
      )
    }
    if (key === "format" && !SUPPORTED_FORMATS.has(value)) {
      throw new Error(
        `${path}: format "${value}" is not supported by llama.cpp's grammar`
      )
    }
    if (key === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          resolveSchema(schemas, child, `${path}.${name}`),
        ])
      )
    } else if (key === "items") {
      out.items = resolveSchema(schemas, value, `${path}[]`)
    } else if (key === "oneOf") {
      out.oneOf = value.map((child, index) =>
        resolveSchema(schemas, child, `${path}.oneOf[${index}]`)
      )
    } else if (key === "additionalProperties" && value !== false) {
      throw new Error(`${path}: additionalProperties must be false`)
    } else {
      out[key] = value
    }
  }
  return out
}

function typeOf(schemas, schema, depth = 0) {
  if (typeof schema.$ref === "string") {
    return schemaName(schemas, schema.$ref)
  }
  if ("const" in schema) {
    return JSON.stringify(schema.const)
  }
  if (schema.enum) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ")
  }
  if (schema.oneOf) {
    return schema.oneOf
      .map((child) => typeOf(schemas, child, depth))
      .join(" | ")
  }

  switch (schema.type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array":
      return `Array<${schema.items ? typeOf(schemas, schema.items, depth) : "unknown"}>`
    case "object":
      return objectType(schemas, schema, depth)
    default:
      return "unknown"
  }
}

// Renders an object schema as an inline TypeScript object type.
function objectType(schemas, schema, depth) {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const keys = Object.keys(properties)

  if (keys.length === 0) {
    return "Record<string, unknown>"
  }

  const indent = "  ".repeat(depth + 1)
  const lines = keys.map((key) => {
    const optional = required.has(key) ? "" : "?"
    return `${indent}${propertyKey(key)}${optional}: ${typeOf(schemas, properties[key], depth + 1)}`
  })

  return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`
}

function declare(schemas, name, schema) {
  const description = schema.description
    ? `/** ${schema.description.replace(/\*\//g, "*\\/")} */\n`
    : ""

  if (schema.type === "object") {
    return `${description}export interface ${name} ${objectType(schemas, schema, 0)}\n`
  }

  return `${description}export type ${name} = ${typeOf(schemas, schema)}\n`
}

function fieldType(schema) {
  if (schema.type === "array") {
    const caps = [
      schema.minItems !== undefined ? `min ${schema.minItems}` : null,
      schema.maxItems !== undefined ? `max ${schema.maxItems}` : null,
    ].filter(Boolean)
    return `array of ${fieldType(schema.items)}${caps.length ? ` (${caps.join(", ")} items)` : ""}`
  }
  if (schema.type === "string") {
    if (schema.format === "date-time") return "RFC 3339 date-time string"
    const min = schema.minLength ?? 0
    return `string (${min > 0 ? `${min}-` : "up to "}${schema.maxLength} chars)`
  }
  return schema.type
}

// One line per verb plus one line per args field, all read from the verb schema.
function promptText(verbSchemas) {
  const blocks = verbSchemas.map((verb) => {
    const kind = verb.properties.kind.const
    const args = verb.properties.args
    const required = new Set(args.required ?? [])
    const fields = Object.entries(args.properties).map(([name, field]) => {
      const need = required.has(name) ? "required" : "optional"
      const note = field.description ? `: ${field.description}` : ""
      return `  - ${name} (${fieldType(field)}, ${need})${note}`
    })
    return [`${kind}: ${verb.description}`, ...fields].join("\n")
  })
  return ["Intent kinds and their args:", ...blocks].join("\n\n")
}

function tsConst(name, value, type) {
  return `export const ${name}: ${type} = ${JSON.stringify(value, null, 2)}\n`
}

const header = [
  "// Generated by packages/schemas/scripts/codegen.mjs from schemas/*.schema.json.",
  "// Do not edit by hand; change the JSON Schema and re-run the codegen script.",
  "",
]

const schemas = loadSchemas()
const intentSchema = schemas.get("intent.schema.json")
const resultSchema = schemas.get("intent-result.schema.json")
if (!intentSchema?.oneOf || !resultSchema) {
  throw new Error(
    "schemas/intent.schema.json (oneOf verbs) and intent-result.schema.json are required"
  )
}

const verbFiles = intentSchema.oneOf.map((entry) => entry.$ref)
const verbSchemas = verbFiles.map((file) => {
  const verb = schemas.get(file)
  if (!verb) throw new Error(`intent.schema.json: unknown $ref ${file}`)
  return resolveSchema(schemas, verb, file)
})
const kinds = verbSchemas.map((verb) => verb.properties.kind.const)
const resolvedIntent = resolveSchema(
  schemas,
  intentSchema,
  "intent.schema.json"
)
const resolvedResult = resolveSchema(
  schemas,
  resultSchema,
  "intent-result.schema.json"
)

const typesOutput = [
  ...header,
  ...[...schemas.entries()].map(([file, schema]) =>
    declare(schemas, schemaName(schemas, file), schema)
  ),
].join("\n")

const promptOutput = [
  ...header,
  'import type { JsonSchema } from "../validate"',
  "",
  `export const INTENT_KINDS = ${JSON.stringify(kinds)} as const`,
  "",
  `export const INTENT_PROMPT_TEXT = ${JSON.stringify(promptText(verbSchemas))}`,
  "",
  "// The exact object to pass as json_schema to llama-server.",
  tsConst("INTENT_RESULT_JSON_SCHEMA", resolvedResult, "JsonSchema"),
].join("\n")

// Non-intent schemas that get a validator: every profile-*.schema.json (core validates its
// writes), every gate-*.schema.json (the web app and the gate check API bodies), and the
// connector manifest (the gate validates it before pinning). Structural checks only; semantic
// ones live next to their callers (core, and src/manifest.ts for manifests).
const profileFiles = [...schemas.keys()].filter(
  (file) =>
    file.startsWith("profile-") ||
    file.startsWith("gate-") ||
    file === "connector-manifest.schema.json"
)
const constName = (name) =>
  `${name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_JSON_SCHEMA`
const profileValidators = profileFiles.flatMap((file) => {
  const name = schemaName(schemas, file)
  const resolved = resolveSchema(schemas, schemas.get(file), file)
  return [
    tsConst(constName(name), resolved, "JsonSchema"),
    `export function validate${name}(value: unknown): ValidationResult<${name}> {`,
    `  const errors = validate(${constName(name)}, value)`,
    "  // The schema check above is what makes this narrowing sound.",
    `  return errors.length === 0 ? { ok: true, value: value as ${name} } : { ok: false, errors }`,
    "}",
    "",
  ]
})

const validatorsOutput = [
  ...header,
  `import type { Intent, IntentResult, ${profileFiles.map((f) => schemaName(schemas, f)).join(", ")} } from "./types"`,
  'import { validate } from "../validate"',
  'import { INTENT_RESULT_JSON_SCHEMA } from "./prompt"',
  'import type { JsonSchema, ValidationResult } from "../validate"',
  "",
  tsConst("INTENT_JSON_SCHEMA", resolvedIntent, "JsonSchema"),
  "export function validateIntent(value: unknown): ValidationResult<Intent> {",
  "  const errors = validate(INTENT_JSON_SCHEMA, value)",
  "  // The schema check above is what makes this narrowing sound.",
  "  return errors.length === 0 ? { ok: true, value: value as Intent } : { ok: false, errors }",
  "}",
  "",
  "export function validateIntentResult(value: unknown): ValidationResult<IntentResult> {",
  "  const errors = validate(INTENT_RESULT_JSON_SCHEMA, value)",
  "  // The schema check above is what makes this narrowing sound.",
  "  return errors.length === 0 ? { ok: true, value: value as IntentResult } : { ok: false, errors }",
  "}",
  "",
  ...profileValidators,
].join("\n")

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, "types.ts"), typesOutput)
writeFileSync(join(outDir, "prompt.ts"), promptOutput)
writeFileSync(join(outDir, "validators.ts"), validatorsOutput)
console.log(
  `codegen: wrote ${outDir} (${schemas.size} schema(s), ${kinds.length} verb(s))`
)
