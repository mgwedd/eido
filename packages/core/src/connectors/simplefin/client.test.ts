import { describe, expect, it, vi } from "vitest"
import {
  createSimpleFinClient,
  parseAccountSet,
  scrubUrls,
  SimpleFinError,
} from "./client"

const PROXY = "http://127.0.0.1:4999/"

// Credentials in test URLs are built from parts, so no source line holds a credential-shaped URL.
const USERINFO = ["user", "pass"].join(":")

function clientAnswering(response: Response | Error) {
  const send = vi.fn<typeof fetch>(() =>
    response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  )
  return {
    send,
    client: createSimpleFinClient({ proxyUrl: PROXY, fetch: send }),
  }
}

async function failure(promise: Promise<unknown>): Promise<SimpleFinError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SimpleFinError) return error
    throw error
  }
  throw new Error("expected a SimpleFinError")
}

describe("SimpleFIN client", () => {
  it("asks the gate proxy for the accounts route, never holding a credential", async () => {
    const { send, client } = clientAnswering(Response.json({ accounts: [] }))
    expect(
      await client.getAccounts({
        startDate: 100,
        endDate: 200,
        balancesOnly: true,
      })
    ).toEqual({ accounts: [], errors: [] })
    const [url, init] = send.mock.calls[0] ?? []
    expect(url).toBe(PROXY)
    expect(init?.method).toBe("GET")
    const headers = new Headers(init?.headers)
    expect(Object.fromEntries(headers)).toEqual({
      "x-eido-connector": "simplefin",
      "x-eido-target":
        "https://bridge.simplefin.org/simplefin/accounts?start-date=100&end-date=200&balances-only=1",
    })
  })

  it("names each requested account as a repeated account parameter", async () => {
    const { send, client } = clientAnswering(Response.json({ accounts: [] }))
    await client.getAccounts({ startDate: 100, accounts: ["ACT-1", "ACT 2"] })
    const headers = new Headers(send.mock.calls[0]?.[1]?.headers)
    expect(headers.get("x-eido-target")).toBe(
      "https://bridge.simplefin.org/simplefin/accounts?start-date=100&account=ACT-1&account=ACT+2"
    )
  })

  it("sends no query when no window is given", async () => {
    const { send, client } = clientAnswering(Response.json({ accounts: [] }))
    await client.getAccounts()
    expect(
      new Headers(send.mock.calls[0]?.[1]?.headers).get("x-eido-target")
    ).toBe("https://bridge.simplefin.org/simplefin/accounts")
  })

  it.each([
    [
      429,
      { reason: "daily_limit" },
      "daily_limit",
      "the daily SimpleFIN request limit is spent",
    ],
    [
      502,
      { reason: "grant_revoked" },
      "unauthorized",
      "the SimpleFIN credential is not usable (grant_revoked); reconnect it",
    ],
    [
      423,
      { reason: "connector_disabled" },
      "unauthorized",
      "the SimpleFIN credential is not usable (connector_disabled); reconnect it",
    ],
    [
      424,
      { reason: "credential_missing" },
      "unauthorized",
      "the SimpleFIN credential is not usable (credential_missing); reconnect it",
    ],
    [
      424,
      { reason: "credential_invalid" },
      "unauthorized",
      "the SimpleFIN credential is not usable (credential_invalid); reconnect it",
    ],
    [
      429,
      { reason: "rate_limited" },
      "request_failed",
      "SimpleFIN read failed with status 429 (rate_limited)",
    ],
    [
      502,
      { reason: "upstream_5xx" },
      "request_failed",
      "SimpleFIN read failed with status 502 (upstream_5xx)",
    ],
    [
      500,
      "not json",
      "request_failed",
      "SimpleFIN read failed with status 500",
    ],
  ])("maps a %i %j refusal to %s", async (status, body, code, message) => {
    const { client } = clientAnswering(
      typeof body === "string"
        ? new Response(body, { status })
        : Response.json(body, { status })
    )
    const error = await failure(client.getAccounts())
    expect(error.code).toBe(code)
    expect(error.message).toBe(message)
  })

  it("reports an unreachable proxy and an invalid answer", async () => {
    const down = await failure(
      clientAnswering(new TypeError("fetch failed")).client.getAccounts()
    )
    expect([down.code, down.message]).toEqual([
      "network_error",
      "the gate egress proxy could not be reached",
    ])
    const garbled = await failure(
      clientAnswering(new Response("{nope")).client.getAccounts()
    )
    expect([garbled.code, garbled.message]).toEqual([
      "invalid_payload",
      "SimpleFIN answered with invalid JSON",
    ])
  })
})

