import type { GateAuditRecordRequest, ProfileWorkingHours } from "@eido/schemas"

export type EntityKind = "personal" | "property" | "company"

export interface Profile {
  displayName: string
  timezone: string
  workingHours: ProfileWorkingHours
  signature: string
  /** The email addresses Eido acts for, in the owner's order. */
  addresses: { address: string; label: string }[]
  updatedAt: string
}

export interface Entity {
  id: string
  kind: EntityKind
  name: string
  tag: string
  createdAt: string
}

export interface AccountAssignment {
  connector: string
  accountRef: string
  entityId: string
}

/** The audited entity and assignment changes; the gate's POST /audit takes the same actions. */
export type ProfileAuditAction = GateAuditRecordRequest["action"]

/**
 * One audit entry for an entity or assignment change, the body of the gate's POST /audit.
 * Hashes only (hex SHA-256 of `JSON.stringify` of the record, whose keys the store
 * always builds in the same order): no name, tag, connector or account reference in clear.
 */
export type ProfileAuditEntry = GateAuditRecordRequest

/**
 * Where audit entries go. The data plane cannot write the gate's audit log; the process entry
 * wires this to `createAuditClient(...).record`, which asks the gate to append the entry (POST
 * /audit, #181). It is awaited inside the write's transaction, so a sink that rejects (the gate
 * refused the entry, could not be reached, or did not answer in time) rolls the change back and
 * an unaudited change never commits.
 */
export type ProfileAuditSink = (entry: ProfileAuditEntry) => Promise<unknown>
