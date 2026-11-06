import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  can,
  requirePermission,
  ROLE_PERMISSIONS,
  roleHas,
} from "@/lib/auth/permissions"

const owner = {
  sub: "email|owner-0001",
  email: "owner@example.test",
  email_verified: true,
}
const assistant = {
  sub: "email|assistant-0001",
  email: "assistant@example.test",
  email_verified: true,
}
const stranger = {
  sub: "email|stranger-0001",
  email: "stranger@example.test",
  email_verified: true,
}

beforeEach(() => {
  vi.stubEnv("EIDO_OWNER_EMAIL", "owner@example.test")
  vi.stubEnv("EIDO_ASSISTANT_EMAILS", "assistant@example.test")
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("ROLE_PERMISSIONS", () => {
  it("gives the owner every action the web app offers", () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([
      "approval:decide",
      "approval:edit",
      "approval:undo",
      "ask:query",
      "connector:update",
      "document:update",
      "draft:create",
      "folders:update",
      "notifications:update",
      "obligation:resolve",
      "passkey:enroll",
      "passkey:unlock",
      "profile:update",
    ])
  })

  it("gives the assistant nothing until the hand-off workspace lands", () => {
    expect(ROLE_PERMISSIONS.assistant).toEqual([])
  })
})

describe("roleHas", () => {
  it("allows only what the map lists for the role", () => {
    const map = { owner: ["draft:send"], assistant: ["handoff:read"] }
    expect(roleHas("assistant", "handoff:read", map)).toBe(true)
    expect(roleHas("assistant", "draft:send", map)).toBe(false)
    expect(roleHas("owner", "draft:send", map)).toBe(true)
  })

  it("denies a permission that is not in the list, even to the owner", () => {
    expect(roleHas("owner", "money:transfer")).toBe(false)
    expect(roleHas("owner", "")).toBe(false)
  })

  it("denies everything without a role", () => {
    expect(roleHas(null, "approval:decide")).toBe(false)
  })
})

describe("can", () => {
  it("lets the owner, and only the owner, decide approvals", () => {
    expect(can(owner, "approval:decide")).toBe(true)
    expect(can(assistant, "approval:decide")).toBe(false)
    expect(can(stranger, "approval:decide")).toBe(false)
    expect(can(null, "approval:decide")).toBe(false)
  })

  it("refuses an owner address whose email is not verified", () => {
    expect(can({ ...owner, email_verified: false }, "draft:create")).toBe(false)
  })
})

describe("requirePermission", () => {
  it("returns null for a permission the user holds, and logs nothing", () => {
    const log = vi.fn()
    expect(requirePermission(owner, "draft:create", "/api/drafts", log)).toBe(
      null
    )
    expect(log).not.toHaveBeenCalled()
  })

  it("answers 403 to the assistant on an action they lack", async () => {
    const response = requirePermission(
      assistant,
      "draft:create",
      "/api/drafts",
      () => undefined
    )
    expect(response?.status).toBe(403)
    expect(response?.headers.get("cache-control")).toBe("no-store")
    expect(await response?.json()).toEqual({
      error: "forbidden",
      message: "You do not have access to this action.",
    })
  })

  it("logs the role, permission, route and Auth0 user id, never the email", () => {
    const log = vi.fn()
    requirePermission(assistant, "approval:decide", "/queue", log)
    expect(log).toHaveBeenCalledOnce()
    const line = String(log.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toEqual({
      event: "permission_denied",
      role: "assistant",
      permission: "approval:decide",
      route: "/queue",
      userId: "email|assistant-0001",
    })
    expect(line).not.toContain("assistant@example.test")
  })

  it("logs a user without a role as none, and a missing id as null", () => {
    const log = vi.fn()
    const response = requirePermission(
      { email: "stranger@example.test", email_verified: true },
      "profile:update",
      "/profile",
      log
    )
    expect(response?.status).toBe(403)
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      event: "permission_denied",
      role: "none",
      permission: "profile:update",
      route: "/profile",
      userId: null,
    })
  })

  it("logs to console.warn by default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    requirePermission(undefined, "ask:query", "/ask")
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
