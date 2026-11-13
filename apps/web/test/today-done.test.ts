import { describe, expect, test } from "vitest"

import { selectDoneAutomatically } from "../lib/today-done"
import { entry } from "./fixtures/activity"

describe("selectDoneAutomatically", () => {
  test("keeps automatic rows that can be undone or were", () => {
    const available = entry(5, { displayActor: "auto", undo: "available" })
    const done = entry(4, { displayActor: "auto", undo: "done" })
    expect(selectDoneAutomatically([available, done])).toEqual([
      available,
      done,
    ])
  })

  test("leaves out automatic rows with no undo, such as access events", () => {
    const access = entry(5, { displayActor: "auto", undo: "none" })
    expect(selectDoneAutomatically([access])).toEqual([])
  })

  test("leaves out rows the owner or the gate did", () => {
    const yours = entry(5, { displayActor: "you", undo: "available" })
    const gate = entry(4, { displayActor: "gate", undo: "available" })
    expect(selectDoneAutomatically([yours, gate])).toEqual([])
  })

  test("shows the latest three, in the order the gate sent them", () => {
    const rows = [6, 5, 4, 3].map((seq) =>
      entry(seq, { displayActor: "auto", undo: "available" })
    )
    expect(selectDoneAutomatically(rows).map((row) => row.seq)).toEqual([
      6, 5, 4,
    ])
  })
})
