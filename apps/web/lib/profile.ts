import {
  validateCoreApiAccountList,
  validateCoreApiAssignmentList,
  validateCoreApiEntity,
  validateCoreApiEntityList,
  validateCoreApiError,
  validateCoreApiProfile,
  validateCoreApiProfileResponse,
  validateCoreApiSendFrom,
  validateProfileAccountAssignment,
  type CoreApiAccountList,
  type CoreApiEntity,
  type CoreApiProfile,
  type ProfileAccountAssignment,
} from "@eido/schemas"

export type Profile = CoreApiProfile
export type Entity = CoreApiEntity
export type Assignment = ProfileAccountAssignment
export type Account = CoreApiAccountList["accounts"][number]
export type EntityKind = Entity["kind"]

/** Core is reached from the browser under this prefix (issue 178); the profile needs no unlock. */
export const CORE_URL = "/api/core"

export const MAX_TAG_LENGTH = 24

/** A field name the page shows an error on. */
export type ProfileField =
  | "displayName"
  | "timezone"
  | "signature"
  | "address"
  | "name"
  | "tag"
  | "assignments"

export type FieldErrors = Partial<Record<ProfileField, string>>

/** A write to core, as the page needs to react to it. */
export type Mutation<T> =
  | { status: "saved"; value: T }
  | { status: "invalid"; errors: FieldErrors }
  | { status: "in_use"; referencedBy: string[] }
  | { status: "failed" }

export type ProfilePageData = {
  /** Absent until the first write sets a display name and timezone. */
  profile: Profile | null
  entities: Entity[]
  assignments: Assignment[]
  /** Absent when the connectors could not be read; the page then says so. */
  accounts: Account[] | null
  /** The assistant address; null when Proton is not configured, undefined when unreadable. */
  sendFrom: string | null | undefined
}

export type ProfileLoad =
  { status: "ready"; data: ProfilePageData } | { status: "unreachable" }

type Raw =
  | { ok: true; status: number; body: unknown }
  | {
      ok: false
      code?: string
      fields?: { field: string; message: string }[]
      referencedBy?: string[]
    }

async function call(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<Raw> {
  try {
    const response = await fetch(`${CORE_URL}${path}`, {
      method: init.method ?? "GET",
      cache: "no-store",
      ...(init.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(init.body),
          }),
      ...(init.signal ? { signal: init.signal } : {}),
    })
    if (response.ok) {
      const body: unknown =
        response.status === 204 ? null : await response.json()
      return { ok: true, status: response.status, body }
    }
    const parsed = validateCoreApiError(await response.json().catch(() => null))
    if (!parsed.ok) return { ok: false }
    const { code, fields, referencedBy } = parsed.value.error
    return {
      ok: false,
      code,
      ...(fields ? { fields } : {}),
      ...(referencedBy ? { referencedBy } : {}),
    }
  } catch {
    return { ok: false }
  }
}

/** Reads the profile, entities, assignments, accounts and send-from address in parallel. */
export async function loadProfilePage(
  signal: AbortSignal
): Promise<ProfileLoad> {
  const [profile, entities, assignments, accounts, sendFrom] =
    await Promise.all([
      call("/profile", { signal }),
      call("/entities", { signal }),
      call("/entity-assignments", { signal }),
      call("/connectors/accounts", { signal }),
      call("/connectors/send-from", { signal }),
    ])
  if (!profile.ok || !entities.ok || !assignments.ok)
    return { status: "unreachable" }
  const profileBody = validateCoreApiProfileResponse(profile.body)
  const entityBody = validateCoreApiEntityList(entities.body)
  const assignmentBody = validateCoreApiAssignmentList(assignments.body)
  if (!profileBody.ok || !entityBody.ok || !assignmentBody.ok)
    return { status: "unreachable" }
  const accountBody = accounts.ok
    ? validateCoreApiAccountList(accounts.body)
    : null
  const sendFromBody = sendFrom.ok
    ? validateCoreApiSendFrom(sendFrom.body)
    : null
  return {
    status: "ready",
    data: {
      profile: profileBody.value.profile ?? null,
      entities: entityBody.value.entities,
      assignments: assignmentBody.value.assignments,
      accounts: accountBody?.ok ? accountBody.value.accounts : null,
      sendFrom: sendFromBody?.ok ? sendFromBody.value.address : undefined,
    },
  }
}

// --- Copy for field errors. Core's messages name internals; the page says it its own way. ---

