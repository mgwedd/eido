import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  deriveDigestFingerprint,
  digestKey,
  fingerprintConversation,
  fingerprintDocument,
  fingerprintThread,
} from "./fingerprint"

const sha = (s: string): string => createHash("sha256").update(s).digest("hex")

describe("fingerprints", () => {
  const a = { id: "m1", bodySha256: sha("one") }
  const b = { id: "m2", bodySha256: sha("two") }

  it("a thread fingerprint changes with an added message, a changed body, or the order", () => {
    const base = fingerprintThread([a, b])
    expect(fingerprintThread([a, b])).toBe(base)
    expect(fingerprintThread([a])).not.toBe(base)
    expect(fingerprintThread([a, { ...b, bodySha256: sha("two!") }])).not.toBe(
      base
    )
    expect(fingerprintThread([b, a])).not.toBe(base)
  })

  it("does not confuse a thread with a conversation of the same entries", () => {
    expect(
      fingerprintConversation([{ id: "m1", textSha256: a.bodySha256 }])
    ).not.toBe(fingerprintThread([a]))
  })

  it("a conversation fingerprint follows the raw turn text", () => {
    const t = { id: "t1", textSha256: sha("hi") }
    expect(fingerprintConversation([t])).toBe(fingerprintConversation([t]))
    expect(
      fingerprintConversation([{ ...t, textSha256: sha("hi!") }])
    ).not.toBe(fingerprintConversation([t]))
  })

  it("a document fingerprint is its content hash", () => {
    expect(fingerprintDocument("abc123")).toBe("abc123")
  })

  it("derives sha256(parent NUL text), deterministic, and sensitive to both parts", () => {
    const derived = deriveDigestFingerprint("parent-fp", "digest text")
    expect(derived).toBe(sha("parent-fp\0digest text"))
    expect(deriveDigestFingerprint("parent-fp", "digest text")).toBe(derived)
    expect(deriveDigestFingerprint("other-fp", "digest text")).not.toBe(derived)
    expect(deriveDigestFingerprint("parent-fp", "digest text 2")).not.toBe(
      derived
    )
  })

  it("the key is sha256(prompt NUL model NUL fingerprint)", () => {
    expect(digestKey("p1", "m1", "fp")).toBe(sha("p1\0m1\0fp"))
    expect(digestKey("p2", "m1", "fp")).not.toBe(digestKey("p1", "m1", "fp"))
    expect(digestKey("p1", "m2", "fp")).not.toBe(digestKey("p1", "m1", "fp"))
  })
})
