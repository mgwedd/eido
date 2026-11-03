import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parseAccountAssignments, readAccountAssignments } from "./assignments"

const INVALID =
  "the SimpleFIN accounts file must be a JSON object of account id to entity id"
const dir = mkdtempSync(join(tmpdir(), "eido-assignments-"))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("SimpleFIN account assignments", () => {
  it("parses an object of account id to entity id", () => {
    expect(
      parseAccountAssignments('{"acc_1":"ent_a","acc_2":"ent_b"}')
    ).toEqual({
      acc_1: "ent_a",
      acc_2: "ent_b",
    })
  })

  it.each([
    "not json",
    "[]",
    "null",
    '"x"',
    '{"acc_1":""}',
    '{"acc_1":3}',
    '{"":"ent_a"}',
  ])("refuses %s", (text) => {
    expect(() => parseAccountAssignments(text)).toThrow(INVALID)
  })

  it("reads the file, treats a missing one as no assignments, and refuses an unreadable one", () => {
    const path = join(dir, "accounts.json")
    writeFileSync(path, '{"acc_1":"ent_a"}')
    expect(readAccountAssignments(path)).toEqual({ acc_1: "ent_a" })
    expect(readAccountAssignments(undefined)).toEqual({})
    expect(readAccountAssignments(join(dir, "missing.json"))).toEqual({})
    expect(() => readAccountAssignments(dir)).toThrow(
      "the SimpleFIN accounts file could not be read"
    )
  })
})
