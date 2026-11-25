import { validateCoreApiAccountList } from "@eido/schemas"
import { describe, expect, test } from "vitest"
import {
  MAX_ACCOUNTS,
  assignableAccounts,
  createAccountRegistry,
} from "./accounts"
import type { KnownAccount } from "./accounts"

const gmail: KnownAccount = {
  connector: "gmail",
  healthName: "gmail",
  accountRef: "owner@example.com",
  label: "Gmail",
}
const proton: KnownAccount = {
  connector: "proton",
  healthName: "proton-mail",
  accountRef: "assistant@example.com",
  label: "Proton Mail",
}

describe("assignableAccounts", () => {
  test("lists a connector's account while it is healthy or degraded", () => {
    expect(
      assignableAccounts(
        [gmail, proton],
        [
          { name: "gmail", health: "healthy", consecutiveFailures: 0 },
          { name: "proton-mail", health: "degraded", consecutiveFailures: 1 },
        ]
      )
    ).toEqual([
      { connector: "gmail", accountRef: "owner@example.com", label: "Gmail" },
      {
        connector: "proton",
        accountRef: "assistant@example.com",
        label: "Proton Mail",
      },
    ])
  })

  test("drops the accounts of a disconnected (open) connector, matched by its health name", () => {
    expect(
      assignableAccounts(
        [gmail, proton],
        [{ name: "proton-mail", health: "open", consecutiveFailures: 5 }]
      )
    ).toEqual([
      { connector: "gmail", accountRef: "owner@example.com", label: "Gmail" },
    ])
  })
})

describe("createAccountRegistry", () => {
  test("keeps one entry per connector and address, in the order first seen", () => {
    const registry = createAccountRegistry()
    registry.add(proton)
    registry.add(gmail)
    registry.add({ ...proton, label: "Proton Mail again" })
    registry.add({ ...gmail, connector: "other" })
    expect(registry.list().map((a) => [a.connector, a.label])).toEqual([
      ["proton", "Proton Mail again"],
      ["gmail", "Gmail"],
      ["other", "Gmail"],
    ])
  })

  test("refuses a new account once full, keeps the listed ones, and still updates a known one", () => {
    const registry = createAccountRegistry()
    const calendar = (n: number): KnownAccount => ({
      connector: "calendar",
      healthName: "calendar",
      accountRef: `calendar-${n}`,
      label: "Calendar",
    })
    for (let n = 0; n < MAX_ACCOUNTS; n++) {
      expect(registry.add(calendar(n))).toBe(true)
    }
    expect(registry.add(calendar(MAX_ACCOUNTS))).toBe(false)
    expect(registry.add({ ...calendar(0), label: "Renamed" })).toBe(true)
    const listed = registry.list()
    expect(listed).toHaveLength(MAX_ACCOUNTS)
    expect(listed[0]?.label).toBe("Renamed")
    expect(
      listed.some((a) => a.accountRef === `calendar-${MAX_ACCOUNTS}`)
    ).toBe(false)
  })
})

describe("MAX_ACCOUNTS", () => {
  const accountsOf = (count: number) => ({
    accounts: Array.from({ length: count }, (_, n) => ({
      connector: "calendar",
      accountRef: `calendar-${n}`,
      label: "Calendar",
    })),
  })

  test("is the bound CoreApiAccountList states: that many validate, one more does not", () => {
    expect(validateCoreApiAccountList(accountsOf(MAX_ACCOUNTS)).ok).toBe(true)
    expect(validateCoreApiAccountList(accountsOf(MAX_ACCOUNTS + 1)).ok).toBe(
      false
    )
  })
})