export const FIELD_MESSAGES = {
  displayName: "Enter a name.",
  timezone: "Choose a timezone from the list.",
  address: "Enter a full email address.",
  addressDuplicate: "This address is already listed.",
  name: "Enter a name on one line.",
  nameDuplicate: "Another entity uses this name.",
  tag: `Use 1 to ${MAX_TAG_LENGTH} characters, no brackets.`,
  tagDuplicate: "Another entity uses this tag.",
  signature: "Keep the sign-off under 2000 characters.",
  generic: "Not saved. Retry.",
} as const

const EMAIL =
  /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/

export function validAddress(address: string): boolean {
  const trimmed = address.trim()
  return trimmed.length <= 254 && EMAIL.test(trimmed)
}

export function validTag(tag: string): boolean {
  const trimmed = tag.trim()
  return (
    trimmed.length >= 1 &&
    trimmed.length <= MAX_TAG_LENGTH &&
    !/[[\]\r\n]/.test(trimmed)
  )
}

/** Checks the form before anything is sent; core checks again and has the last word. */
export function checkEntityForm(input: {
  name: string
  tag: string
}): FieldErrors {
  const errors: FieldErrors = {}
  if (input.name.trim() === "" || /[\r\n]/.test(input.name))
    errors.name = FIELD_MESSAGES.name
  if (!validTag(input.tag)) errors.tag = FIELD_MESSAGES.tag
  return errors
}

export function checkProfileForm(input: {
  displayName: string
  timezone: string
  signature: string
}): FieldErrors {
  const errors: FieldErrors = {}
  if (input.displayName.trim() === "")
    errors.displayName = FIELD_MESSAGES.displayName
  if (input.timezone === "") errors.timezone = FIELD_MESSAGES.timezone
  if (input.signature.length > 2000) errors.signature = FIELD_MESSAGES.signature
  return errors
}

export function checkAddressForm(input: {
  address: string
  others: readonly string[]
}): FieldErrors {
  if (!validAddress(input.address)) return { address: FIELD_MESSAGES.address }
  const wanted = input.address.trim().toLowerCase()
  if (input.others.some((other) => other.toLowerCase() === wanted))
    return { address: FIELD_MESSAGES.addressDuplicate }
  return {}
}

/** Maps the field list of a 422 to the page's fields. */
export function fieldErrorsFrom(
  fields: readonly { field: string; message: string }[] | undefined
): FieldErrors {
  const errors: FieldErrors = {}
  for (const { field, message } of fields ?? []) {
    if (field === "displayName") errors.displayName = FIELD_MESSAGES.displayName
    else if (field === "timezone") errors.timezone = FIELD_MESSAGES.timezone
    else if (field === "signature") errors.signature = FIELD_MESSAGES.signature
    else if (field.startsWith("addresses"))
      errors.address = /duplicate/.test(message)
        ? FIELD_MESSAGES.addressDuplicate
        : FIELD_MESSAGES.address
    else if (field === "name") errors.name = FIELD_MESSAGES.name
    else if (field === "tag") errors.tag = FIELD_MESSAGES.tag
  }
  return errors
}

function toMutation<T>(
  raw: Raw,
  read: (body: unknown) => T | null
): Mutation<T> {
  if (raw.ok) {
    const value = read(raw.body)
    return value === null ? { status: "failed" } : { status: "saved", value }
  }
  const failure = raw
  if (failure.code === "entity_in_use")
    return { status: "in_use", referencedBy: failure.referencedBy ?? [] }
  if (failure.code === "duplicate_tag")
    return { status: "invalid", errors: { tag: FIELD_MESSAGES.tagDuplicate } }
  if (failure.code === "duplicate_name")
    return { status: "invalid", errors: { name: FIELD_MESSAGES.nameDuplicate } }
  if (failure.code === "invalid") {
    const errors = fieldErrorsFrom(failure.fields)
    if (Object.keys(errors).length > 0) return { status: "invalid", errors }
  }
  return { status: "failed" }
}

const readProfile = (body: unknown): Profile | null => {
  const parsed = validateCoreApiProfile(body)
  return parsed.ok ? parsed.value : null
}

const readEntity = (body: unknown): Entity | null => {
  const parsed = validateCoreApiEntity(body)
  return parsed.ok ? parsed.value : null
}

export type ProfileChange = {
  displayName?: string
  timezone?: string
  signature?: string
  addresses?: { address: string; label?: string }[]
}

export async function saveProfile(
  change: ProfileChange
): Promise<Mutation<Profile>> {
  return toMutation(
    await call("/profile", { method: "PATCH", body: change }),
    readProfile
  )
}

