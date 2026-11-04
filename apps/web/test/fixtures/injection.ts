// Synthetic fixtures for injection-suspected tests. Imported by tests only; never by app code.
import { createHash } from "node:crypto"
import type {
  AskCitation,
  CoreApiDocumentView,
  GatePrepareApproval,
} from "@eido/schemas"
import type { PendingIntent } from "../../lib/today"

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export const flaggedIntent: PendingIntent = {
  id: "intent-flagged",
  kind: "email.reply",
  tier: "approval",
  state: "pending",
  origin: "reactive",
  createdAt: "2026-10-17T10:00:00.000Z",
  injection: {
    reasons: ["fence-tag", "hidden-characters"],
  },
}

export const cleanIntent: PendingIntent = {
  id: "intent-clean",
  kind: "email.reply",
  tier: "approval",
  state: "pending",
  origin: "reactive",
  createdAt: "2026-10-17T10:00:00.000Z",
}

export const flaggedCitation: AskCitation = {
  tag: "M1",
  documentId: "a".repeat(64),
  source: "gmail",
  sourceRef: "gm-invoice",
  title: "Invoice from Ada Quill",
  occurredAt: "2030-01-04T12:00:00Z",
  injectionSuspected: true,
  injectionReasons: ["template-marker", "boundary-confusion"],
}

export const cleanCitation: AskCitation = {
  tag: "M2",
  documentId: "b".repeat(64),
  source: "gmail",
  sourceRef: "gm-clean",
  title: "Clean email",
  occurredAt: "2030-01-04T12:00:00Z",
  injectionSuspected: false,
  injectionReasons: [],
}

export const cleanDocumentView: CoreApiDocumentView = {
  document: {
    sha256: "c".repeat(64),
    name: "Urgent wire instructions",
    source: "gmail",
    sourceRef: "gm-101",
    mime: "message/rfc822",
    type: "email",
    typeSource: "model",
    entity: {
      id: "ent-1",
      kind: "personal",
      name: "Personal",
      tag: "me",
    },
    ingestedAt: "2026-10-17T10:00:00.000Z",
    occurredAt: "2026-10-17T09:30:00.000Z",
    keyFacts: [],
  },
  lines: [
    { n: 1, start: 0, text: "From: lawyer@example.invalid" },
    { n: 2, start: 29, text: "Please find wire details attached." },
  ],
  highlight: null,
  extractions: [],
  linked: {
    obligations: [],
    documents: [],
  },
}

export const flaggedDocumentView: CoreApiDocumentView = {
  ...cleanDocumentView,
  document: {
    ...cleanDocumentView.document,
    sha256: "d".repeat(64),
    name: "Suspicious invoice instructions",
  },
}

const CLEAN_PAYLOAD = JSON.stringify({
  args: { body: "Clean reply body", to: ["alex@example.invalid"] },
  kind: "email.reply",
})

export const cleanPrepared: GatePrepareApproval = {
  intentId: "intent-clean",
  kind: "email.reply",
  origin: "reactive",
  state: "pending",
  payload: CLEAN_PAYLOAD,
  payloadHash: sha256(CLEAN_PAYLOAD),
  nonce: "n".repeat(43),
  documentIds: [],
}

const FLAGGED_PAYLOAD = JSON.stringify({
  args: { body: "Flagged reply body", to: ["alex@example.invalid"] },
  kind: "email.reply",
})

export const flaggedPrepared: GatePrepareApproval = {
  intentId: "intent-flagged",
  kind: "email.reply",
  origin: "reactive",
  state: "pending",
  payload: FLAGGED_PAYLOAD,
  payloadHash: sha256(FLAGGED_PAYLOAD),
  nonce: "m".repeat(43),
  documentIds: [],
  injection: {
    reasons: ["fence-tag", "hidden-characters"],
  },
}
