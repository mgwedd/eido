// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest"
import {
  aboutInfo,
  chainReason,
  chainSummary,
  loadAuditChain,
  loadPasskeys,
  loadPermissions,
  reasonLabel,
  shortFingerprint,
  isRevoked,
  TIER_LABELS,
} from "../lib/settings"
import {
  activePasskey,
  chainBroken,
  chainOk,
  chainOneRow,
  permissions,
  revokedPasskey,
} from "./fixtures/settings"

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))

function stub(impl: typeof fetch) {
  const fn = vi.fn(impl)
  vi.stubGlobal("fetch", fn)
  return fn
}

const signal = () => new AbortController().signal

describe("loadSection", () => {
  test("reads each gate endpoint uncached and returns the validated value", async () => {
    const fn = stub((input) =>
      json(
        requestUrl(input).endsWith("/passkeys")
          ? { passkeys: [activePasskey] }
          : requestUrl(input).endsWith("/permissions")
            ? permissions
            : chainOk
      )
    )
    expect(await loadPasskeys(signal())).toEqual({
      status: "ready",
      value: { passkeys: [activePasskey] },
    })
    expect(await loadPermissions(signal())).toEqual({
      status: "ready",
      value: permissions,
    })
    expect(await loadAuditChain(signal())).toEqual({
      status: "ready",
      value: chainOk,
    })
    expect(fn.mock.calls.map((c) => c[0])).toEqual([
      "/api/gate/passkeys",
      "/api/gate/permissions",
      "/api/gate/audit/chain",
    ])
    for (const call of fn.mock.calls)
      expect(call[1]).toMatchObject({ cache: "no-store" })
  })

  test("401 is unauthenticated, other statuses and bad bodies are errors", async () => {
    stub(() => json({}, 401))
    expect(await loadPasskeys(signal())).toEqual({ status: "unauthenticated" })
    stub(() => json({}, 500))
    expect(await loadPasskeys(signal())).toEqual({ status: "error" })
    stub(() => json({ passkeys: "nope" }))
    expect(await loadPasskeys(signal())).toEqual({ status: "error" })
  })

  test("a network failure is offline and carries no data", async () => {
    stub(() => Promise.reject(new TypeError("network")))
    expect(await loadAuditChain(signal())).toEqual({ status: "offline" })
  })

  test("an aborted read or other throw is an error", async () => {
    const controller = new AbortController()
    stub(() => {
      controller.abort()
      return Promise.reject(new TypeError("aborted"))
    })
    expect(await loadAuditChain(controller.signal)).toEqual({ status: "error" })
    stub(() => Promise.reject(new Error("boom")))
    expect(await loadAuditChain(signal())).toEqual({ status: "error" })
  })

  test("never writes gate data to device storage", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem")
    stub(() => json(chainOk))
    await loadAuditChain(signal())
    stub(() => json({ passkeys: [activePasskey] }))
    await loadPasskeys(signal())
    expect(set).not.toHaveBeenCalled()
    set.mockRestore()
  })
})

describe("labels", () => {
  test("passkey fingerprint and status", () => {
    expect(shortFingerprint(activePasskey.fingerprint)).toBe("aaaaaaaa")
    expect(isRevoked(activePasskey)).toBe(false)
    expect(isRevoked(revokedPasskey)).toBe(true)
  })
  test("tiers and reasons", () => {
    expect(TIER_LABELS.approval).toBe("Needs approval")
    expect(reasonLabel(undefined)).toBeNull()
    expect(reasonLabel("connector_disabled")).toBe("Its connector is disabled.")
    expect(reasonLabel("something_new")).toBe("something_new")
  })
  test("chain summary and reason", () => {
    expect(chainSummary(chainOk)).toBe("OK, 42 rows")
    expect(chainSummary(chainOneRow)).toBe("OK, 1 row")
    expect(chainSummary(chainBroken)).toBe("Broken at sequence 7")
    expect(chainReason(chainOk)).toBeNull()
    expect(chainReason(chainBroken)).toBe(
      "A row does not link to the one before it."
    )
    expect(
      chainReason({ ok: false, brokenAtSeq: 0, reason: "head_mismatch" })
    ).toBe("The stored head does not match the log.")
  })
})

describe("aboutInfo", () => {
  test("version with and without a build id", () => {
    expect(
      aboutInfo({
        NEXT_PUBLIC_APP_VERSION: "1.2.3",
        NEXT_PUBLIC_BUILD_ID: "abc123",
      })
    ).toEqual({ version: "1.2.3", buildId: "abc123" })
    expect(
      aboutInfo({ NEXT_PUBLIC_APP_VERSION: "1.2.3", NEXT_PUBLIC_BUILD_ID: "" })
    ).toEqual({ version: "1.2.3", buildId: null })
  })
  test("no version means no About section", () => {
    expect(aboutInfo({})).toBeNull()
  })
})
