// Synthetic fixtures for the Activity page. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.cjs).
import type {
  GateAuditChainStatus,
  GateAuditPage,
  GateIntentHistory,
} from "@eido/schemas"

type Entry = GateAuditPage["entries"][number]

const INTENT_ID = "0b6f4c1e-8a2d-4f63-9e51-3c7d2a9b1f40"
const hash = (seed: string) => seed.repeat(64).slice(0, 64)

function entry(seq: number, patch: Partial<Entry> = {}): Entry {
  return {
    seq,
    ts: "2026-10-18T09:04:12.000Z",
    actor: "gate",
    displayActor: "gate",
    action: "webauthn.verify",
    target: "credential-1",
    detailHash: hash("a1b2c3d4"),
    undo: "none",
    ...patch,
  }
}

/** `count` rows, newest first, ending at `lowest`. */
function rows(count: number, lowest: number): Entry[] {
  return Array.from({ length: count }, (_, i) => entry(lowest + count - 1 - i))
}

const intentRow = entry(120, {
  actor: "approver",
  displayActor: "you",
  action: "intent.transition",
  target: INTENT_ID,
  detailHash: hash("c41a7e09"),
})
const alertRow = entry(119, {
  action: "alert.hash_mismatch",
  target: INTENT_ID,
})
const refusedRow = entry(118, { action: "policy.rejected", target: "policy-1" })
const autoRow = entry(117, {
  actor: "policy",
  displayActor: "auto",
  action: "email.markRead",
  target: "message-batch-1",
})
const olderDayRow = entry(116, { ts: "2026-10-16T08:00:00.000Z" })

const chainOk: GateAuditChainStatus = { ok: true, rows: 1286 }
const chainBroken: GateAuditChainStatus = {
  ok: false,
  brokenAtSeq: 1207,
  reason: "prev_hash_mismatch",
}

const history: GateIntentHistory = {
  intentId: INTENT_ID,
  entries: [
    {
      at: "2026-10-18T09:00:00.000Z",
      from: null,
      to: "proposed",
      actor: "data-plane",
    },
    {
      at: "2026-10-18T09:04:12.000Z",
      from: "proposed",
      to: "approved",
      actor: "approver",
      reason: "looks right",
    },
  ],
}

export {
  INTENT_ID,
  alertRow,
  autoRow,
  chainBroken,
  chainOk,
  entry,
  history,
  intentRow,
  olderDayRow,
  refusedRow,
  rows,
}
