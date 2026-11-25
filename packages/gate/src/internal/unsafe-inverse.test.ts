import { describe, expect, it } from "vitest"
import type { Intent } from "@eido/schemas"
import { isUnsafeInverse } from "./executor"
import { sample } from "./test-fixtures"

// The one rule the executor refuses by and Activity hides Undo by (#851). Every expectation is
// written out by hand from the rule: no send, forward, reply, trash or delete inverse, no calendar
// inverse, and a file trash only for the file the create made.

const ROOT = {
  path: "/synthetic/docs",
  dev: "1",
  ino: "2",
  trashDir: ".eido-trash",
}
const TRASH_NAME = "0b6c51c6-3f3e-4b7e-9d1a-5f0c2b7a8e41"
const CREATE: Intent = {
  kind: "file.create",
  args: { root: "docs", path: "new.txt", content: "x" },
}
const RENAME: Intent = {
  kind: "file.rename",
  args: { root: "docs", path: "a.txt", newName: "b.txt" },
}
const trash = (path: string, trashName = TRASH_NAME) => ({
  op: "trash",
  root: ROOT,
  path,
  trashName,
})

describe("isUnsafeInverse", () => {
  it.each([
    "email.send",
    "email.forward",
    "email.reply",
    "email.trash",
    "file.delete",
    "calendar.create",
    "calendar.edit",
    "calendar.delete",
  ] as const)("refuses a stored %s inverse", (kind) => {
    expect(isUnsafeInverse(sample("email.archive"), sample(kind))).toBe(true)
  })

  it.each(["email.label", "email.untrash", "file.move"] as const)(
    "accepts a stored %s inverse",
    (kind) => {
      expect(isUnsafeInverse(sample("email.archive"), sample(kind))).toBe(false)
    }
  )

  it("accepts the trash of the file the create made", () => {
    expect(isUnsafeInverse(CREATE, trash("new.txt"))).toBe(false)
  })

  it("refuses a trash of another path, a bad trash name, or after another action", () => {
    expect(isUnsafeInverse(CREATE, trash("other.txt"))).toBe(true)
    expect(isUnsafeInverse(CREATE, trash("new.txt", "../escape"))).toBe(true)
    expect(isUnsafeInverse(RENAME, trash("a.txt"))).toBe(true)
  })

  it("accepts a restore, which removes nothing", () => {
    expect(
      isUnsafeInverse(sample("file.delete"), {
        op: "restore",
        root: ROOT,
        path: "a.txt",
        trashName: TRASH_NAME,
      })
    ).toBe(false)
  })

  it("leaves a stored inverse that is neither an intent nor a file request to invalid_inverse", () => {
    expect(isUnsafeInverse(CREATE, { kind: "money.transfer", args: {} })).toBe(
      false
    )
  })
})
