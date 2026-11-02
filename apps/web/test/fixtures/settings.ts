// Synthetic fixtures for the Settings page. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.cjs).
import type {
  GateAuditChainStatus,
  GatePasskeyList,
  GatePermissionList,
} from "@eido/schemas"

const activePasskey: GatePasskeyList["passkeys"][number] = {
  fingerprint: "a".repeat(64),
  createdAt: "2026-10-01T09:00:00.000Z",
  revokedAt: null,
  current: false,
}

const currentPasskey: GatePasskeyList["passkeys"][number] = {
  fingerprint: "c2".repeat(32),
  createdAt: "2026-10-02T09:00:00.000Z",
  revokedAt: null,
  current: true,
}

const revokedPasskey: GatePasskeyList["passkeys"][number] = {
  fingerprint: "b1".repeat(32),
  createdAt: "2026-09-01T09:00:00.000Z",
  revokedAt: "2026-10-05T09:00:00.000Z",
  current: false,
}

const permissions: GatePermissionList = {
  tiers: [
    { kind: "reminder.create", tier: "auto", default: null },
    { kind: "email.send", tier: "approval", default: "approval" },
    {
      kind: "file.delete",
      tier: "forbidden",
      default: "approval",
      reason: "manifest_forbidden",
    },
  ],
  forbiddenKinds: ["file.delete"],
}

const permissionsNoForbidden: GatePermissionList = {
  tiers: [{ kind: "email.send", tier: "approval", default: "approval" }],
  forbiddenKinds: [],
}

const chainOk: GateAuditChainStatus = { ok: true, rows: 42 }
const chainOneRow: GateAuditChainStatus = { ok: true, rows: 1 }
const chainBroken: GateAuditChainStatus = {
  ok: false,
  brokenAtSeq: 7,
  reason: "prev_hash_mismatch",
}

export {
  currentPasskey,
  activePasskey,
  chainBroken,
  chainOk,
  chainOneRow,
  permissions,
  permissionsNoForbidden,
  revokedPasskey,
}
