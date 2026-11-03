import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"

import { verifyAuditChain } from "./audit-chain.ts"
import {
  AUDIT_TABLE,
  CHAIN_ROW_1,
  CHAIN_ROW_2,
  insertAudit,
} from "./test-support.ts"

function chain(rows: (readonly (string | number)[])[]): DatabaseSync {
  const db = new DatabaseSync(":memory:")
  db.exec(AUDIT_TABLE)
  for (const row of rows) insertAudit(db, row)
  return db
}

test("a chain whose hashes were computed independently verifies", () => {
  expect(verifyAuditChain(chain([CHAIN_ROW_1, CHAIN_ROW_2]))).toEqual({
    ok: true,
    rows: 2,
  })
})

test("an empty log verifies with zero rows", () => {
  expect(verifyAuditChain(chain([]))).toEqual({ ok: true, rows: 0 })
})

test("a changed field in an earlier row breaks the link to the next", () => {
  const tampered = [
    CHAIN_ROW_1[0],
    CHAIN_ROW_1[1],
    "gate",
    "intent.reject",
    ...CHAIN_ROW_1.slice(4),
  ]
  expect(verifyAuditChain(chain([tampered, CHAIN_ROW_2]))).toEqual({
    ok: false,
    brokenAtSeq: 2,
    reason: "prev_hash mismatch",
  })
})

test("a first row that does not start from zeros is a bad genesis", () => {
  const row = [...CHAIN_ROW_1.slice(0, 6), "f".repeat(64)]
  expect(verifyAuditChain(chain([row]))).toEqual({
    ok: false,
    brokenAtSeq: 1,
    reason: "bad genesis",
  })
})

test("a missing row is a sequence gap", () => {
  const db = chain([CHAIN_ROW_2])
  expect(verifyAuditChain(db)).toEqual({
    ok: false,
    brokenAtSeq: 2,
    reason: "sequence gap",
  })
})
