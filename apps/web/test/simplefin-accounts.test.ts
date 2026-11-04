import { afterEach, describe, expect, test, vi } from "vitest"
import { balanceLine, loadSimpleFinAccounts } from "../lib/simplefin-accounts"
import { checking } from "./fixtures/simplefin-accounts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("balanceLine", () => {
  test("shows only the currency when SimpleFIN sent no usable balance", () => {
    expect(balanceLine({ ...checking, balanceCents: null })).toBe("USD")
  })

  test("a zero balance carries no sign", () => {
    expect(balanceLine({ ...checking, balanceCents: 0 })).toBe("USD · $0.00")
  })
})

describe("loadSimpleFinAccounts", () => {
  test("an aborted read is not mistaken for being offline", async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        controller.abort()
        return Promise.reject(new TypeError("aborted"))
      })
    )
    expect(await loadSimpleFinAccounts(controller.signal)).toEqual({
      status: "error",
    })
  })
})
