import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, expect, test } from "vitest"
import { validateIntent } from "@eido/schemas"
import { attachment, ingest, mail, sha } from "../context/context.test-support"
import { openIndex } from "../index/schema"
import { indexedFollowUps } from "./follow-ups"

let db: DatabaseSync
beforeEach(() => {
  db = openIndex(":memory:")
})
afterEach(() => {
  db.close()
})

const message = (id: string) =>
  mail({ id, date: "2030-01-01T00:00:00Z", body: "invoice" })

test("only matching top-level Gmail messages inside the pack become targets", () => {
  ingest(db, [
    message("read-match"),
    message("outside-pack"),
    message("thread-context"),
    { ...message("proton"), source: "proton-mail" },
    { ...message("not-mail"), mime: "text/plain" },
    {
      ...attachment("attachment", "read-match", "invoice"),
      mime: "message/rfc822",
    },
  ])
  const hits = [
    "read-match",
    "outside-pack",
    "proton",
    "not-mail",
    "attachment",
    "missing",
  ].map(sha)
  const packed = new Set(
    [
      "read-match",
      "thread-context",
      "proton",
      "not-mail",
      "attachment",
      "missing",
    ].map(sha)
  )
  expect(indexedFollowUps(db, hits, packed)).toEqual([
    {
      label: "Archive matching emails",
      intent: {
        kind: "email.archive",
        connector: "gmail",
        args: { messageIds: ["read-match"] },
      },
    },
    {
      label: "Mark matching emails as read",
      intent: {
        kind: "email.markRead",
        connector: "gmail",
        args: { messageIds: ["read-match"], read: true },
      },
    },
  ])
})

test("duplicate indexed versions and repeated hits target the provider message only once", () => {
  ingest(db, [
    message("same-id"),
    { ...message("same-id"), sha256: sha("new-version") },
  ])
  const hits = [sha("same-id"), sha("new-version"), sha("same-id")]
  expect(
    indexedFollowUps(db, hits, new Set(hits)).map(
      (followUp) => followUp.intent.args
    )
  ).toEqual([
    { messageIds: ["same-id"] },
    { messageIds: ["same-id"], read: true },
  ])
})

test("batch targets are bounded to the first 50 eligible messages", () => {
  const docs = Array.from({ length: 51 }, (_, i) => message(`id-${String(i)}`))
  ingest(db, docs)
  const hits = docs.map((doc) => doc.sha256)
  const results = indexedFollowUps(db, hits, new Set(hits))
  for (const result of results) {
    expect(validateIntent(result.intent).ok).toBe(true)
    if (
      result.intent.kind !== "email.archive" &&
      result.intent.kind !== "email.markRead"
    )
      throw new Error("unexpected candidate kind")
    expect(result.intent.args.messageIds).toHaveLength(50)
    expect(result.intent.args.messageIds[0]).toBe("id-0")
    expect(result.intent.args.messageIds[49]).toBe("id-49")
  }
  expect(results.map((result) => result.intent.kind)).toEqual([
    "email.archive",
    "email.markRead",
  ])
})

test("invalid stored provider ids fail schema validation instead of exposing actions", () => {
  const doc = message("x".repeat(257))
  ingest(db, [doc])
  expect(indexedFollowUps(db, [doc.sha256], new Set([doc.sha256]))).toEqual([])
})

test("no eligible matches means no candidates", () => {
  expect(indexedFollowUps(db, [], new Set())).toEqual([])
})
