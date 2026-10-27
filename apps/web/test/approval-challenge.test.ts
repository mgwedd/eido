import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildChallenge, shortHash, toBase64url } from "@/lib/approval/challenge"

type Vector = {
  id: string
  payloadHash: string
  intentId: string
  nonce: string
  challenge: string
  challengeHex: string
}

const vectors: { vectors: Vector[] } = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/schemas/vectors/approval-challenge-vectors.json",
      import.meta.url
    ),
    "utf8"
  )
)

describe("buildChallenge against the gate's shared vectors", () => {
  it.each(vectors.vectors)("matches $id", async (vector) => {
    const challenge = await buildChallenge(vector)
    expect(Buffer.from(challenge).toString("hex")).toBe(vector.challengeHex)
    expect(toBase64url(challenge)).toBe(vector.challenge)
  })

  it("changes when the nonce changes", async () => {
    const [first] = vectors.vectors
    if (first === undefined) throw new Error("no vectors")
    const other = await buildChallenge({ ...first, nonce: "m".repeat(43) })
    expect(Buffer.from(other).toString("hex")).not.toBe(first.challengeHex)
  })
})

describe("toBase64url", () => {
  it("is unpadded and uses the url alphabet", () => {
    expect(toBase64url(new Uint8Array([251, 255, 254, 1]))).toBe("-__-AQ")
  })
})

describe("shortHash", () => {
  it("groups the first eight hex characters 4+4", () => {
    expect(shortHash("14ac090f2cde0f0c5d9f73e700cca33b")).toBe("14ac 090f")
  })
})
