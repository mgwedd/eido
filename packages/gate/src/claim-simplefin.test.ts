import { describe, expect, it, vi } from "vitest"
import {
  claimSimplefin,
  SIMPLEFIN_HOST,
  SIMPLEFIN_VAULT_KEY,
} from "./claim-simplefin"
import { InMemoryVault } from "./internal/vault/vault"

describe("claimSimplefin", () => {
  const ACCESS_URL = "https://user:password@bridge.simplefin.org/simplefin"
  const VALID_CLAIM_URL = `https://${SIMPLEFIN_HOST}/simplefin/claim/claim-token-12345`
  const FORGED_CLAIM_URL = "https://evil.org/simplefin/claim/claim-token-12345"

  const encodeToken = (url: string) => Buffer.from(url).toString("base64")

  it("refuses a claim URL whose host is not bridge.simplefin.org and stores nothing", async () => {
    const vault = new InMemoryVault()
    const out: string[] = []
    const err: string[] = []
    const fetchFn = vi.fn()

    const setupToken = encodeToken(FORGED_CLAIM_URL)
    const status = await claimSimplefin(
      setupToken,
      {},
      {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
      { vault, fetch: fetchFn }
    )

    expect(status).toBe(1)
    expect(err).toEqual([
      `The claim URL host must be ${SIMPLEFIN_HOST}. Host "evil.org" was refused.`,
    ])
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await vault.get(SIMPLEFIN_VAULT_KEY)).toBeUndefined()
  })

  it("exchanges valid setup token, stores access URL in vault, and never echoes the access URL", async () => {
    const vault = new InMemoryVault()
    const out: string[] = []
    const err: string[] = []

    const fetchFn = vi.fn<typeof fetch>((url, init) => {
      expect(url).toBe(VALID_CLAIM_URL)
      expect(init?.method).toBe("POST")
      return Promise.resolve(new Response(ACCESS_URL, { status: 200 }))
    })

    const setupToken = encodeToken(VALID_CLAIM_URL)
    const status = await claimSimplefin(
      setupToken,
      {},
      {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
      { vault, fetch: fetchFn }
    )

    expect(status).toBe(0)
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(await vault.get(SIMPLEFIN_VAULT_KEY)).toBe(ACCESS_URL)

    const allOutput = [...out, ...err].join("\n")
    expect(out).toEqual(["Stored SimpleFIN access credential in the gate vault."])
    expect(err).toEqual([])
    // The access URL must NEVER be echoed
    expect(allOutput).not.toContain(ACCESS_URL)
    expect(allOutput).not.toContain("password")
  })

  it("refuses an empty setup token", async () => {
    const vault = new InMemoryVault()
    const err: string[] = []
    const status = await claimSimplefin(
      "",
      {},
      {
        out: () => {},
        err: (line) => err.push(line),
      },
      { vault }
    )
    expect(status).toBe(1)
    expect(err[0]).toContain("No setup token was given")
    expect(await vault.get(SIMPLEFIN_VAULT_KEY)).toBeUndefined()
  })

  it("fails gracefully when upstream claim endpoint returns an error", async () => {
    const vault = new InMemoryVault()
    const err: string[] = []
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("Claim expired", { status: 403 }))
    )

    const setupToken = encodeToken(VALID_CLAIM_URL)
    const status = await claimSimplefin(
      setupToken,
      {},
      {
        out: () => {},
        err: (line) => err.push(line),
      },
      { vault, fetch: fetchFn }
    )

    expect(status).toBe(1)
    expect(err).toEqual(["The claim request was refused with status 403."])
    expect(await vault.get(SIMPLEFIN_VAULT_KEY)).toBeUndefined()
  })
})