describe("parseAccountSet", () => {
  it("refuses an answer without an accounts list or with an incomplete account", () => {
    for (const data of [null, [], { accounts: "x" }, { errors: [] }]) {
      expect(() => parseAccountSet(data)).toThrow(
        "SimpleFIN answered without an accounts list"
      )
    }
    for (const account of [
      "x",
      { id: "", name: "n", currency: "USD" },
      { id: "a", currency: "USD" },
      { id: "a", name: "n" },
    ]) {
      expect(() => parseAccountSet({ accounts: [account] })).toThrow(
        "SimpleFIN answered with an account missing its id, name or currency"
      )
    }
  })

  it("keeps usable transactions, counts the rest, and scrubs errors", () => {
    expect(
      parseAccountSet({
        errors: [
          `see https://${USERINFO}@bridge.simplefin.org/simplefin now`,
          3,
        ],
        accounts: [
          {
            id: "a1",
            name: "Lorem",
            currency: "USD",
            balance: "1.00",
            "balance-date": 1.5,
            transactions: [
              {
                id: "t1",
                posted: 10,
                amount: "1.00",
                description: "d",
                pending: true,
              },
              { id: "t2", posted: 11, amount: "2.00", description: "e" },
              { id: "", posted: 10, amount: "1.00", description: "d" },
              { id: "t3", posted: "10", amount: "1.00", description: "d" },
              { id: "t4", posted: -1, amount: "1.00", description: "d" },
              { id: "t5", posted: 10, amount: "1.00", description: 5 },
              "t6",
            ],
          },
          { id: "a2", name: "Ipsum", currency: "EUR", "balance-date": 20 },
        ],
      })
    ).toEqual({
      errors: ["see [url] now"],
      accounts: [
        {
          id: "a1",
          name: "Lorem",
          currency: "USD",
          balance: "1.00",
          balanceDate: undefined,
          rejected: 5,
          transactions: [
            {
              id: "t1",
              posted: 10,
              amount: "1.00",
              description: "d",
              pending: true,
              raw: {
                id: "t1",
                posted: 10,
                amount: "1.00",
                description: "d",
                pending: true,
              },
            },
            {
              id: "t2",
              posted: 11,
              amount: "2.00",
              description: "e",
              pending: false,
              raw: { id: "t2", posted: 11, amount: "2.00", description: "e" },
            },
          ],
        },
        {
          id: "a2",
          name: "Ipsum",
          currency: "EUR",
          balance: undefined,
          balanceDate: 20,
          rejected: 0,
          transactions: [],
        },
      ],
    })
  })
})

describe("scrubUrls", () => {
  it("removes any URL, including one carrying credentials", () => {
    expect(
      scrubUrls(
        `a https://${USERINFO}@bridge.simplefin.org/simplefin b HTTP://x.example.invalid c`
      )
    ).toBe("a [url] b [url] c")
    expect(
      scrubUrls("xhttps://h.example.invalid/p and http://h.example.invalid")
    ).toBe("[url] and [url]")
    expect(scrubUrls("1+a.b://h.example.invalid, ://x, a:// b, see:")).toBe(
      "1+[url] ://x, a:// b, see:"
    )
    expect(scrubUrls('"https://h.example.invalid"<x>')).toBe('"[url]"<x>')
  })

  it("runs in linear time, and a long letter run cannot hide a URL", () => {
    const run = "a".repeat(100_000)
    const started = performance.now()
    expect(scrubUrls(run)).toBe(run)
    expect(scrubUrls(`${run}:`.repeat(20))).toBe(`${run}:`.repeat(20))
    expect(performance.now() - started).toBeLessThan(500)
    expect(scrubUrls(`${run} https://h.example.invalid`)).toBe(`${run} [url]`)
    expect(scrubUrls(`${"a".repeat(40)}https://h.example.invalid/x y`)).toBe(
      "[url] y"
    )
    expect(
      new SimpleFinError(
        "request_failed",
        `at https://${USERINFO}@h.example.invalid`
      ).message
    ).toBe("at [url]")
  })
})
