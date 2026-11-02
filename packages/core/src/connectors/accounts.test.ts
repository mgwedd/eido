import { describe, expect, test } from "vitest"
import { assignableAccounts, createAccountRegistry } from "./accounts"
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
})
