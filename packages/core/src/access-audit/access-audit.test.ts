import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it, vi } from "vitest"
import type { GateAuditRecordRequest } from "@eido/schemas"
import {
  buildContentCopyDetail,
  buildDocumentOpenDetail,
  buildInferenceUseDetail,
  buildInstructionChangeDetail,
} from "./builders"
import { BoundedDeduplicator } from "./dedup"
import { AccessAuditError, createAccessAuditor } from "./auditor"
import {
  CONTENT_COPY_SOURCES,
  INFERENCE_TASKS,
  INSTRUCTION_TYPES,
} from "./types"
import { createProfileStore } from "../profile/store"
import { createObligationStateStore } from "../ledger/obligation-state"

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

const SENSITIVE_PROMPT = "SYNTHETIC_PROMPT_SECRET_DIAGNOSIS_42"
const SENSITIVE_CLIPBOARD = "SYNTHETIC_CLIPBOARD_SSN_000_12_3456"
const SENSITIVE_DOCUMENT = "SYNTHETIC_DOCUMENT_CONFIDENTIAL_RECORD"
const SENSITIVE_INSTRUCTION = "SYNTHETIC_INSTRUCTION_PROMPT_OVERRIDE"

describe("access audit detail builders", () => {
  it("builds document open detail with lowercase hex hash only", () => {
    const detail = buildDocumentOpenDetail({
      documentSha256: HASH_A.toUpperCase(),
    })
    expect(detail).toEqual({
      action: "access.document_open",
      subjectHash: HASH_A,
      beforeHash: null,
      afterHash: null,
    })
  })

  it("refuses a document sha256 that is not 64 hex characters", () => {
    expect(() =>
      buildDocumentOpenDetail({ documentSha256: SENSITIVE_DOCUMENT })
    ).toThrow("documentSha256 must be a 64-character lowercase hex string")
    expect(() =>
      buildDocumentOpenDetail({ documentSha256: "too-short" })
    ).toThrow("documentSha256 must be a 64-character lowercase hex string")
  })

  it("builds inference use detail for each closed task enum", () => {
    for (const task of INFERENCE_TASKS) {
      const detail = buildInferenceUseDetail({ task, modelId: "phi-3-mini" })
      expect(detail.action).toBe("access.inference_use")
      expect(detail.beforeHash).toBeNull()
      expect(detail.afterHash).toBeNull()
      expect(detail.subjectHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it("refuses an invalid inference task or invalid model id", () => {
    expect(() =>
      buildInferenceUseDetail({ task: "invalid_task" as unknown as "ask" })
    ).toThrow("Invalid inference task")

    expect(() =>
      buildInferenceUseDetail({
        task: "ask",
        modelId: "bad model with spaces & symbols!",
      })
    ).toThrow("Invalid model identifier")
  })

  it("builds content copy detail for each closed source kind enum", () => {
    for (const sourceKind of CONTENT_COPY_SOURCES) {
      const detail = buildContentCopyDetail({ sourceKind })
      expect(detail.action).toBe("access.content_copy")
      expect(detail.beforeHash).toBeNull()
      expect(detail.afterHash).toBeNull()
      expect(detail.subjectHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it("refuses an invalid content copy source kind", () => {
    expect(() =>
      buildContentCopyDetail({
        sourceKind: "clipboard" as unknown as "document",
      })
    ).toThrow("Invalid content copy source kind")
  })

  it("builds instruction change detail for each closed instruction type", () => {
    for (const instructionType of INSTRUCTION_TYPES) {
      const detail = buildInstructionChangeDetail({ instructionType })
      expect(detail.action).toBe("access.instruction_change")
      expect(detail.beforeHash).toBeNull()
      expect(detail.afterHash).toBeNull()
      expect(detail.subjectHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it("refuses an invalid instruction type", () => {
    expect(() =>
      buildInstructionChangeDetail({
        instructionType: "arbitrary_custom_rules" as unknown as "system",
      })
    ).toThrow("Invalid instruction type")
  })
})

describe("payload-free access audit and sensitive markers", () => {
  it("never contains arbitrary prompt, document, address or clipboard text in emitted audit records", async () => {
    const emitted: GateAuditRecordRequest[] = []
    const auditor = createAccessAuditor({
      audit: (entry) => {
        emitted.push(entry)
        return Promise.resolve({ seq: emitted.length })
      },
    })

    // Compute doc sha256 from document text, but pass ONLY the sha256
    const docHash = createHash("sha256")
      .update(SENSITIVE_DOCUMENT)
      .digest("hex")
    await auditor.recordDocumentOpen({ documentSha256: docHash })
    await auditor.recordInferenceUse({ task: "ask", modelId: "local-llama" })
    await auditor.recordContentCopy({ sourceKind: "document" })
    await auditor.recordInstructionChange({ instructionType: "system" })

    expect(emitted).toHaveLength(4)
    const serialized = JSON.stringify(emitted)

    // Verify none of the synthetic markers appear in the emitted audit requests
    for (const marker of [
      SENSITIVE_PROMPT,
      SENSITIVE_CLIPBOARD,
      SENSITIVE_DOCUMENT,
      SENSITIVE_INSTRUCTION,
    ]) {
      expect(serialized).not.toContain(marker)
    }

    // Verify every record contains only valid hashes and null sides
    for (const record of emitted) {
      expect(record.subjectHash).toMatch(/^[0-9a-f]{64}$/)
      expect(record.beforeHash).toBeNull()
      expect(record.afterHash).toBeNull()
    }
  })
})

describe("deduplication of repeated view events", () => {
  it("bounds repeated view events within a configured window without losing the first event", async () => {
    let now = 1_000_000
    const emitted: GateAuditRecordRequest[] = []
    const auditor = createAccessAuditor({
      audit: (entry) => {
        emitted.push(entry)
        return Promise.resolve({ seq: emitted.length })
      },
      dedupeWindowMs: 5 * 60 * 1000, // 5 minutes
      clock: () => now,
    })

    // 1. Initial view for Document A -> emitted immediately
    const first = await auditor.recordDocumentOpen({ documentSha256: HASH_A })
    expect(first).toEqual({ emitted: true, seq: 1 })
    expect(emitted).toHaveLength(1)

    // 2. 50 rapid repeated views within the 5-minute window -> all bounded (suppressed)
    for (let i = 1; i <= 50; i++) {
      now += 2000 // advance 2 seconds each time (up to 100 seconds)
      const repeat = await auditor.recordDocumentOpen({
        documentSha256: HASH_A,
      })
      expect(repeat).toEqual({ emitted: false })
    }
    expect(emitted).toHaveLength(1)

    // 3. Different document B -> emitted immediately
    const docB = await auditor.recordDocumentOpen({ documentSha256: HASH_B })
    expect(docB).toEqual({ emitted: true, seq: 2 })
    expect(emitted).toHaveLength(2)

    // 4. Document A viewed after the 5-minute window expires -> emitted again
    now += 5 * 60 * 1000 + 1 // advance past window
    const afterWindow = await auditor.recordDocumentOpen({
      documentSha256: HASH_A,
    })
    expect(afterWindow).toEqual({ emitted: true, seq: 3 })
    expect(emitted).toHaveLength(3)
  })

  it("deduplicator prunes expired entries and caps memory bounds", () => {
    let now = 1000
    const maxEntries = 5
    const dedupe = new BoundedDeduplicator(10_000, () => now, maxEntries)

    for (let i = 0; i < 10; i++) {
      now += 100
      expect(dedupe.shouldEmit(`key-${i}`)).toBe(true)
    }

    // shouldEmit for recently seen key returns false
    expect(dedupe.shouldEmit("key-9")).toBe(false)

    // After window expires, key can be emitted again
    now += 20_000
    expect(dedupe.shouldEmit("key-9")).toBe(true)
  })
})

describe("explicit audit append failure behaviors", () => {
  it("fails closed by default for all access event types when audit rejects", async () => {
    const error = new Error("Gate connection refused (503)")
    const rejectingSink = vi.fn().mockRejectedValue(error)
    const onError = vi.fn()

    const auditor = createAccessAuditor({
      audit: rejectingSink,
      onError,
      failurePolicy: "fail-closed",
    })

    await expect(
      auditor.recordDocumentOpen({ documentSha256: HASH_A })
    ).rejects.toThrow(AccessAuditError)

    await expect(auditor.recordInferenceUse({ task: "ask" })).rejects.toThrow(
      AccessAuditError
    )

    await expect(
      auditor.recordContentCopy({ sourceKind: "obligation" })
    ).rejects.toThrow(AccessAuditError)

    await expect(
      auditor.recordInstructionChange({ instructionType: "rules" })
    ).rejects.toThrow(AccessAuditError)

    expect(onError).toHaveBeenCalledTimes(4)
  })

  it("supports explicit fail-open behavior when configured", async () => {
    const error = new Error("Network timeout")
    const rejectingSink = vi.fn().mockRejectedValue(error)
    const errorsReported: unknown[] = []

    const auditor = createAccessAuditor({
      audit: rejectingSink,
      failurePolicy: "fail-open",
      onError: (err) => errorsReported.push(err),
    })

    const docResult = await auditor.recordDocumentOpen({
      documentSha256: HASH_A,
    })
    expect(docResult).toEqual({ emitted: false })

    const aiResult = await auditor.recordInferenceUse({ task: "extraction" })
    expect(aiResult).toEqual({ emitted: false })

    const copyResult = await auditor.recordContentCopy({ sourceKind: "turn" })
    expect(copyResult).toEqual({ emitted: false })

    expect(errorsReported).toHaveLength(3)
  })

  it("allows per-call failure policy override", async () => {
    const error = new Error("Gate down")
    const rejectingSink = vi.fn().mockRejectedValue(error)

    const auditor = createAccessAuditor({
      audit: rejectingSink,
      failurePolicy: "fail-closed",
    })

    // Override to fail-open for this call
    const result = await auditor.recordDocumentOpen(
      { documentSha256: HASH_A },
      { failurePolicy: "fail-open" }
    )
    expect(result).toEqual({ emitted: false })

    // Default remains fail-closed
    await expect(
      auditor.recordDocumentOpen({ documentSha256: HASH_B })
    ).rejects.toThrow(AccessAuditError)
  })

  it("invariant: security-sensitive profile and obligation writes retain fail-closed behavior", async () => {
    const db = new DatabaseSync(":memory:")
    db.exec(`
      CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT, name TEXT, tag TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE accounts (id TEXT PRIMARY KEY, entity_id TEXT, connector TEXT, account_ref TEXT, assigned_at TEXT);
      CREATE TABLE control_settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE obligations (
        id TEXT PRIMARY KEY, source_ref TEXT, recipient_ref TEXT, title TEXT,
        amount_cents INTEGER, currency TEXT, due_date TEXT, status TEXT,
        created_at TEXT, updated_at TEXT, resolved_at TEXT
      );
    `)

    const rejectingSink = vi
      .fn()
      .mockRejectedValue(new Error("Gate audit failed"))

    // Profile store fails closed
    const profile = createProfileStore(db, { audit: rejectingSink })
    await expect(
      profile.createEntity({
        kind: "individual",
        name: "Alice",
        tag: "personal",
      })
    ).rejects.toThrow()
    expect(db.prepare("SELECT COUNT(*) AS c FROM entities").get()).toEqual({
      c: 0,
    })

    // Obligation store fails closed
    db.prepare(
      `
      INSERT INTO obligations (id, source_ref, recipient_ref, title, status, created_at, updated_at)
      VALUES (1, 'ref-1', 'ref-2', 'Tax Payment', 'open', '2026-01-01', '2026-01-01')
    `
    ).run()

    const obligations = createObligationStateStore(db, { audit: rejectingSink })
    await expect(obligations.change(1, "done")).rejects.toThrow()
    expect(
      db.prepare("SELECT status FROM obligations WHERE id = 1").get()
    ).toEqual({ status: "open" })
  })
})
