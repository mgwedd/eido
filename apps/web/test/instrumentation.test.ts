import { describe, expect, it } from "vitest"

import { assertAuth0BuildMatchesRuntime } from "@/instrumentation"

describe("assertAuth0BuildMatchesRuntime", () => {
  it.each([
    ["true", "tenant.example.invalid"],
    ["false", undefined],
    [undefined, undefined],
    ["false", ""],
  ])("accepts build %s with domain %s", (built, domain) => {
    expect(() => assertAuth0BuildMatchesRuntime(built, domain)).not.toThrow()
  })

  it("refuses a build without Auth0 run with AUTH0_DOMAIN set", () => {
    expect(() =>
      assertAuth0BuildMatchesRuntime("false", "tenant.example.invalid")
    ).toThrow(/disabled in this build but AUTH0_DOMAIN is set/)
  })

  it("refuses a build with Auth0 run without AUTH0_DOMAIN", () => {
    expect(() => assertAuth0BuildMatchesRuntime("true", undefined)).toThrow(
      /enabled in this build but AUTH0_DOMAIN is unset/
    )
  })
})
