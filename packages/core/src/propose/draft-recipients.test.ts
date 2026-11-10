import { describe, expect, test } from "vitest"
import { draftBounds, parseAddress } from "./draft-recipients"

describe("parseAddress", () => {
  test.each([
    ["ada@example.invalid", "ada@example.invalid"],
    ["Ada Quill <Ada@Example.Invalid>", "ada@example.invalid"],
    [
      '"Boss <boss@corp.example>" <attacker@evil.example>',
      "attacker@evil.example",
    ],
    ['"Quill, \\"Ada\\"" <ada@example.invalid>', "ada@example.invalid"],
    ["ada@example.invalid (boss@corp.example)", "ada@example.invalid"],
    ["Ada (a (nested) comment) <ada@example.invalid>", "ada@example.invalid"],
  ])("%s", (raw, expected) => {
    expect(parseAddress(raw)).toBe(expected)
  })

  test.each([
    "",
    "no-at-sign",
    "a@b, c@d",
    "Ada <ada@example.invalid> trailing",
    "<a@b> <c@d>",
    "Ada <ada@example.invalid",
    '"unterminated <ada@example.invalid>',
    "ada@example.invalid (unterminated",
  ])("%j names no single address", (raw) => {
    expect(parseAddress(raw)).toBeNull()
  })
})

describe("draftBounds", () => {
  test("a seed that is not a referable message has no bounds", () => {
    const db = { prepare: () => ({ all: () => [] }) } as never
    expect(draftBounds(db, [], "a".repeat(64))).toBeUndefined()
  })
})
