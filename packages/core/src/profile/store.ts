import { createHash, randomUUID } from "node:crypto"
import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import {
  validateProfileAccountAssignment,
  validateProfileEntityInput,
  validateProfileEntityPatch,
  validateProfileUpdate,
} from "@eido/schemas"
import type { ProfileWorkingHours } from "@eido/schemas"
import { ProfileError } from "./errors"
import type {
  AccountAssignment,
  Entity,
  EntityKind,
  Profile,
  ProfileAuditAction,
  ProfileAuditSink,
} from "./types"
import {
  addressIssues,
  cleanName,
  cleanTag,
  ensure,
  isIanaTimezone,
  workingHoursIssues,
} from "./validate"

type Row = Record<string, unknown>

/** Active and waiting calls together; a full queue refuses work before retaining its arguments. */
export const MAX_PROFILE_CALLS = 32

export interface ProfileStoreOptions {
  /** Receives one entry per entity or assignment change. Required: those changes are audited. */
  audit: ProfileAuditSink
  now?: () => Date
}

/**
 * Every method runs alone: calls are queued and run one at a time, so a read never sees the
 * statements of a write whose audit call is still in flight, and a write's transaction never
 * holds another request's statements.
 */
export interface ProfileStore {
  getProfile(): Promise<Profile | null>
  updateProfile(input: unknown): Promise<Profile>
  listEntities(): Promise<Entity[]>
  createEntity(input: unknown): Promise<Entity>
  updateEntity(id: string, patch: unknown): Promise<Entity>
  deleteEntity(id: string): Promise<void>
  assignAccount(input: unknown): Promise<AccountAssignment>
  unassignAccount(connector: string, accountRef: string): Promise<boolean>
  listAssignments(): Promise<AccountAssignment[]>
  entityForAccount(
    connector: string,
    accountRef: string
  ): Promise<Entity | null>
  entityByTag(tag: string): Promise<Entity | null>
  /** The entity given to a document whose connector account has no assignment, or null. */
  getDefaultEntityId(): Promise<string | null>
  /** Sets (an existing entity's id) or clears (null) the default entity; returns the new value. */
  setDefaultEntityId(id: string | null): Promise<string | null>
  /** Resolves once every call queued so far, and any queued while waiting, has settled. */
  drain(): Promise<void>
}

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

const text = (row: Row, key: string): string => String(row[key])

function toEntity(row: Row): Entity {
  return {
    id: text(row, "id"),
    // The kind column has a CHECK constraint limiting it to EntityKind.
    kind: text(row, "kind") as EntityKind,
    name: text(row, "name"),
    tag: text(row, "tag"),
    createdAt: text(row, "created_at"),
  }
}

/**
 * The default entity stored in `db`, or null. The data plane reads it before the profile store
 * exists, to open eido-data.db with it (`openDataDb`'s `defaultEntityId`).
 */
export function readDefaultEntityId(db: DatabaseSync): string | null {
  const row = db
    .prepare("SELECT entity_id FROM default_entity WHERE id = 1")
    .get()
  return row === undefined ? null : String(row["entity_id"])
}

function invalid(issues: string[]): ProfileError {
  return new ProfileError("invalid", "invalid input", issues)
}

