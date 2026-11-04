import { describe, expect, it } from "vitest"
import {
  resolveSimpleFinConfig,
  simplefinManifestConfig,
  simplefinPlaneConfig,
} from "./config"

describe("SimpleFIN configuration", () => {
  it("defaults to the verified limits and refuses values out of range", () => {
    expect(resolveSimpleFinConfig()).toEqual({
      dailyRequestLimit: 24,
      maxDateRangeDays: 90,
      requestTimeoutMs: 30_000,
    })
    expect(() => resolveSimpleFinConfig({ maxDateRangeDays: 3651 })).toThrow(
      "maxDateRangeDays must be an integer from 1 to 3650"
    )
    expect(() => resolveSimpleFinConfig({ requestTimeoutMs: 1.5 })).toThrow(
      "requestTimeoutMs must be an integer from 1 to 600000"
    )
  })
})

describe("simplefinPlaneConfig", () => {
  it("is off without a proxy URL", () => {
    expect(simplefinPlaneConfig({})).toBeUndefined()
    expect(
      simplefinPlaneConfig({ EIDO_SIMPLEFIN_PROXY_URL: "" })
    ).toBeUndefined()
  })

  it("reads a loopback proxy and the date range", () => {
    expect(
      simplefinPlaneConfig({
        EIDO_SIMPLEFIN_PROXY_URL: "http://127.0.0.1:7801/",
      })
    ).toEqual({
      proxyUrl: "http://127.0.0.1:7801",
      config: {},
    })
    expect(
      simplefinPlaneConfig({
        EIDO_SIMPLEFIN_PROXY_URL: "http://127.0.0.1:7801",
        EIDO_SIMPLEFIN_MAX_RANGE_DAYS: "30",
      })
    ).toEqual({
      proxyUrl: "http://127.0.0.1:7801",
      config: { maxDateRangeDays: 30 },
    })
  })

  it("reads the local sync time", () => {
    const proxy = "http://127.0.0.1:7801"
    expect(
      simplefinPlaneConfig({
        EIDO_SIMPLEFIN_PROXY_URL: proxy,
        EIDO_SIMPLEFIN_SYNC_TIME: "06:30",
      })?.syncTime
    ).toEqual({ hour: 6, minute: 30 })
    expect(
      simplefinPlaneConfig({ EIDO_SIMPLEFIN_PROXY_URL: proxy })
    ).not.toHaveProperty("syncTime")
    for (const bad of ["25:00", "6.30", "noon"]) {
      expect(() =>
        simplefinPlaneConfig({
          EIDO_SIMPLEFIN_PROXY_URL: proxy,
          EIDO_SIMPLEFIN_SYNC_TIME: bad,
        })
      ).toThrow("EIDO_SIMPLEFIN_SYNC_TIME must be a 24-hour time, HH:MM")
    }
  })

  it("refuses a remote proxy and a bad range", () => {
    expect(() =>
      simplefinPlaneConfig({
        EIDO_SIMPLEFIN_PROXY_URL: "https://proxy.example.invalid",
      })
    ).toThrow("EIDO_SIMPLEFIN_PROXY_URL must be a loopback HTTP URL")
    for (const range of ["0", "1.5", "-3", "3651"]) {
      expect(() =>
        simplefinPlaneConfig({
          EIDO_SIMPLEFIN_PROXY_URL: "http://127.0.0.1:7801",
          EIDO_SIMPLEFIN_MAX_RANGE_DAYS: range,
        })
      ).toThrow(
        "EIDO_SIMPLEFIN_MAX_RANGE_DAYS must be an integer from 1 to 3650"
      )
    }
  })
})

describe("simplefinManifestConfig", () => {
  it("reads the daily request budget, or refuses it", () => {
    expect(simplefinManifestConfig({})).toEqual({})
    expect(
      simplefinManifestConfig({ EIDO_SIMPLEFIN_REQUESTS_PER_DAY: "6" })
    ).toEqual({
      dailyRequestLimit: 6,
    })
    expect(
      simplefinManifestConfig({ EIDO_SIMPLEFIN_REQUESTS_PER_DAY: "x" })
    ).toBe(
      "EIDO_SIMPLEFIN_REQUESTS_PER_DAY must be an integer from 1 to 100000"
    )
  })
})
