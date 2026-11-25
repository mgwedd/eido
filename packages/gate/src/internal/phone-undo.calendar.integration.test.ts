import { afterEach, describe, expect, it } from "vitest"
import type { ConnectorManifest, Intent } from "@eido/schemas"
import { createExecutor } from "./executor"
import { propose } from "./intents"
import {
  auditRows,
  CALENDAR_OPS,
  loggedText,
  manifest,
  OWNER,
  setup,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"
import { InMemoryVault } from "./vault/vault"
import { BRIDGE_PASSWORD_KEY, createProtonBridge } from "./bridge/bridge"
import { createMemoryCalendarTracker, deriveEventUid } from "./bridge/calendar"
import { PROTON_CALENDAR_CONNECTOR } from "./bridge/config"
import { startFakeBridge } from "./bridge/fake-bridge"
import type { FakeBridge } from "./bridge/fake-bridge"
import { BRIDGE_WRITERS, bridgeTransport } from "./bridge/writers"
import { call, projection, signIn, undoHandler } from "./phone-undo-harness"

// Issue #416, calendar half: the phone Undo route over the real executor and the real Bridge
// calendar writers, against the fake Bridge's SMTP double. Every expected value below is written
// out by hand; the event text is synthetic.

const IDENTITY = "assistant@example.invalid"
const PASSWORD = "synthetic-bridge-password-416"
const TITLE = "private-title-4c1e"
const EDITED_TITLE = "private-edited-title-77a0"
const PLACE = "private-place-9d2b"
const EDITED_PLACE = "private-edited-place-31f8"
const NOTES = "private-notes-0be5"
const PRIVATE_TEXT = [TITLE, EDITED_TITLE, PLACE, EDITED_PLACE, NOTES]

const CREATE = {
  kind: "calendar.create",
  args: {
    entity: "Personal",
    title: TITLE,
    start: "2030-03-04T09:00:00Z",
    end: "2030-03-04T10:00:00Z",
    allDay: false,
    location: PLACE,
    description: NOTES,
  },
} as const satisfies Intent
const EVENT_UID = deriveEventUid(CREATE.args)

let s: Setup | undefined
let fake: FakeBridge | undefined
afterEach(async () => {
  s?.cleanup()
  s = undefined
  await fake?.close()
  fake = undefined
})

async function world() {
  const calendar: ConnectorManifest = {
    ...manifest(PROTON_CALENDAR_CONNECTOR, CALENDAR_OPS),
    auth: { type: "password", scopes: ["write"] },
    egress: { hosts: [] },
  }
  s = setup([calendar])
  const fixture = s
  const tracker = createMemoryCalendarTracker()
  fixture.policy.storedAttendees = (uid) =>
    tracker.has(uid)
      ? { ok: true, attendees: [OWNER] }
      : { ok: false, notFound: true }
  const bridgeDouble = await startFakeBridge({
    username: IDENTITY,
    password: PASSWORD,
  })
  fake = bridgeDouble
  const vault = new InMemoryVault()
  await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
  const bridge = createProtonBridge({
    config: {
      host: "127.0.0.1",
      imapPort: bridgeDouble.imapPort,
      smtpPort: bridgeDouble.smtpPort,
      tls: "none",
      username: IDENTITY,
      searchFolders: ["INBOX"],
    },
    vault,
  })
  const executor = createExecutor(
    fixture.db,
    BRIDGE_WRITERS,
    bridgeTransport(bridge, { tracker, ownerAddress: OWNER })
  )
  const handler = undoHandler(fixture, (id) => executor.undo(id))
  const cookie = await signIn(fixture, handler)
  async function execute(intent: Intent): Promise<string> {
    const proposed = propose(fixture.db, fixture.policy, {
      intent,
      origin: "reactive",
    })
    if (!proposed.ok) throw new Error(proposed.code)
    expect(proposed.tier).toBe("auto")
    expect((await executor.execute(proposed.intentId)).ok).toBe(true)
    return proposed.intentId
  }
  const actions = () => auditRows(fixture.db).map((row) => row.action)
  return {
    ...fixture,
    fake: bridgeDouble,
    tracker,
    handler,
    cookie,
    execute,
    actions,
  }
}

/** The calendar invite mails the double has received, as text, oldest first. */
function mails(f: { fake: FakeBridge }): string[] {
  return f.fake.sent.map((mail) => mail.data)
}

/**
 * What the route returns, Activity says and the audit chain gained when `id` is undone: a calendar
 * execution records no inverse (#416), so Undo is not offered, the route refuses it as it does any
 * execution without one, and no mail goes out.
 */
async function undoRefused(f: Awaited<ReturnType<typeof world>>, id: string) {
  expect(
    f.db.prepare("SELECT inverse_op FROM executions WHERE intent_id=?").get(id)
  ).toEqual({ inverse_op: null })
  expect((await projection(f.handler, f.cookie, id))?.undo).toBe("none")
  const before = f.actions().length
  const mailsBefore = mails(f).length
  const response = await call(f.handler, `/executions/${id}/undo`, f.cookie)
  expect(response.status).toBe(409)
  expect(f.actions().slice(before)).toEqual(["undo.refused.no_inverse"])
  expect(mails(f)).toHaveLength(mailsBefore)
  expect((await projection(f.handler, f.cookie, id))?.undo).toBe("none")
  for (const text of PRIVATE_TEXT) expect(loggedText(f.db)).not.toContain(text)
}

describe("phone Undo through the real executor and Bridge calendar writers", () => {
  it("offers no Undo for a create and sends no cancel", async () => {
    const f = await world()
    const id = await f.execute(CREATE)
    await undoRefused(f, id)
    expect(f.tracker.get(EVENT_UID)).toMatchObject({
      sequence: 0,
      lastMethod: "REQUEST",
    })
  })

  it("offers no Undo for an edit and leaves the edited event", async () => {
    const f = await world()
    await f.execute(CREATE)
    const id = await f.execute({
      kind: "calendar.edit",
      args: {
        eventUid: EVENT_UID,
        title: EDITED_TITLE,
        location: EDITED_PLACE,
      },
    })
    await undoRefused(f, id)
    expect(f.tracker.get(EVENT_UID)?.event).toMatchObject({
      title: EDITED_TITLE,
      location: EDITED_PLACE,
    })
  })

  it("offers no Undo for a delete and does not re-send the event", async () => {
    const f = await world()
    await f.execute(CREATE)
    const id = await f.execute({
      kind: "calendar.delete",
      args: { eventUid: EVENT_UID },
    })
    await undoRefused(f, id)
    expect(f.tracker.get(EVENT_UID)).toMatchObject({
      sequence: 1,
      lastMethod: "CANCEL",
    })
  })
})
