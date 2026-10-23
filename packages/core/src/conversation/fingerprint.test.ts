import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  deriveDigestFingerprint,
  fingerprintConversation,
  fingerprintTurns,
} from "./fingerprint"
import { rawTurn } from "./conversation.test-support"

describe("deriveDigestFingerprint", () => {
  it("is sha256(parent, NUL, text) and differs when either input differs", () => {
    const expected = createHash("sha256").update("parent\0text").digest("hex")
    expect(deriveDigestFingerprint("parent", "text")).toBe(expected)
    expect(deriveDigestFingerprint("parent", "text")).not.toBe(
      deriveDigestFingerprint("parent2", "text")
    )
    expect(deriveDigestFingerprint("parent", "text")).not.toBe(
      deriveDigestFingerprint("parent", "text2")
    )
  })
})

describe("fingerprintConversation", () => {
  const a = { id: "t1", textSha256: "aa" }
  const b = { id: "t2", textSha256: "bb" }

  it("depends on the order, the ids and the text hashes", () => {
    const base = fingerprintConversation([a, b])
    expect(fingerprintConversation([b, a])).not.toBe(base)
    expect(fingerprintConversation([a, { ...b, id: "t3" }])).not.toBe(base)
    expect(fingerprintConversation([a, { ...b, textSha256: "cc" }])).not.toBe(
      base
    )
    expect(fingerprintConversation([a])).not.toBe(base)
  })

  it("is the same for the same turns", () => {
    expect(fingerprintConversation([a, b])).toBe(
      fingerprintConversation([a, b])
    )
  })
})

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
