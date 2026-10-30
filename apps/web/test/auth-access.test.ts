import { describe, expect, it, vi } from "vitest"

import {
  canAccess,
  forbiddenReason,
  guard,
  matchesPath,
  ROUTE_RULES,
} from "@/lib/auth/access"
import { NAV_ITEMS } from "@/lib/nav"

describe("matchesPath", () => {
  it("matches exactly or by nested segment", () => {
    expect(matchesPath("/queue", "/queue")).toBe(true)
    expect(matchesPath("/queue/abc", "/queue")).toBe(true)
    expect(matchesPath("/queueish", "/queue")).toBe(false)
  })

  it("matches the root only exactly", () => {
    expect(matchesPath("/", "/")).toBe(true)
    expect(matchesPath("/queue", "/")).toBe(false)
  })
})

describe("canAccess", () => {
  it("lets the owner open everything, mapped or not", () => {
    for (const path of ["/", "/queue", "/unlock", "/not-yet-built"])
      expect(canAccess("owner", path)).toBe(true)
  })

  it("keeps every page owner-only for now, so the assistant is refused", () => {
    for (const path of ["/", "/queue", "/queue/abc", "/unlock"])
      expect(canAccess("assistant", path)).toBe(false)
  })

  it("denies a path that matches no rule to anyone but the owner", () => {
    expect(canAccess("assistant", "/not-yet-built")).toBe(false)
  })

  it("lets an assistant open a page a rule grants them", () => {
    const rules = [{ path: "/handoff", roles: ["assistant"] }] as const
    expect(canAccess("assistant", "/handoff/1", rules)).toBe(true)
    expect(canAccess("assistant", "/queue", rules)).toBe(false)
  })

  it("lets anyone signed in, with no role, open only the 403 page", () => {
    expect(canAccess(null, "/forbidden")).toBe(true)
    expect(canAccess("assistant", "/forbidden")).toBe(true)
    expect(canAccess(null, "/")).toBe(false)
  })

  it("maps every nav entry", () => {
    for (const { href } of NAV_ITEMS)
      expect(ROUTE_RULES.some((rule) => rule.path === href)).toBe(true)
  })
})

describe("guard", () => {
  it("sends a signed-out request to login with the page it asked for", () => {
    expect(
      guard({
        signedIn: false,
        role: null,
        pathname: "/queue",
        search: "?id=1",
      })
    ).toEqual({ kind: "login", returnTo: "/queue?id=1" })
  })

  it("allows the owner and refuses everyone else", () => {
    const base = { signedIn: true, pathname: "/queue", search: "" }
    expect(guard({ ...base, role: "owner" })).toEqual({ kind: "allow" })
    expect(guard({ ...base, role: "assistant" })).toEqual({
      kind: "forbidden",
    })
    expect(guard({ ...base, role: null })).toEqual({ kind: "forbidden" })
  })
})

describe("forbiddenReason", () => {
  // Uses the allow-list from the environment.
  const withEnv = (fn: () => void) => {
    vi.stubEnv("EIDO_OWNER_EMAIL", "owner@example.test")
    vi.stubEnv("EIDO_ASSISTANT_EMAILS", "assistant@example.test")
    try {
      fn()
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it("names the reason", () => {
    withEnv(() => {
      expect(
        forbiddenReason({ email: "owner@example.test", email_verified: true })
      ).toBeNull()
      expect(
        forbiddenReason({ email: "owner@example.test", email_verified: false })
      ).toBe("unverified")
      expect(
        forbiddenReason({
          email: "stranger@example.test",
          email_verified: true,
        })
      ).toBe("not-invited")
      expect(
        forbiddenReason({
          email: "assistant@example.test",
          email_verified: true,
        })
      ).toBe("owner-only")
    })
  })
})
