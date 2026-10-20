import { execFileSync } from "node:child_process"
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  INTENT_KINDS,
  INTENT_PROMPT_TEXT,
  INTENT_RESULT_JSON_SCHEMA,
  SCHEMA_VERSION,
  validateIntent,
  validateIntentResult,
} from "./index"
import type { JsonSchema } from "./index"
import { validate } from "./validate"

const pkgRoot = join(import.meta.dirname, "..")
const schemaDir = join(pkgRoot, "schemas")
const codegen = join(pkgRoot, "scripts", "codegen.mjs")

const ISO = "2030-01-02T09:00:00Z"
const ISO_END = "2030-01-02T10:00:00+01:00"

// Synthetic payloads: example.com addresses and fake ids only.
const VALID: Record<string, unknown> = {
  "email.draft": {
    to: ["a@example.com"],
    cc: ["b@example.com"],
    subject: "Hi",
    body: "Hello",
    inReplyToMessageId: "m1",
  },
  "email.label": { messageIds: ["m1"], add: ["work"], remove: ["old"] },
  "email.archive": { messageIds: ["m1"] },
  "email.markRead": { messageIds: ["m1"], read: false },
  "email.send": {
    to: ["a@example.com"],
    subject: "Hi",
    body: "Hello",
    draftId: "d1",
  },
  "email.reply": {
    messageId: "m1",
    messageSha256: "ab".repeat(32),
    replyAll: true,
    to: ["a@example.com"],
    cc: ["b@example.com"],
    body: "Thanks",
  },
  "email.forward": {
    messageId: "m1",
    messageSha256: "ab".repeat(32),
    to: ["a@example.com"],
    note: "FYI",
  },
  "email.trash": { messageIds: ["m1"] },
  "calendar.create": {
    entity: "personal",
    category: "health",
    title: "Dentist",
    start: ISO,
    end: ISO_END,
    allDay: false,
    guests: [],
  },
  "calendar.edit": { eventUid: "uid-1", title: "Dentist (moved)", start: ISO },
  "calendar.delete": { eventUid: "uid-1" },
  "reminder.create": { list: "Home", title: "Call back", due: ISO, notes: "n" },
  "file.create": { root: "docs", path: "a/b.txt", content: "x" },
  "file.rename": { root: "docs", path: "a/b.txt", newName: "c.txt" },
  "file.move": { root: "docs", path: "a/b.txt", toPath: "d/b.txt" },
  "file.delete": { root: "docs", path: "a/b.txt" },
}

const EXPECTED_KINDS = Object.keys(VALID)

function intent(kind: string, args: unknown = VALID[kind]) {
  return { kind, args }
}

function errorsOf(value: unknown): string[] {
  const result = validateIntent(value)
  if (result.ok) throw new Error("expected the intent to be rejected")
  return result.errors
}

test("schemas package loads", () => {
  expect(SCHEMA_VERSION).toBe(0)
})

describe("verbs", () => {
  test("email connector selectors are validated and described in the generated prompt", () => {
    const intent = {
      kind: "email.send",
      connector: "gmail",
      args: VALID["email.send"],
    }
    expect(validateIntent(intent)).toMatchObject({ ok: true, value: intent })
    expect(validateIntent({ ...intent, connector: "" }).ok).toBe(false)
    expect(INTENT_PROMPT_TEXT).toContain("email.send:")
    expect(INTENT_PROMPT_TEXT).toContain(
      "connector (string (1-100 chars), optional)"
    )
  })

  test("INTENT_KINDS is exactly the specified verb list", () => {
    expect([...INTENT_KINDS].sort()).toEqual([...EXPECTED_KINDS].sort())
  })

  test("one schema file per verb, named intent-<area>-<verb>.schema.json", () => {
    const files = readdirSync(schemaDir).filter((f) =>
      /^intent-[a-z]+-[A-Za-z]+\.schema\.json$/.test(f)
    )
    const kinds = files.map((f) => {
      const schema = JSON.parse(readFileSync(join(schemaDir, f), "utf8")) as {
        properties: { kind: { const: string } }
      }
      const [, area, verb] =
        /^intent-([a-z]+)-([A-Za-z]+)\.schema\.json$/.exec(f) ?? []
      expect(schema.properties.kind.const).toBe(`${area}.${verb}`)
      return schema.properties.kind.const
    })
    expect(kinds.sort()).toEqual([...EXPECTED_KINDS].sort())
  })

  test.each(EXPECTED_KINDS)("%s: a valid payload is accepted", (kind) => {
    const result = validateIntent(intent(kind))
    expect(result).toEqual({ ok: true, value: intent(kind) })
  })

  test("email.markRead carries messageIds and read; calendar verbs carry entity and category", () => {
    expect(errorsOf(intent("email.markRead", { messageIds: ["m1"] }))).toEqual([
      "$.args.read: required",
    ])
    const noEntity: Record<string, unknown> = {
      ...(VALID["calendar.create"] as object),
    }
    delete noEntity["entity"]
    expect(errorsOf(intent("calendar.create", noEntity))).toEqual([
      "$.args.entity: required",
    ])
    expect(INTENT_PROMPT_TEXT).toContain("category")
  })
})

