import type { CoreApiTransactionList } from "@eido/schemas"

export const ENTITY_PERSONAL = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Personal",
  tag: "personal",
} as const

export const ENTITY_PROPERTY = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Property",
  tag: "property",
} as const

export const ACCOUNT_CHECKING = {
  id: "acct-checking",
  name: "Checking",
} as const
export const ACCOUNT_CARD = { id: "acct-card", name: "Card" } as const

export const NOW = new Date(2026, 9, 18, 12)

export const groceries = {
  id: "txn-1",
  postedAt: "2026-10-17T00:00:00.000Z",
  description: "Corner Market (example.invalid)",
  amountCents: -8412,
  currency: "USD",
  account: ACCOUNT_CARD,
  entity: ENTITY_PERSONAL,
  linkedObligation: null,
} satisfies CoreApiTransactionList["transactions"][number]

export const rent = {
  id: "txn-2",
  postedAt: "2026-10-01T00:00:00.000Z",
  description: "Tenant rent (example.invalid)",
  amountCents: 200000,
  currency: "USD",
  account: ACCOUNT_CHECKING,
  entity: ENTITY_PROPERTY,
  linkedObligation: null,
} satisfies CoreApiTransactionList["transactions"][number]

export const lastYear = {
  id: "txn-3",
  postedAt: "2025-12-30T00:00:00.000Z",
  description: "Insurance premium (example.invalid)",
  amountCents: -15000,
  currency: "USD",
  account: ACCOUNT_CHECKING,
  entity: ENTITY_PROPERTY,
  linkedObligation: null,
} satisfies CoreApiTransactionList["transactions"][number]

/** A debit core matched to the obligation it paid (#576); the action text is generated, so lorem. */
export const paidBill = {
  id: "txn-4",
  postedAt: "2026-10-12T00:00:00.000Z",
  description: "Water utility (example.invalid)",
  amountCents: -6250,
  currency: "USD",
  account: ACCOUNT_CHECKING,
  entity: ENTITY_PROPERTY,
  linkedObligation: { id: 7, action: "Lorem ipsum dolor" },
} satisfies CoreApiTransactionList["transactions"][number]

export const page = (
  transactions: CoreApiTransactionList["transactions"],
  nextOffset: number | null = null
): CoreApiTransactionList => ({
  transactions,
  accounts: [ACCOUNT_CHECKING, ACCOUNT_CARD],
  nextOffset,
})
