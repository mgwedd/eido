import { describe, expect, it } from "vitest"
import { validateGateOwnerConfiguration } from "./index"

describe("the shared owner configuration contract", () => {
  it("accepts the canonical shape used by gate and core", () => {
    expect(
      validateGateOwnerConfiguration({
        version: 1,
        ownerAddresses: ["owner@example.invalid"],
        allowedRoots: ["documents"],
      })
    ).toEqual({
      ok: true,
      value: {
        version: 1,
        ownerAddresses: ["owner@example.invalid"],
        allowedRoots: ["documents"],
      },
    })
  })

  it("rejects unknown fields and invalid folder IDs", () => {
    expect(
      validateGateOwnerConfiguration({
        version: 1,
        ownerAddresses: [],
        allowedRoots: [""],
        extra: true,
      }).ok
    ).toBe(false)
  })
})