describe("rejections", () => {
  test("wrong kind value", () => {
    expect(
      errorsOf(intent("email.wire", { messageIds: ["m1"] })).length
    ).toBeGreaterThan(0)
  })

  test("unknown extra key, at the top and in args", () => {
    expect(errorsOf({ ...intent("email.archive"), id: "x" })).toContain(
      "$.id: unknown key"
    )
    expect(
      errorsOf(intent("email.archive", { messageIds: ["m1"], extra: 1 }))
    ).toContain("$.args.extra: unknown key")
  })

  test("missing required key", () => {
    expect(errorsOf({ kind: "email.archive" })).toContain("$.args: required")
    expect(
      errorsOf(intent("email.reply", { messageId: "m1", body: "x" }))
    ).toContain("$.args.replyAll: required")
  })

  test("a reply and a forward refuse a messageSha256 that is not lowercase hex", () => {
    const message = "does not match pattern ^[0-9a-f]{64}$"
    expect(
      errorsOf(
        intent("email.reply", {
          messageId: "m1",
          messageSha256: "Z".repeat(64),
          replyAll: false,
          to: ["a@example.com"],
          body: "x",
        })
      )
    ).toEqual([`$.args.messageSha256: ${message}`])
    expect(
      errorsOf(
        intent("email.forward", {
          messageId: "m1",
          messageSha256: "Z".repeat(64),
          to: ["a@example.com"],
        })
      )
    ).toEqual([`$.args.messageSha256: ${message}`])
  })

  test("a reply and a forward name their target by its bytes, and a reply its recipients", () => {
    const reply = errorsOf(
      intent("email.reply", { messageId: "m1", replyAll: false, body: "x" })
    )
    expect(reply).toContain("$.args.messageSha256: required")
    expect(reply).toContain("$.args.to: required")
    expect(
      errorsOf(intent("email.forward", { messageId: "m1", to: ["a@x.io"] }))
    ).toContain("$.args.messageSha256: required")
    expect(
      errorsOf(
        intent("email.reply", {
          messageId: "m1",
          messageSha256: "ab".repeat(32),
          replyAll: false,
          to: [],
          body: "x",
        })
      )
    ).toContain("$.args.to: needs at least 1 items")
    expect(
      errorsOf(
        intent("email.forward", {
          messageId: "m1",
          messageSha256: "ab".repeat(31),
          to: ["a@x.io"],
        })
      )
    ).toContain("$.args.messageSha256: needs at least 64 characters")
  })

  test("enum and const mismatch", () => {
    const schema: JsonSchema = { enum: ["a", "b"] }
    expect(validateIntentResult({ result: "maybe" }).ok).toBe(false)
    expect(INTENT_RESULT_JSON_SCHEMA.oneOf).toBeDefined()
    // No verb declares a free enum today, so exercise the enum branch through the validator.
    expect(validate(schema, "c")).toEqual(['$: must be one of "a", "b"'])
    expect(validate(schema, "a")).toEqual([])
  })

  test("string over its maxLength, and under its minLength", () => {
    expect(
      errorsOf(
        intent("email.reply", {
          messageId: "m1",
          messageSha256: "ab".repeat(32),
          replyAll: false,
          to: ["a@example.com"],
          body: "x".repeat(20001),
        })
      )
    ).toContain("$.args.body: allows at most 20000 characters")
    expect(errorsOf(intent("email.archive", { messageIds: [""] }))).toContain(
      "$.args.messageIds[0]: needs at least 1 characters"
    )
  })

  test("non-boolean where a boolean is declared", () => {
    expect(
      errorsOf(intent("email.markRead", { messageIds: ["m1"], read: "yes" }))
    ).toContain("$.args.read: expected boolean, got string")
  })

  test("array caps, wrong types and bad dates", () => {
    expect(errorsOf(intent("email.archive", { messageIds: [] }))).toContain(
      "$.args.messageIds: needs at least 1 items"
    )
    expect(
      errorsOf(intent("email.archive", { messageIds: Array(51).fill("m") }))
    ).toContain("$.args.messageIds: allows at most 50 items")
    expect(errorsOf(intent("email.archive", { messageIds: "m1" }))).toContain(
      "$.args.messageIds: expected array, got string"
    )
    expect(errorsOf({ kind: "email.archive", args: null })).toContain(
      "$.args: expected object, got null"
    )
    expect(
      errorsOf(
        intent("calendar.create", {
          ...(VALID["calendar.create"] as object),
          start: "tomorrow",
        })
      )
    ).toEqual([
      "$.args.start: needs at least 20 characters",
      "$.args.start: not an RFC 3339 date-time",
    ])
  })

  test("an intent must not be a non-object", () => {
    expect(validateIntent("email.archive").ok).toBe(false)
    expect(validateIntent([]).ok).toBe(false)
  })
})

