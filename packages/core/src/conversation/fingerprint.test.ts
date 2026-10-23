import { describe, expect, it } from "vitest"
import { fingerprintTurns } from "./fingerprint"
import { rawTurn } from "./conversation.test-support"

describe("fingerprintTurns", () => {
  it("changes when one turn's text changes and ignores the timestamp", () => {
    const base = fingerprintTurns([rawTurn(1, "one"), rawTurn(2, "two")])
    expect(fingerprintTurns([rawTurn(1, "one"), rawTurn(2, "twp")])).not.toBe(
      base
    )
    expect(
      fingerprintTurns([
        rawTurn(1, "one"),
        rawTurn(2, "two", { at: "2030-01-01T00:00:00Z" }),
      ])
    ).toBe(base)
  })
})
