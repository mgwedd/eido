import { describe, expect, test } from "vitest"
import { authorizedCall, type RefreshResult } from "./authorized-call"
import {
  ConnectorDisabledError,
  GrantRevokedError,
  UpstreamError,
  type AuditEntry,
  type ConnectorStore,
} from "./revocation"
import { InMemoryVault } from "./vault"

const REFRESH = "test-refresh-token-1"
const ACCESS = "test-access-token-1"

class FakeConnectors implements ConnectorStore {
  enabled = true
  health: "closed" | "open" = "closed"
  isEnabled(): Promise<boolean> {
    return Promise.resolve(this.enabled)
  }
  disable(): Promise<void> {
    this.enabled = false
    this.health = "open"
    return Promise.resolve()
  }
}

async function setup(refreshResult: RefreshResult, statuses: number[] = [200]) {
  const vault = new InMemoryVault()
  await vault.set(
    { connector: "google", kind: "refresh_token", client: "read" },
    REFRESH
  )
  const connectors = new FakeConnectors()
  const entries: AuditEntry[] = []
  const calls = { refresh: 0, upstream: 0 }
  const run = () =>
    authorizedCall({
      connector: "google",
      client: "read",
      vault,
      connectors,
      audit: { append: (e) => (entries.push(e), Promise.resolve()) },
      refresh: () => (calls.refresh++, Promise.resolve(refreshResult)),
      call: () =>
        Promise.resolve({ status: statuses[calls.upstream++] ?? 200 }),
    })
  return { vault, connectors, entries, calls, run }
}

describe("authorizedCall", () => {
  test("invariant: revoked grant disables and audits the connector without retry", async () => {
    const s = await setup({ ok: false, error: "invalid_grant" })
    await s.vault.set(
      { connector: "google", kind: "access_token", client: "write" },
      ACCESS
    )
    await expect(s.run()).rejects.toBeInstanceOf(GrantRevokedError)
    expect(s.calls.refresh).toBe(1)
    expect(s.calls.upstream).toBe(0)
    expect(s.connectors.enabled).toBe(false)
    expect(s.connectors.health).toBe("open")
    expect(s.entries).toEqual([
      {
        action: "grant_revoked",
        target: "google",
        errorClass: "invalid_grant",
      },
    ])
    expect(
      await s.vault.get({
        connector: "google",
        kind: "access_token",
        client: "write",
      })
    ).toBeUndefined()
  })

  test("after revocation a further call is refused without contacting upstream", async () => {
    const s = await setup({ ok: false, error: "invalid_grant" })
    await expect(s.run()).rejects.toBeInstanceOf(GrantRevokedError)
    await expect(s.run()).rejects.toBeInstanceOf(ConnectorDisabledError)
    expect(s.calls).toEqual({ refresh: 1, upstream: 0 })
    expect(s.entries).toHaveLength(1)
  })

  test("no secret appears in audit entries or error messages", async () => {
    const s = await setup({ ok: false, error: "invalid_grant" })
    const errors = [
      await s.run().catch((e: unknown) => e),
      await s.run().catch((e: unknown) => e),
    ]
    const text =
      JSON.stringify(s.entries) +
      errors.map((e) => (e as Error).message).join("|")
    expect(text).not.toContain(REFRESH)
    expect(text).not.toContain(ACCESS)
  })

  test("refreshes, caches the access token and calls upstream", async () => {
    const s = await setup({ ok: true, accessToken: ACCESS })
    expect((await s.run()).status).toBe(200)
    await s.run()
    expect(s.calls).toEqual({ refresh: 1, upstream: 2 })
  })

  test("401 on a cached token refreshes once and retries once", async () => {
    const s = await setup({ ok: true, accessToken: ACCESS }, [401, 200])
    await s.vault.set(
      { connector: "google", kind: "access_token", client: "read" },
      "test-stale-token"
    )
    expect((await s.run()).status).toBe(200)
    expect(s.calls).toEqual({ refresh: 1, upstream: 2 })
  })

  test("401 then revoked refresh disables the connector", async () => {
    const s = await setup({ ok: false, error: "invalid_grant" }, [401])
    await s.vault.set(
      { connector: "google", kind: "access_token", client: "read" },
      "test-stale-token"
    )
    await expect(s.run()).rejects.toBeInstanceOf(GrantRevokedError)
    expect(s.calls).toEqual({ refresh: 1, upstream: 1 })
    expect(s.connectors.enabled).toBe(false)
  })

  test("401 on a freshly refreshed token is returned, not looped", async () => {
    const s = await setup({ ok: true, accessToken: ACCESS }, [401])
    expect((await s.run()).status).toBe(401)
    expect(s.calls).toEqual({ refresh: 1, upstream: 1 })
  })

  test("transient refresh failure does not disable the connector", async () => {
    const s = await setup({ ok: false, error: "temporarily_unavailable" })
    await expect(s.run()).rejects.toBeInstanceOf(UpstreamError)
    expect(s.connectors.enabled).toBe(true)
    expect(s.entries).toHaveLength(0)
  })

  test("missing refresh token is an upstream error", async () => {
    const s = await setup({ ok: true, accessToken: ACCESS })
    await s.vault.delete({
      connector: "google",
      kind: "refresh_token",
      client: "read",
    })
    await expect(s.run()).rejects.toBeInstanceOf(UpstreamError)
    expect(s.calls.upstream).toBe(0)
  })
})