describe("intent result", () => {
  test("none and an empty intents list both validate; {} does not", () => {
    expect(
      validateIntentResult({ result: "none", reason: "nothing to do" }).ok
    ).toBe(true)
    expect(validateIntentResult({ result: "intents", intents: [] }).ok).toBe(
      true
    )
    expect(validateIntentResult({}).ok).toBe(false)
  })

  test("intents validate each entry and cap the list at 10", () => {
    const one = intent("email.archive")
    expect(validateIntentResult({ result: "intents", intents: [one] }).ok).toBe(
      true
    )
    expect(
      validateIntentResult({ result: "intents", intents: Array(11).fill(one) })
        .ok
    ).toBe(false)
    expect(
      validateIntentResult({
        result: "intents",
        intents: [{ kind: "email.archive" }],
      }).ok
    ).toBe(false)
    expect(
      validateIntentResult({ result: "none", reason: "x".repeat(501) }).ok
    ).toBe(false)
  })
})

// Walks a schema and calls back for every property name, enum value and kind const.
function walk(
  schema: JsonSchema,
  visit: (node: JsonSchema, names: string[]) => void
): void {
  const names = [
    ...Object.keys(schema.properties ?? {}),
    ...(schema.enum ?? []).map(String),
    ...(typeof schema.const === "string" ? [schema.const] : []),
  ]
  visit(schema, names)
  Object.values(schema.properties ?? {}).forEach((child) => walk(child, visit))
  if (schema.items) walk(schema.items, visit)
  schema.oneOf?.forEach((child) => walk(child, visit))
}

describe("schema walk", () => {
  test("every string has maxLength, every array maxItems, every object is closed", () => {
    walk(INTENT_RESULT_JSON_SCHEMA, (node) => {
      if (node.type === "string") expect(node.maxLength).toBeTypeOf("number")
      if (node.type === "array") expect(node.maxItems).toBeTypeOf("number")
      if (node.type === "object") expect(node.additionalProperties).toBe(false)
    })
  })

  test("no money-movement or hard-delete term appears; only removal verbs are the known ones", () => {
    const forbidden = [
      "pay",
      "transfer",
      "wire",
      "purchase",
      "charge",
      "permanent",
      "purge",
      "shred",
      "empty_trash",
      "hard_delete",
    ]
    walk(INTENT_RESULT_JSON_SCHEMA, (_node, names) => {
      for (const name of names) {
        const normalized = name
          .replace(/([a-z])([A-Z])/g, "$1_$2")
          .toLowerCase()
        const tokens = normalized.split(/[^a-z0-9]+/)
        for (const term of forbidden) {
          expect(
            tokens.includes(term) || normalized.includes(term),
            `${name} matches ${term}`
          ).toBe(false)
        }
      }
    })
    const removal = INTENT_KINDS.filter((kind) =>
      /delete|trash|remove|erase|destroy/.test(kind)
    )
    // calendar.delete cancels an invitation (METHOD:CANCEL); it removes no data.
    expect([...removal].sort()).toEqual([
      "calendar.delete",
      "email.trash",
      "file.delete",
    ])
  })
})

