// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  checkDraft,
  clearDraft,
  draftFromSigned,
  emptyFolder,
  readDraft,
  reviewsEditedList,
  saveDraft,
} from "@/lib/file-roots-draft"
import {
  draftRows,
  firstFolderRequest,
  signedRoots,
} from "./fixtures/file-roots"

afterEach(() => {
  clearDraft()
  vi.unstubAllGlobals()
})

const many = (count: number) =>
  draftRows(
    Array.from(
      { length: count },
      (_, index) =>
        [
          `folder-${index}`,
          `/Users/owner.example/F${index}`,
          ".eido-trash",
        ] as const
    )
  )

describe("checkDraft", () => {
  test("a valid list becomes the request the gate takes, in order", () => {
    const check = checkDraft(
      draftRows([
        ["rental", "/Users/owner.example/Rental", ".eido-trash"],
        ["tax-2026", "/Users/owner.example/Tax", "_trash"],
      ])
    )
    expect(check).toEqual({
      ok: true,
      request: {
        roots: [
          {
            id: "rental",
            path: "/Users/owner.example/Rental",
            trashDir: ".eido-trash",
          },
          {
            id: "tax-2026",
            path: "/Users/owner.example/Tax",
            trashDir: "_trash",
          },
        ],
      },
    })
  })

  test("32 folders pass and the 33rd is too many", () => {
    expect(checkDraft(many(32)).ok).toBe(true)
    const check = checkDraft(many(33))
    expect(check.ok ? [] : check.problems).toEqual(["tooMany"])
  })

  test("an id with capitals or none at all is a bad id on that row only", () => {
    const check = checkDraft(
      draftRows([
        ["Studio", "/Users/owner.example/Studio", ".eido-trash"],
        ["", "/Users/owner.example/Notes", ".eido-trash"],
        ["notes", "/Users/owner.example/Notes2", ".eido-trash"],
      ])
    )
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems).toEqual(["badId"])
    expect([...check.invalid].sort()).toEqual(["row-0.id", "row-1.id"])
  })

  test("an id starting with a dash is a bad id", () => {
    const check = checkDraft(
      draftRows([["-notes", "/Users/owner.example/Notes", ".eido-trash"]])
    )
    expect(check.ok ? [] : check.problems).toEqual(["badId"])
  })

  test("two folders with one id both get marked", () => {
    const check = checkDraft(
      draftRows([
        ["notes", "/Users/owner.example/Notes", ".eido-trash"],
        ["studio", "/Users/owner.example/Studio", ".eido-trash"],
        ["notes", "/Users/owner.example/Notes2", ".eido-trash"],
      ])
    )
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems).toEqual(["duplicateId"])
    expect([...check.invalid].sort()).toEqual(["row-0.id", "row-2.id"])
  })

  test("a folder with no path, and a trash name ending in a dot, are named", () => {
    const check = checkDraft(
      draftRows([
        ["notes", "", ".eido-trash"],
        ["studio", "/Users/owner.example/Studio", "trash."],
      ])
    )
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems).toEqual(["noPath", "badTrash"])
    expect([...check.invalid].sort()).toEqual(["row-0.path", "row-1.trashDir"])
  })

  test("problems come in a fixed order whatever the row order", () => {
    const check = checkDraft(
      draftRows([
        ["notes", "/Users/owner.example/Notes", ""],
        ["notes", "", ".eido-trash"],
        ["Bad", "/Users/owner.example/Bad", ".eido-trash"],
      ])
    )
    expect(check.ok ? [] : check.problems).toEqual([
      "badId",
      "duplicateId",
      "noPath",
      "badTrash",
    ])
  })
})

describe("starting points", () => {
  test("a new folder is blank with the default trash name", () => {
    const folder = emptyFolder()
    expect([folder.id, folder.path, folder.trashDir]).toEqual([
      "",
      "",
      ".eido-trash",
    ])
    expect(emptyFolder().key).not.toBe(folder.key)
  })

  test("the signed list fills the editor with each folder's id, path and trash name", () => {
    expect(
      draftFromSigned(signedRoots).map(({ id, path, trashDir }) => [
        id,
        path,
        trashDir,
      ])
    ).toEqual([
      ["notes", "/Users/owner.example/Notes", ".eido-trash"],
      ["studio", "/Users/owner.example/Studio", ".eido-trash"],
    ])
  })
})

describe("the kept list", () => {
  test("a saved list reads back until cleared", () => {
    saveDraft(firstFolderRequest)
    expect(readDraft()).toEqual(firstFolderRequest)
    clearDraft()
    expect(readDraft()).toBeUndefined()
  })

  test("a stored list the schema rejects is not read back", () => {
    window.sessionStorage.setItem(
      "eido.fileRoots.draft",
      JSON.stringify({ roots: [{ id: "Bad", path: "/x", trashDir: "t" }] })
    )
    expect(readDraft()).toBeUndefined()
  })

  test("blocked storage still carries the list through this page", () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError")
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError")
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError")
      },
    }
    vi.stubGlobal("sessionStorage", blocked)
    saveDraft(firstFolderRequest)
    expect(readDraft()).toEqual(firstFolderRequest)
    clearDraft()
    expect(readDraft()).toBeUndefined()
  })
})

test("only ?list=edited reviews the edited list", () => {
  expect(reviewsEditedList("?list=edited")).toBe(true)
  expect(reviewsEditedList("")).toBe(false)
  expect(reviewsEditedList("?list=signed")).toBe(false)
})
