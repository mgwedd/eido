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
    expect(simplefinPlaneConfig({}, "/d")).toBeUndefined()
    expect(
      simplefinPlaneConfig({ EIDO_SIMPLEFIN_PROXY_URL: "" }, "/d")
    ).toBeUndefined()
  })

  it("reads a loopback proxy, the accounts file and the date range", () => {
    expect(
      simplefinPlaneConfig(
        { EIDO_SIMPLEFIN_PROXY_URL: "http://127.0.0.1:7801/" },
        "/d"
      )
    ).toEqual({
      proxyUrl: "http://127.0.0.1:7801",
      accountsFile: "/d/simplefin-accounts.json",
      config: {},
    })
    expect(
      simplefinPlaneConfig(
        {
          EIDO_SIMPLEFIN_PROXY_URL: "http://127.0.0.1:7801",
          EIDO_SIMPLEFIN_ACCOUNTS_FILE: "/etc/eido/accounts.json",
          EIDO_SIMPLEFIN_MAX_RANGE_DAYS: "30",
        },
        "/d"
      )
    ).toEqual({
      proxyUrl: "http://127.0.0.1:7801",
      accountsFile: "/etc/eido/accounts.json",
      config: { maxDateRangeDays: 30 },
    })
  })

  it("reads the local sync time", () => {
    const proxy = "http://127.0.0.1:7801"
    expect(
      simplefinPlaneConfig(
        { EIDO_SIMPLEFIN_PROXY_URL: proxy, EIDO_SIMPLEFIN_SYNC_TIME: "06:30" },
        "/d"
      )?.syncTime
    ).toEqual({ hour: 6, minute: 30 })
    expect(
      simplefinPlaneConfig({ EIDO_SIMPLEFIN_PROXY_URL: proxy }, "/d")
    ).not.toHaveProperty("syncTime")
    for (const bad of ["25:00", "6.30", "noon"]) {
      expect(() =>
        simplefinPlaneConfig(
          { EIDO_SIMPLEFIN_PROXY_URL: proxy, EIDO_SIMPLEFIN_SYNC_TIME: bad },
          "/d"
        )
      ).toThrow("EIDO_SIMPLEFIN_SYNC_TIME must be a 24-hour time, HH:MM")
    }
  })

  it("refuses a remote proxy and a bad range", () => {
    expect(() =>
      simplefinPlaneConfig(
        { EIDO_SIMPLEFIN_PROXY_URL: "https://proxy.example.invalid" },
        "/d"
      )
    ).toThrow("EIDO_SIMPLEFIN_PROXY_URL must be a loopback HTTP URL")
    for (const range of ["0", "1.5", "-3", "3651"]) {
      expect(() =>
        simplefinPlaneConfig(
          {
            EIDO_SIMPLEFIN_PROXY_URL: "http://127.0.0.1:7801",
            EIDO_SIMPLEFIN_MAX_RANGE_DAYS: range,
          },
          "/d"
        )
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
