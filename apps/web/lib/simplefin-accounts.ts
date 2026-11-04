import {
  validateCoreApiEntityList,
  validateCoreApiSimpleFinAccount,
  validateCoreApiSimpleFinAccountList,
  type CoreApiEntity,
  type CoreApiSimpleFinAccount,
} from "@eido/schemas"
import { formatAmount } from "@/lib/transactions"

export type SimpleFinAccount = CoreApiSimpleFinAccount
export type EntityOption = Pick<CoreApiEntity, "id" | "name">

export const SIMPLEFIN_ACCOUNTS_URL = "/api/core/connectors/simplefin/accounts"
export const SIMPLEFIN_ASSIGNMENTS_URL =
  "/api/core/connectors/simplefin/assignments"
export const ENTITIES_URL = "/api/core/entities"

/**
 * The section's read. Core serves the accounts route only when SimpleFIN is configured, so a 404
 * is "not_configured" and the section is not shown. Nothing is stored on the device: a network
 * failure is "offline" and carries no data.
 */
export type SimpleFinAccountsLoad =
  | { status: "ready"; accounts: SimpleFinAccount[]; entities: EntityOption[] }
  | { status: "not_configured" }
  | { status: "offline" }
  | { status: "error" }

type Read<T> =
  | { ok: true; value: T }
  | { ok: false; status: "not_configured" | "offline" | "error" }

async function read<T>(
  url: string,
  validate: (input: unknown) => { ok: true; value: T } | { ok: false },
  signal: AbortSignal
): Promise<Read<T>> {
  try {
    const response = await fetch(url, { cache: "no-store", signal })
    if (response.status === 404) return { ok: false, status: "not_configured" }
    if (!response.ok) return { ok: false, status: "error" }
    const parsed = validate(await response.json())
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : { ok: false, status: "error" }
  } catch (error) {
    if (!signal.aborted && error instanceof TypeError)
      return { ok: false, status: "offline" }
    return { ok: false, status: "error" }
  }
}

/** Reads the stored SimpleFIN accounts and the entities they can be assigned to, in parallel. */
export async function loadSimpleFinAccounts(
  signal: AbortSignal
): Promise<SimpleFinAccountsLoad> {
  const [accounts, entities] = await Promise.all([
    read(SIMPLEFIN_ACCOUNTS_URL, validateCoreApiSimpleFinAccountList, signal),
    read(ENTITIES_URL, validateCoreApiEntityList, signal),
  ])
  if (!accounts.ok) return { status: accounts.status }
  if (!entities.ok)
    return {
      status: entities.status === "offline" ? "offline" : "error",
    }
  return {
    status: "ready",
    accounts: accounts.value.accounts,
    entities: entities.value.entities
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** Stores `entityId` as the entity of the account. The account id goes in the body, never the URL. */
export async function saveSimpleFinEntity(
  accountId: string,
  entityId: string
): Promise<SimpleFinAccount | null> {
  try {
    const response = await fetch(SIMPLEFIN_ASSIGNMENTS_URL, {
      method: "PUT",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId, entityId }),
    })
    if (!response.ok) return null
    const parsed = validateCoreApiSimpleFinAccount(await response.json())
    if (!parsed.ok) return null
    const saved = parsed.value
    return saved.id === accountId && saved.entityId === entityId ? saved : null
  } catch {
    return null
  }
}

/** The section's status line; it matches the connector health message for unassigned accounts. */
export function unassignedSummary(accounts: readonly SimpleFinAccount[]): {
  unassigned: number
  label: string
} {
  const unassigned = accounts.filter((a) => a.entityId === null).length
  if (unassigned === 0)
    return { unassigned, label: "All accounts have an entity." }
  return {
    unassigned,
    label:
      unassigned === 1
        ? "1 account needs an entity"
        : `${unassigned} accounts need an entity`,
  }
}

/** "USD · $4,210.55", "USD · −$318.40"; just the currency when SimpleFIN sent no usable balance. */
export function balanceLine(account: SimpleFinAccount): string {
  if (account.balanceCents === null) return account.currency
  const amount = formatAmount(account.balanceCents, account.currency)
  return `${account.currency} · ${amount.replace(/^\+/, "")}`
}

export function saveErrorMessage(accountName: string): string {
  return `Could not save the entity for ${accountName}. Nothing was changed.`
}
