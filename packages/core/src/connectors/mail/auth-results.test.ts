import { describe, expect, test } from "vitest"
import { parseAuthenticationResults, trustedAuthResults } from "./auth-results"

describe("parseAuthenticationResults", () => {
  test("reads the authserv-id and the spf, dkim and dmarc verdicts, lower-cased", () => {
    expect(
      parseAuthenticationResults(
        "MX.Example.com 1; SPF=Pass smtp.mailfrom=a@example.com; dkim=fail header.d=example.com; dmarc=fail action=reject; iprev=pass"
      )
    ).toEqual({
      authservId: "mx.example.com",
      results: { spf: "pass", dkim: "fail", dmarc: "fail" },
    })
  })

  test("a verdict written inside a comment or a quoted reason is not read", () => {
    expect(
      parseAuthenticationResults(
        'mx.example.com; spf=pass (dmarc=fail (nested; dkim=fail)) smtp.mailfrom=a@example.com; dkim=pass reason="x; dmarc=fail"'
      ).results
    ).toEqual({ spf: "pass", dkim: "pass" })
  })

  test("one verifying DKIM signature outweighs a failing one in either order", () => {
    const failFirst =
      "mx.example.com; dkim=fail header.i=@a; dkim=pass header.i=@b"
    const passFirst =
      "mx.example.com; dkim=pass header.i=@b; dkim=fail header.i=@a"
    expect(parseAuthenticationResults(failFirst).results.dkim).toBe("pass")
    expect(parseAuthenticationResults(passFirst).results.dkim).toBe("pass")
  })

  test("an empty value has no verdicts", () => {
    expect(parseAuthenticationResults("")).toEqual({
      authservId: "",
      results: {},
    })
  })
})

describe("trustedAuthResults", () => {
  const trusted = ["mx.example.com"]

  test("reads only the topmost header", () => {
    expect(
      trustedAuthResults(
        ["mx.example.com; dmarc=pass", "mx.example.com; dmarc=fail"],
        trusted
      )
    ).toEqual({ dmarc: "pass" })
  })

  test("a topmost header from a host that is not trusted gives nothing, even if a lower one is trusted", () => {
    expect(
      trustedAuthResults(
        ["evil.example.invalid; dmarc=pass", "mx.example.com; dmarc=fail"],
        trusted
      )
    ).toBeUndefined()
  })

  test("a trusted domain matches its subdomains but not a longer name that merely ends the same", () => {
    expect(
      trustedAuthResults(["in.mx.example.com; spf=fail"], trusted)
    ).toEqual({ spf: "fail" })
    expect(
      trustedAuthResults(["notmx.example.com; spf=fail"], trusted)
    ).toBeUndefined()
  })

  test("no header gives nothing", () => {
    expect(trustedAuthResults([], trusted)).toBeUndefined()
  })

  test("the default trusted hosts are Proton's", () => {
    expect(trustedAuthResults(["mail.protonmail.ch; dmarc=fail"])).toEqual({
      dmarc: "fail",
    })
    expect(trustedAuthResults(["mx.example.com; dmarc=fail"])).toBeUndefined()
  })
})
