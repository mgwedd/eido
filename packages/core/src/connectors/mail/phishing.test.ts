import { describe, expect, test } from "vitest"
import { raw } from "../proton/memory-source.test-support"
import { computeMailSignals } from "./phishing"
import type { SignalInput } from "./phishing"
import { parseMessage } from "./parse"

const base: SignalInput = {
  from: [{ name: "Ada Example", address: "ada@example.com" }],
  replyTo: [],
  authenticationResults: [],
}
const kinds = (input: SignalInput, options = {}): string[] =>
  computeMailSignals(input, options).map((s) => s.kind)
const trustedMx = { trustedAuthservIds: ["mx.example.com"] }
const known = (...domains: string[]) => ({ knownDomains: new Set(domains) })

describe("a clean message", () => {
  test("raises nothing", () => {
    expect(
      computeMailSignals(
        {
          ...base,
          replyTo: [{ address: "desk@mail.example.com" }],
          authenticationResults: [
            "mx.example.com; spf=pass; dkim=pass; dmarc=pass",
          ],
          html: '<a href="https://www.example.com/a">example.com</a> <a href="https://example.com/x">Open the file</a>',
        },
        { ...trustedMx, ...known("example.com", "other-company.example") }
      )
    ).toEqual([])
  })
})

describe("sender authentication", () => {
  test("a failing verdict in the trusted header is flagged, one signal per failing method", () => {
    expect(
      computeMailSignals(
        {
          ...base,
          authenticationResults: [
            "mx.example.com; spf=fail; dkim=fail; dmarc=fail",
          ],
        },
        trustedMx
      )
    ).toEqual([
      { kind: "spf_fail", detail: "fail" },
      { kind: "dkim_fail", detail: "fail" },
      { kind: "dmarc_fail", detail: "fail" },
    ])
  })

  test("the same failure in a second, untrusted header is ignored", () => {
    expect(
      kinds(
        {
          ...base,
          authenticationResults: [
            "mx.example.com; dmarc=pass",
            "relay.example.invalid; dmarc=fail",
          ],
        },
        trustedMx
      )
    ).toEqual([])
  })

  test("a failure in a header from an untrusted host on top is ignored", () => {
    expect(
      kinds(
        {
          ...base,
          authenticationResults: ["relay.example.invalid; dmarc=fail"],
        },
        trustedMx
      )
    ).toEqual([])
  })

  test("softfail and temperror are not failures", () => {
    expect(
      kinds(
        {
          ...base,
          authenticationResults: [
            "mx.example.com; spf=softfail; dkim=temperror; dmarc=none",
          ],
        },
        trustedMx
      )
    ).toEqual([])
  })

  test("headers are read in message order from the raw bytes, the topmost first", async () => {
    const parsed = await parseMessage(
      raw([
        "Authentication-Results: mail.protonmail.ch; dmarc=fail",
        "Received: from relay.example.invalid by mx.example.com",
        "Authentication-Results: relay.example.invalid; dmarc=pass",
        "From: Ada Example <ada@example.com>",
        "Subject: s",
        "",
        "hi",
      ])
    )
    expect(kinds(parsed)).toEqual(["dmarc_fail"])
    const reversed = await parseMessage(
      raw([
        "Authentication-Results: relay.example.invalid; dmarc=pass",
        "Authentication-Results: mail.protonmail.ch; dmarc=fail",
        "From: Ada Example <ada@example.com>",
        "Subject: s",
        "",
        "hi",
      ])
    )
    expect(kinds(reversed)).toEqual([])
  })
})

describe("display name and Reply-To", () => {
  test("a display name holding a different address is flagged", () => {
    expect(
      computeMailSignals({
        ...base,
        from: [{ name: "ceo@example.org", address: "ada@example.invalid" }],
      })
    ).toEqual([{ kind: "display_name_address", detail: "ceo@example.org" }])
  })

  test("a display name holding the sender's own address, in any case, is clean", () => {
    expect(
      kinds({
        ...base,
        from: [{ name: "Ada@Example.com", address: "ada@example.com" }],
      })
    ).toEqual([])
  })

  test("a Reply-To on another domain is flagged", () => {
    expect(
      computeMailSignals({
        ...base,
        replyTo: [{ address: "ada@example.invalid" }],
      })
    ).toEqual([{ kind: "reply_to_domain", detail: "example.invalid" }])
  })

  test("a Reply-To on a lookalike suffix is not the same site", () => {
    expect(
      kinds({ ...base, replyTo: [{ address: "ada@badexample.com" }] })
    ).toEqual(["reply_to_domain"])
  })
})

