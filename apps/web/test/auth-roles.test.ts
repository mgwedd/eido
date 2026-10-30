import { describe, expect, it, vi } from "vitest"

import {
  allowListFromEnv,
  AllowListError,
  parseAllowList,
  roleFor,
} from "@/lib/auth/roles"

const env = {
  EIDO_OWNER_EMAIL: "owner@example.test",
  EIDO_ASSISTANT_EMAILS: "assistant@example.test, second@example.test",
}
const list = parseAllowList(env)

describe("parseAllowList", () => {
  it("trims, lowercases and dedupes", () => {
    expect(
      parseAllowList({
        EIDO_OWNER_EMAIL: "  Owner@Example.TEST ",
        EIDO_ASSISTANT_EMAILS:
          " Assistant@example.test ,assistant@EXAMPLE.test,, ",
      })
    ).toEqual({
      owner: "owner@example.test",
      assistants: ["assistant@example.test"],
    })
  })

  it("allows no assistants", () => {
    expect(
      parseAllowList({ EIDO_OWNER_EMAIL: "owner@example.test" }).assistants
    ).toEqual([])
  })

  it.each([
    [{}, "EIDO_OWNER_EMAIL is not set."],
    [{ EIDO_OWNER_EMAIL: "   " }, "EIDO_OWNER_EMAIL is not set."],
    [
      { EIDO_OWNER_EMAIL: "a@example.test,b@example.test" },
      "EIDO_OWNER_EMAIL must be exactly one email address.",
    ],
    [
      { EIDO_OWNER_EMAIL: "not-an-email" },
      "EIDO_OWNER_EMAIL must be exactly one email address.",
    ],
    [
      {
        EIDO_OWNER_EMAIL: "owner@example.test",
        EIDO_ASSISTANT_EMAILS: "assistant@example.test, nope",
      },
      "EIDO_ASSISTANT_EMAILS must be a comma-separated list of email addresses.",
    ],
    [
      {
        EIDO_OWNER_EMAIL: "owner@example.test",
        EIDO_ASSISTANT_EMAILS: "OWNER@example.test",
      },
      "The owner's address is also in EIDO_ASSISTANT_EMAILS. An address can hold one role only.",
    ],
  ])("rejects %j", (input, message) => {
    expect(() => parseAllowList(input)).toThrow(new AllowListError(message))
  })

  it("never puts an address in the error", () => {
    try {
      parseAllowList({
        EIDO_OWNER_EMAIL: "owner@example.test",
        EIDO_ASSISTANT_EMAILS: "owner@example.test",
      })
    } catch (error) {
      expect(error).toBeInstanceOf(AllowListError)
      expect((error as Error).name).toBe("AllowListError")
      expect((error as Error).message).not.toContain("@")
    }
  })
})

describe("allowListFromEnv", () => {
  it("parses once per distinct value", () => {
    const first = allowListFromEnv(env)
    expect(allowListFromEnv({ ...env })).toBe(first)
    const other = allowListFromEnv({ EIDO_OWNER_EMAIL: "other@example.test" })
    expect(other.owner).toBe("other@example.test")
  })

  it("throws on a bad list every time", () => {
    expect(() => allowListFromEnv({})).toThrow(AllowListError)
    expect(() => allowListFromEnv({})).toThrow(AllowListError)
  })
})

describe("roleFor", () => {
  it("gives the owner and assistants their roles, ignoring case and spaces", () => {
    expect(
      roleFor({ email: " OWNER@example.test", email_verified: true }, list)
    ).toBe("owner")
    expect(
      roleFor({ email: "Second@Example.test", email_verified: true }, list)
    ).toBe("assistant")
  })

  it("gives no role to an address on neither list", () => {
    expect(
      roleFor({ email: "stranger@example.test", email_verified: true }, list)
    ).toBeNull()
  })

  it("gives no role unless the email is verified", () => {
    expect(roleFor({ email: "owner@example.test" }, list)).toBeNull()
    expect(
      roleFor({ email: "owner@example.test", email_verified: false }, list)
    ).toBeNull()
    expect(
      roleFor({ email: "owner@example.test", email_verified: "true" }, list)
    ).toBeNull()
  })

  it("gives no role without a usable email", () => {
    expect(roleFor(null, list)).toBeNull()
    expect(roleFor(undefined, list)).toBeNull()
    expect(roleFor({ email_verified: true }, list)).toBeNull()
    expect(roleFor({ email: 42, email_verified: true }, list)).toBeNull()
    expect(roleFor({ email: "  ", email_verified: true }, list)).toBeNull()
  })

  it("reads the allow-list from the environment by default", () => {
    vi.stubEnv("EIDO_OWNER_EMAIL", "owner@example.test")
    vi.stubEnv("EIDO_ASSISTANT_EMAILS", "")
    try {
      expect(
        roleFor({ email: "owner@example.test", email_verified: true })
      ).toBe("owner")
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