describe("codegen", () => {
  function run(dir: string, out: string): void {
    execFileSync(process.execPath, [codegen, "--schemas", dir, "--out", out], {
      stdio: "pipe",
    })
  }

  function fixture(): { dir: string; out: string } {
    const root = mkdtempSync(join(tmpdir(), "eido-codegen-"))
    const dir = join(root, "schemas")
    cpSync(schemaDir, dir, { recursive: true })
    return { dir, out: join(root, "out") }
  }

  test("a schema field change changes both the prompt text and the grammar schema", () => {
    const { dir, out } = fixture()
    const file = join(dir, "intent-email-archive.schema.json")
    writeFileSync(
      file,
      readFileSync(file, "utf8").replaceAll("messageIds", "mailIds")
    )
    run(dir, out)
    const prompt = readFileSync(join(out, "prompt.ts"), "utf8")
    expect(prompt).toContain("mailIds (array of string")
    expect(prompt).toContain('"mailIds"')
    expect(INTENT_PROMPT_TEXT).not.toContain("mailIds")
    expect(JSON.stringify(INTENT_RESULT_JSON_SCHEMA)).not.toContain("mailIds")
  })

  test("the committed output matches a fresh run", () => {
    const { dir, out } = fixture()
    run(dir, out)
    for (const name of ["types.ts", "prompt.ts", "validators.ts"]) {
      expect(readFileSync(join(out, name), "utf8")).toBe(
        readFileSync(join(pkgRoot, "src", "generated", name), "utf8")
      )
    }
  })

  test.each([
    ["keyword", { type: "integer", multipleOf: 2 }, "not supported"],
    ["format", { type: "string", maxLength: 5, format: "email" }, "format"],
    [
      "open object",
      { type: "object", properties: {}, additionalProperties: true },
      "additionalProperties",
    ],
  ])("fails on an unsupported %s", (_label, field, message) => {
    const { dir, out } = fixture()
    const file = join(dir, "intent-email-archive.schema.json")
    const schema = JSON.parse(readFileSync(file, "utf8")) as {
      properties: { args: { properties: Record<string, unknown> } }
    }
    schema.properties.args.properties["bad"] = field
    writeFileSync(file, JSON.stringify(schema))
    expect(() => run(dir, out)).toThrow(message)
  })

  test("fails on an unknown $ref", () => {
    const { dir, out } = fixture()
    const file = join(dir, "intent.schema.json")
    writeFileSync(
      file,
      JSON.stringify({
        title: "Intent",
        oneOf: [{ $ref: "missing.schema.json" }],
      })
    )
    expect(() => run(dir, out)).toThrow("unknown $ref")
  })
})

describe("validate keywords no verb uses today", () => {
  test("pattern rejects a non-matching string and names the path", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { id: { type: "string", pattern: "^[0-9a-f]{4}$" } },
    }
    expect(validate(schema, { id: "beef" })).toEqual([])
    expect(validate(schema, { id: "beeg" })).toEqual([
      "$.id: does not match pattern ^[0-9a-f]{4}$",
    ])
    expect(validate(schema, { id: "beef0" })).toEqual([
      "$.id: does not match pattern ^[0-9a-f]{4}$",
    ])
  })

  test("numbers, integers and bounds", () => {
    const bounded: JsonSchema = { type: "integer", minimum: 1, maximum: 3 }
    expect(validate(bounded, 2)).toEqual([])
    expect(validate(bounded, 0)).toEqual(["$: must be at least 1"])
    expect(validate(bounded, 4)).toEqual(["$: must be at most 3"])
    expect(validate(bounded, 1.5)).toEqual(["$: expected integer, got number"])
    expect(validate({ type: "number" }, 1.5)).toEqual([])
    expect(validate({ type: "number" }, Infinity)).toEqual([
      "$: expected number, got number",
    ])
    expect(validate({ type: "null" }, null)).toEqual([])
    expect(validate({ type: "string" }, null)).toEqual([
      "$: expected string, got null",
    ])
  })

  test("oneOf rejects a value that matches more than one variant", () => {
    const both: JsonSchema = {
      oneOf: [{ type: "string" }, { type: "string", maxLength: 5 }],
    }
    expect(validate(both, "abc")).toEqual(["$: matches more than one variant"])
    expect(validate(both, "abcdefgh")).toEqual([])
    expect(validate(both, 1)).toEqual(["$: expected string, got number"])
  })
})