describe("sender domain", () => {
  const from = (address: string): SignalInput => ({
    ...base,
    from: [{ address }],
  })

  test("a punycode domain is flagged, and a single-script one is not also mixed", () => {
    expect(kinds(from("ada@xn--e1afmkfd.example.com"))).toEqual([
      "punycode_domain",
    ])
  })

  test("a label mixing Cyrillic and Latin is punycode and mixed script", () => {
    expect(kinds(from("ada@xn--pple-43d.example.com"))).toEqual([
      "punycode_domain",
      "mixed_script_domain",
    ])
  })

  test("a domain written in Unicode that mixes scripts is flagged as mixed", () => {
    expect(kinds(from("ada@аpple.example.com"))).toContain(
      "mixed_script_domain"
    )
  })

  test("Japanese kana and kanji in one label are one script", () => {
    expect(kinds(from("ada@xn--v8jxj3d1dzdz08w.example.com"))).toEqual([
      "punycode_domain",
    ])
  })

  test.each([
    ["exarnple-bank.com", "rn read as m"],
    ["examp1e-bank.com", "digit one read as l"],
    ["example-bnak.com", "two letters swapped"],
    ["example-banks.com", "one letter added"],
    ["example-bak.com", "one letter dropped"],
  ])("%s (%s) is a lookalike of a known domain", (domain) => {
    expect(
      computeMailSignals(from(`ada@${domain}`), known("example-bank.com"))
    ).toEqual([
      { kind: "lookalike_domain", detail: `${domain} ~ example-bank.com` },
    ])
  })

  test("the known domain itself, an unrelated one and two-edit neighbours are clean", () => {
    const options = known("example-bank.com")
    expect(kinds(from("ada@example-bank.com"), options)).toEqual([])
    expect(kinds(from("ada@other-company.example"), options)).toEqual([])
    expect(kinds(from("ada@example-blank.com.au"), options)).toEqual([])
    expect(kinds(from("ada@exampel-bnak.com"), options)).toEqual([])
  })

  test("a short known domain is never matched, so one letter apart says nothing", () => {
    expect(kinds(from("ada@ab.io"), known("ac.io"))).toEqual([])
  })

  test("an internationalised lookalike of a known domain is flagged against its Unicode form", () => {
    expect(
      kinds(from("ada@xn--xample-bank-nkj.com"), known("example-bank.com"))
    ).toContain("lookalike_domain")
  })
})

describe("links", () => {
  const html = (a: string): SignalInput => ({ ...base, html: a })

  test("link text naming one domain over an href to another is flagged with both domains", () => {
    expect(
      computeMailSignals(
        html(
          '<a href="https://login.example.invalid/x">https://www.example.com/account</a>'
        )
      )
    ).toEqual([
      { kind: "link_mismatch", detail: "example.com -> login.example.invalid" },
    ])
  })

  test("text that merely begins with the real domain is still a mismatch", () => {
    expect(
      kinds(
        html('<a href="https://example.com.example.invalid/">example.com</a>')
      )
    ).toEqual(["link_mismatch"])
  })

  test("text spread over nested tags and an invisible character is read as shown", () => {
    expect(
      kinds(html('<a href="https://example.invalid/"><b>exam​ple</b>.com</a>'))
    ).toEqual(["link_mismatch"])
  })

  test("same site, a subdomain either way, and www are not mismatches", () => {
    expect(
      kinds(
        html(
          '<a href="https://click.example.com/t?x=1">example.com</a><a href="https://example.com">www.example.com/pricing</a><a href="http://EXAMPLE.com.">example.com</a>'
        )
      )
    ).toEqual([])
  })

  test("text that is not a URL or domain, and hrefs that are not http, are ignored", () => {
    expect(
      kinds(
        html(
          '<a href="https://example.invalid/">Open the file</a><a href="mailto:ada@example.invalid">ada@example.com</a><a href="/relative">example.com</a><a href="not a url">example.com</a><a>example.com</a>'
        )
      )
    ).toEqual([])
  })

  test("repeats are one signal and at most five are kept", () => {
    const one = '<a href="https://example.invalid/">example.com</a>'
    expect(kinds(html(one + one))).toEqual(["link_mismatch"])
    const many = Array.from(
      { length: 8 },
      (_, i) =>
        `<a href="https://x${i}.example.invalid/">site${i}.example.com</a>`
    ).join("")
    expect(kinds(html(many))).toHaveLength(5)
  })

  test("the HTML part of a parsed message is checked", async () => {
    const parsed = await parseMessage(
      raw([
        "From: Ada Example <ada@example.com>",
        "Subject: s",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p><a href="https://example.invalid/pay">example.com/pay</a></p>',
      ])
    )
    expect(kinds(parsed)).toEqual(["link_mismatch"])
  })
})

test("a message with no From raises only the checks that do not need one", () => {
  expect(
    kinds(
      {
        from: [],
        replyTo: [{ address: "x@example.invalid" }],
        authenticationResults: ["mx.example.com; dmarc=fail"],
      },
      trustedMx
    )
  ).toEqual(["dmarc_fail"])
})