export async function createEntity(input: {
  kind: EntityKind
  name: string
  tag: string
}): Promise<Mutation<Entity>> {
  return toMutation(
    await call("/entities", {
      method: "POST",
      body: { ...input, name: input.name.trim(), tag: input.tag.trim() },
    }),
    readEntity
  )
}

export async function updateEntity(
  id: string,
  input: { name: string; tag: string }
): Promise<Mutation<Entity>> {
  return toMutation(
    await call(`/entities/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { name: input.name.trim(), tag: input.tag.trim() },
    }),
    readEntity
  )
}

export async function removeEntity(id: string): Promise<Mutation<true>> {
  return toMutation(
    await call(`/entities/${encodeURIComponent(id)}`, { method: "DELETE" }),
    () => true as const
  )
}

export async function assignAccount(
  assignment: Assignment
): Promise<Mutation<Assignment>> {
  return toMutation(
    await call("/entity-assignments", { method: "PUT", body: assignment }),
    (body) => {
      const parsed = validateProfileAccountAssignment(body)
      return parsed.ok ? parsed.value : null
    }
  )
}

/** An account already unassigned counts as done: the goal is that it has no entity. */
export async function unassignAccount(
  account: Pick<Assignment, "connector" | "accountRef">
): Promise<Mutation<true>> {
  const query = new URLSearchParams({
    connector: account.connector,
    accountRef: account.accountRef,
  })
  const raw = await call(`/entity-assignments?${query.toString()}`, {
    method: "DELETE",
  })
  if (!raw.ok && raw.code === "not_found")
    return { status: "saved", value: true }
  return toMutation(raw, () => true as const)
}

// --- Pure helpers for what the page shows. ---

/** What blocks removing an entity, in the owner's words. */
const REFERENCE_LABELS: Readonly<Record<string, string>> = {
  documents: "documents",
  entity_assignments: "assigned accounts",
  default_entity: "the default entity",
  obligations: "ledger obligations",
}

export function referenceLabel(table: string): string {
  return REFERENCE_LABELS[table] ?? table
}

export function inUseMessage(referencedBy: readonly string[]): string {
  if (referencedBy.length === 0) return "Not removed. Something still uses it."
  const labels = referencedBy.map(referenceLabel)
  const list =
    labels.length === 1
      ? (labels[0] ?? "")
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
  return `Not removed. Still used by ${list}.`
}

export type AccountRow = {
  connector: string
  accountRef: string
  label: string
  /** The entity it is assigned to, or null when unassigned. */
  entityId: string | null
}

/**
 * Every account the page can show: the ones the connectors report, plus any assigned account
 * the connectors no longer report (so it can still be unassigned). An account has at most one
 * entity.
 */
export function accountRows(
  accounts: readonly Account[] | null,
  assignments: readonly Assignment[]
): AccountRow[] {
  const key = (connector: string, ref: string) => `${connector}\u0000${ref}`
  const owner = new Map(
    assignments.map((a) => [key(a.connector, a.accountRef), a.entityId])
  )
  const rows: AccountRow[] = (accounts ?? []).map((account) => ({
    ...account,
    entityId: owner.get(key(account.connector, account.accountRef)) ?? null,
  }))
  const known = new Set(rows.map((r) => key(r.connector, r.accountRef)))
  for (const a of assignments) {
    if (known.has(key(a.connector, a.accountRef))) continue
    rows.push({
      connector: a.connector,
      accountRef: a.accountRef,
      label: a.connector,
      entityId: a.entityId,
    })
  }
  return rows
}

export function accountText(row: Pick<AccountRow, "label" | "accountRef">) {
  return `${row.label} · ${row.accountRef}`
}

/** The accounts to assign to the entity and to unassign from it to reach `selected`. */
export function assignmentDiff(
  rows: readonly AccountRow[],
  entityId: string,
  selected: ReadonlySet<string>
): { add: AccountRow[]; remove: AccountRow[] } {
  return {
    add: rows.filter(
      (row) => selected.has(accountId(row)) && row.entityId !== entityId
    ),
    remove: rows.filter(
      (row) => !selected.has(accountId(row)) && row.entityId === entityId
    ),
  }
}

export function accountId(row: Pick<AccountRow, "connector" | "accountRef">) {
  return `${row.connector}\u0000${row.accountRef}`
}

/** The timezones the Select offers; the stored zone is kept even when the engine omits it. */
export function timezoneOptions(current?: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : []
  const zones = new Set(["UTC", ...supported])
  if (current) zones.add(current)
  return [...zones].sort((a, b) => a.localeCompare(b))
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return "UTC"
  }
}

export function initialOf(name: string): string {
  const first = [...name.trim()][0]
  return first ? first.toUpperCase() : "?"
}
