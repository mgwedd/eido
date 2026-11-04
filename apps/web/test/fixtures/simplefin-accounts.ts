// Synthetic SimpleFIN accounts for the Settings section. Imported by tests only; never by app
// code (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
import type {
  CoreApiEntity,
  CoreApiSimpleFinAccount,
  CoreApiSimpleFinAccountList,
} from "@eido/schemas"

export const household: CoreApiEntity = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "personal",
  name: "Household",
  tag: "Home",
  createdAt: "2026-10-01T09:00:00.000Z",
}

export const studio: CoreApiEntity = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "company",
  name: "Studio LLC",
  tag: "Studio",
  createdAt: "2026-10-02T09:00:00.000Z",
}

export const checking: CoreApiSimpleFinAccount = {
  id: "ACT-checking-example",
  name: "Checking",
  currency: "USD",
  balanceCents: 421055,
  balanceAt: "2026-11-02T06:00:00.000Z",
  entityId: household.id,
  backfillPending: false,
}

export const savings: CoreApiSimpleFinAccount = {
  id: "ACT-savings-example",
  name: "Savings",
  currency: "USD",
  balanceCents: 1280000,
  balanceAt: "2026-11-02T06:00:00.000Z",
  entityId: studio.id,
  backfillPending: true,
}

export const businessCard: CoreApiSimpleFinAccount = {
  id: "ACT-card-example",
  name: "Business card",
  currency: "USD",
  balanceCents: -31840,
  balanceAt: null,
  entityId: null,
  backfillPending: false,
}

export const accountList = (
  ...accounts: CoreApiSimpleFinAccount[]
): CoreApiSimpleFinAccountList => ({ accounts })