export function createProfileStore(
  db: DatabaseSync,
  options: ProfileStoreOptions
): ProfileStore {
  const now = (): string => (options.now?.() ?? new Date()).toISOString()
  const all = (sql: string, ...params: SQLInputValue[]): Row[] =>
    db.prepare(sql).all(...params)
  const one = (sql: string, ...params: SQLInputValue[]): Row | undefined =>
    db.prepare(sql).get(...params)
  const run = (sql: string, ...params: SQLInputValue[]): void => {
    db.prepare(sql).run(...params)
  }

  // The tail of the queue of store calls. node:sqlite has one connection and the audit call is
  // awaited inside the transaction, so without the queue a second request's statements would
  // run inside the first one's open transaction. The audit client's timeout (2 s) bounds how
  // long one call holds the queue.
  let tail: Promise<unknown> = Promise.resolve()
  let admitted = 0
  function serialized<A extends unknown[], T>(
    work: (...args: A) => T | Promise<T>
  ): (...args: A) => Promise<T> {
    return (...args) => {
      if (admitted >= MAX_PROFILE_CALLS) {
        return Promise.reject(new ProfileError("busy", "profile store busy"))
      }
      admitted++
      const result = tail.then(() => work(...args))
      tail = result.then(
        () => {
          admitted--
        },
        () => {
          admitted--
        }
      )
      return result
    }
  }

  async function transaction<T>(work: () => T | Promise<T>): Promise<T> {
    db.exec("BEGIN IMMEDIATE")
    try {
      const result = await work()
      db.exec("COMMIT")
      return result
    } catch (error) {
      // A failed COMMIT may already have ended the transaction; a second error here would hide
      // the first.
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    }
  }

  const record = (field: string, before: unknown, after: unknown): void =>
    run(
      "INSERT INTO profile_history (at, field, old_json, new_json) VALUES (?, ?, ?, ?)",
      now(),
      field,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after)
    )

  const audit = (
    action: ProfileAuditAction,
    subject: unknown,
    before: unknown,
    after: unknown
  ): Promise<unknown> =>
    options.audit({
      action,
      subjectHash: sha256(subject),
      beforeHash: before === null ? null : sha256(before),
      afterHash: after === null ? null : sha256(after),
    })

  function getProfile(): Profile | null {
    const row = one("SELECT * FROM profile WHERE id = 1")
    if (!row) return null
    return {
      displayName: text(row, "display_name"),
      timezone: text(row, "timezone"),
      // Written only by updateProfile, as validated JSON.
      workingHours: JSON.parse(
        text(row, "working_hours_json")
      ) as ProfileWorkingHours,
      signature: text(row, "signature"),
      addresses: all(
        "SELECT address, label FROM profile_addresses ORDER BY position"
      ).map((r) => ({ address: text(r, "address"), label: text(r, "label") })),
      updatedAt: text(row, "updated_at"),
    }
  }

  async function updateProfile(input: unknown): Promise<Profile> {
    const patch = ensure(validateProfileUpdate(input))
    const current = getProfile()
    const issues: string[] = []

    const displayName = patch.displayName?.trim() ?? current?.displayName
    if (displayName === undefined || displayName === "") {
      issues.push("displayName: required and not empty")
    }
    const timezone = patch.timezone ?? current?.timezone
    if (timezone === undefined) issues.push("timezone: required")
    else if (!isIanaTimezone(timezone))
      issues.push("timezone: not an IANA zone")
    const workingHours = patch.workingHours ?? current?.workingHours ?? {}
    issues.push(...workingHoursIssues(workingHours))
    const addresses = addressIssues(patch.addresses ?? current?.addresses ?? [])
    issues.push(...addresses.issues)
    if (
      issues.length > 0 ||
      displayName === undefined ||
      timezone === undefined
    ) {
      throw invalid(issues)
    }
    const signature = patch.signature ?? current?.signature ?? ""

    return transaction(() => {
      const next = {
        displayName,
        timezone,
        workingHours,
        signature,
        addresses: addresses.clean,
      }
      const before = current ? { ...current, updatedAt: undefined } : null
      for (const field of Object.keys(next) as (keyof typeof next)[]) {
        const old = before ? before[field] : null
        if (JSON.stringify(old) !== JSON.stringify(next[field])) {
          record(`profile.${field}`, old, next[field])
        }
      }
      run(
        `INSERT INTO profile (id, display_name, timezone, working_hours_json, signature, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
           timezone = excluded.timezone, working_hours_json = excluded.working_hours_json,
           signature = excluded.signature, updated_at = excluded.updated_at`,
        displayName,
        timezone,
        JSON.stringify(workingHours),
        signature,
        now()
      )
      run("DELETE FROM profile_addresses")
      addresses.clean.forEach((entry, position) =>
        run(
          "INSERT INTO profile_addresses (address, label, position) VALUES (?, ?, ?)",
          entry.address,
          entry.label,
          position
        )
      )
      const saved = getProfile()
      // Just written above.
      if (!saved) throw new Error("profile missing after write")
      return saved
    })
  }

  const entityById = (id: string): Entity | null => {
    const row = one("SELECT * FROM entities WHERE id = ?", id)
    return row ? toEntity(row) : null
  }

  function checkUnique(name: string, tag: string, exceptId: string): void {
    if (
      one("SELECT 1 FROM entities WHERE name = ? AND id <> ?", name, exceptId)
    )
      throw new ProfileError(
        "duplicate_name",
        "an entity with this name exists"
      )
    if (one("SELECT 1 FROM entities WHERE tag = ? AND id <> ?", tag, exceptId))
      throw new ProfileError("duplicate_tag", "an entity with this tag exists")
  }

  function cleanNameAndTag(
    name: string,
    tag: string
  ): { name: string; tag: string } {
    const issues: string[] = []
    const cleanedName = cleanName(name)
    const cleanedTag = cleanTag(tag)
    if (cleanedName === null) issues.push("name: not empty, single line")
    if (cleanedTag === null) {
      issues.push("tag: 1 to 24 characters, no brackets or line breaks")
    }
    if (cleanedName === null || cleanedTag === null) throw invalid(issues)
    return { name: cleanedName, tag: cleanedTag }
  }

  async function createEntity(input: unknown): Promise<Entity> {
    const value = ensure(validateProfileEntityInput(input))
    const { name, tag } = cleanNameAndTag(value.name, value.tag)
    return transaction(async () => {
      const entity: Entity = {
        id: randomUUID(),
        kind: value.kind,
        name,
        tag,
        createdAt: now(),
      }
      checkUnique(name, tag, entity.id)
      run(
        "INSERT INTO entities (id, kind, name, tag, created_at) VALUES (?, ?, ?, ?, ?)",
        entity.id,
        entity.kind,
        entity.name,
        entity.tag,
        entity.createdAt
      )
      record("entity.create", null, entity)
      await audit("entity.create", entity.id, null, entity)
      return entity
    })
  }

  async function updateEntity(
    id: string,
    patchInput: unknown
  ): Promise<Entity> {
    const patch = ensure(validateProfileEntityPatch(patchInput))
    return transaction(async () => {
      const before = entityById(id)
      if (!before) throw new ProfileError("not_found", "no such entity")
      const { name, tag } = cleanNameAndTag(
        patch.name ?? before.name,
        patch.tag ?? before.tag
      )
      checkUnique(name, tag, id)
      const after: Entity = { ...before, name, tag }
      if (name === before.name && tag === before.tag) return before
      run("UPDATE entities SET name = ?, tag = ? WHERE id = ?", name, tag, id)
      record("entity.update", before, after)
      await audit("entity.update", id, before, after)
      return after
    })
  }

  async function deleteEntity(id: string): Promise<void> {
    await transaction(async () => {
      const before = entityById(id)
      if (!before) throw new ProfileError("not_found", "no such entity")
      const references = [
        ["documents", "SELECT 1 FROM documents WHERE entity_id = ? LIMIT 1"],
        [
          "entity_assignments",
          "SELECT 1 FROM entity_assignments WHERE entity_id = ? LIMIT 1",
        ],
        ["default_entity", "SELECT 1 FROM default_entity WHERE entity_id = ?"],
        // The obligations table exists once the ledger schema is applied (openDataDb).
        ...(one(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'obligations'"
        )
          ? [
              [
                "obligations",
                "SELECT 1 FROM obligations WHERE entity_id = ? LIMIT 1",
              ],
            ]
          : []),
      ]
        .filter(([, sql]) => one(sql ?? "", id) !== undefined)
        .map(([table]) => table ?? "")
      if (references.length > 0) {
        throw new ProfileError(
          "entity_in_use",
          "entity is still referenced",
          references
        )
      }
      run("DELETE FROM entities WHERE id = ?", id)
      record("entity.delete", before, null)
      await audit("entity.delete", id, before, null)
    })
  }

  async function setDefaultEntityId(id: string | null): Promise<string | null> {
    return transaction(() => {
      const before = readDefaultEntityId(db)
      if (id === before) return before
      if (id === null) {
        run("DELETE FROM default_entity WHERE id = 1")
      } else {
        if (!entityById(id))
          throw new ProfileError("not_found", "no such entity")
        run(
          `INSERT INTO default_entity (id, entity_id) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET entity_id = excluded.entity_id`,
          id
        )
      }
      record("profile.defaultEntityId", before, id)
      return id
    })
  }

  function assignmentOf(
    connector: string,
    accountRef: string
  ): AccountAssignment | null {
    const row = one(
      "SELECT entity_id FROM entity_assignments WHERE connector = ? AND account_ref = ?",
      connector,
      accountRef
    )
    return row
      ? { connector, accountRef, entityId: text(row, "entity_id") }
      : null
  }

  async function assignAccount(input: unknown): Promise<AccountAssignment> {
    const value = ensure(validateProfileAccountAssignment(input))
    return transaction(async () => {
      if (!entityById(value.entityId)) {
        throw new ProfileError("not_found", "no such entity")
      }
      // Built field by field, in the order assignmentOf reads it back, so the hash of a stored
      // assignment does not depend on the key order the client sent.
      const after: AccountAssignment = {
        connector: value.connector,
        accountRef: value.accountRef,
        entityId: value.entityId,
      }
      const before = assignmentOf(after.connector, after.accountRef)
      if (before?.entityId === after.entityId) return before
      run(
        `INSERT INTO entity_assignments (connector, account_ref, entity_id) VALUES (?, ?, ?)
         ON CONFLICT(connector, account_ref) DO UPDATE SET entity_id = excluded.entity_id`,
        after.connector,
        after.accountRef,
        after.entityId
      )
      record("assignment", before, after)
      await audit(
        "account.assign",
        [after.connector, after.accountRef],
        before,
        after
      )
      return after
    })
  }

  async function unassignAccount(
    connector: string,
    accountRef: string
  ): Promise<boolean> {
    return transaction(async () => {
      const before = assignmentOf(connector, accountRef)
      if (!before) return false
      run(
        "DELETE FROM entity_assignments WHERE connector = ? AND account_ref = ?",
        connector,
        accountRef
      )
      record("assignment", before, null)
      await audit("account.unassign", [connector, accountRef], before, null)
      return true
    })
  }

  return {
    getProfile: serialized(getProfile),
    updateProfile: serialized(updateProfile),
    listEntities: serialized(() =>
      all("SELECT * FROM entities ORDER BY name COLLATE NOCASE").map(toEntity)
    ),
    createEntity: serialized(createEntity),
    updateEntity: serialized(updateEntity),
    deleteEntity: serialized(deleteEntity),
    assignAccount: serialized(assignAccount),
    unassignAccount: serialized(unassignAccount),
    listAssignments: serialized(() =>
      all(
        "SELECT connector, account_ref, entity_id FROM entity_assignments ORDER BY connector, account_ref"
      ).map((r) => ({
        connector: text(r, "connector"),
        accountRef: text(r, "account_ref"),
        entityId: text(r, "entity_id"),
      }))
    ),
    entityForAccount: serialized((connector: string, accountRef: string) => {
      const row = one(
        `SELECT e.* FROM entities e JOIN entity_assignments a ON a.entity_id = e.id
         WHERE a.connector = ? AND a.account_ref = ?`,
        connector,
        accountRef
      )
      return row ? toEntity(row) : null
    }),
    entityByTag: serialized((tag: string) => {
      const row = one("SELECT * FROM entities WHERE tag = ?", tag)
      return row ? toEntity(row) : null
    }),
    getDefaultEntityId: serialized(() => readDefaultEntityId(db)),
    setDefaultEntityId: serialized(setDefaultEntityId),
    drain: async () => {
      for (let settled = tail; ; settled = tail) {
        await settled
        if (settled === tail) return
      }
    },
  }
}
