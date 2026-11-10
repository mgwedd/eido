import { describe, expect, it } from "vitest"
import { crossSiteRefused } from "./request-origin"

const base = {
  method: "POST",
  secFetchSite: null,
  origin: null,
  host: "127.0.0.1:8789",
  allowedHosts: new Set(["127.0.0.1:8789", "eido.tail.ts.net"]),
}

describe("crossSiteRefused", () => {
  it("refuses Sec-Fetch-Site cross-site", () => {
    expect(crossSiteRefused({ ...base, secFetchSite: "cross-site" })).toBe(true)
  })
  it("allows same-origin and same-site fetch metadata", () => {
    expect(crossSiteRefused({ ...base, secFetchSite: "same-origin" })).toBe(
      false
    )
  })
  it("refuses an Origin whose host is neither Host nor allowed", () => {
    expect(crossSiteRefused({ ...base, origin: "https://evil.example" })).toBe(
      true
    )
  })
  it("allows an Origin equal to the Host", () => {
    expect(crossSiteRefused({ ...base, origin: "http://127.0.0.1:8789" })).toBe(
      false
    )
  })
  it("allows an Origin in the allowed hosts list", () => {
    expect(
      crossSiteRefused({ ...base, origin: "https://eido.tail.ts.net" })
    ).toBe(false)
  })
  it("refuses an unparseable Origin", () => {
    expect(crossSiteRefused({ ...base, origin: "null" })).toBe(true)
  })
  it("passes requests with neither header", () => {
    expect(crossSiteRefused(base)).toBe(false)
  })
  it("does not check GET", () => {
    expect(
      crossSiteRefused({
        ...base,
        method: "GET",
        secFetchSite: "cross-site",
        origin: "https://evil.example",
      })
    ).toBe(false)
  })
  it("checks DELETE", () => {
    expect(
      crossSiteRefused({
        ...base,
        method: "DELETE",
        origin: "https://evil.example",
      })
    ).toBe(true)
  })
})
