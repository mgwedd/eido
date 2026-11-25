import type { CoreApiAccountList, GateConnectorHealth } from "@eido/schemas"

/** An account a configured connector has reported, before its health is known. */
export type KnownAccount = {
  /** The connector name an assignment uses, such as `gmail`. */
  connector: string
  /** The connector's name in gate health, such as `proton-mail`. */
  healthName: string
  accountRef: string
  label: string
}

type Account = CoreApiAccountList["accounts"][number]

/**
 * The accounts the Profile page can assign: every known account whose connector is not
 * disconnected. A connector the gate reports as open is disconnected; one the gate has no
 * record for has not failed yet, so it counts as connected.
 */
export function assignableAccounts(
  known: readonly KnownAccount[],
  health: GateConnectorHealth["connectors"]
): Account[] {
  const open = new Set(
    health.filter((item) => item.health === "open").map((item) => item.name)
  )
  return known
    .filter((account) => !open.has(account.healthName))
    .map(({ connector, accountRef, label }) => ({
      connector,
      accountRef,
      label,
    }))
}

/**
 * The most accounts the registry holds. It equals `maxItems` of `CoreApiAccountList`, so
 * `GET /connectors/accounts` can never answer outside its schema; accounts.test.ts fails
 * when the two drift apart.
 */
export const MAX_ACCOUNTS = 500

/**
 * Accounts reported at runtime, one per connector and address, in the order first seen.
 * Once `MAX_ACCOUNTS` are held, an account not already registered is refused (`add` returns
 * false) and the ones listed stay as they are; re-adding a known account always succeeds.
 */
export function createAccountRegistry(): {
  add: (account: KnownAccount) => boolean
  list: () => readonly KnownAccount[]
} {
  const accounts = new Map<string, KnownAccount>()
  return {
    add: (account) => {
      const key = JSON.stringify([account.connector, account.accountRef])
      if (!accounts.has(key) && accounts.size >= MAX_ACCOUNTS) return false
      accounts.set(key, account)
      return true
    },
    list: () => [...accounts.values()],
  }
}
