import { createServer } from "node:net"
import type { Server } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { IntentClient, IntentProposal } from "@eido/gate"
import { validateIntent } from "@eido/schemas"
import { createProtonCalendarFacade, type ProtonCalendarFacade } from "./facade"
import { ProtonCalendarConfigError } from "./config"
import { createMemorySentRecordStore } from "./sent-record"

function fakeIntents() {
  const proposals: IntentProposal[] = []
  const client: IntentClient = {
    propose: (proposal) => {
      proposals.push(proposal)
      return Promise.resolve({
        id: `intent-${proposals.length}`,
        tier: "auto",
        state: "proposed",
      })
    },
    restoreTrash: () => Promise.reject(new Error("not used")),
    status: () => Promise.reject(new Error("not used")),
    history: () => Promise.reject(new Error("not used")),
    listPending: () => Promise.reject(new Error("not used")),
    getConnectorHealth: () => Promise.resolve([]),
  }
  return { client, proposals }
}

describe("Proton Calendar Facade", () => {
  let fakeSmtp: Server
  let smtpConnections = 0
  let smtpPort = 0
  let intents: ReturnType<typeof fakeIntents>
  let facade: ProtonCalendarFacade
  const sentRecord = createMemorySentRecordStore()

  beforeEach(async () => {
    intents = fakeIntents()
    smtpConnections = 0

    // Spin up a fake TCP SMTP listener on a free port to verify zero network activity
    await new Promise<void>((resolve) => {
      fakeSmtp = createServer(() => {
        smtpConnections++
      })
      fakeSmtp.listen(0, "127.0.0.1", () => {
        const addr = fakeSmtp.address()
        if (typeof addr === "object" && addr !== null) {
          smtpPort = addr.port
        }
        resolve()
      })
    })

    facade = createProtonCalendarFacade({
      config: {
        bridgeHost: "127.0.0.1",
        smtpPort,
        assistantAddress: "assistant@astrealabs.com",
        ownerAddress: "owner@astrealabs.com",
      },
      intents: intents.client,
      sentRecord,
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      fakeSmtp.close(() => resolve())
    })
  })

  it("fails closed when assistant identity equals owner recipient address", () => {
    expect(() =>
      createProtonCalendarFacade({
        config: {
          assistantAddress: "owner@astrealabs.com",
          ownerAddress: "owner@astrealabs.com",
        },
        intents: intents.client,
      })
    ).toThrow(ProtonCalendarConfigError)
  })

  it("every write verb returns an intent ID and sends nothing (fake SMTP records zero messages)", async () => {
    // 1. event_create
    const createResult = await facade.event_create({
      entity: "Astrea Labs LLC",
      title: "Quarterly Planning",
      start: "2026-11-25T10:00:00Z",
      end: "2026-11-25T11:00:00Z",
      allDay: false,
    })

    expect(createResult.intentId).toBe("intent-1")
    expect(createResult.eventUid).toBeDefined()
    expect(intents.proposals).toHaveLength(1)
    expect(validateIntent(intents.proposals[0]?.intent).ok).toBe(true)
    expect(intents.proposals[0]?.intent).toMatchObject({
      kind: "calendar.create",
      args: { title: "Quarterly Planning" },
    })
    expect(smtpConnections).toBe(0)

    // 2. event_update
    const updateResult = await facade.event_update({
      eventUid: createResult.eventUid!,
      title: "Quarterly Planning - Rescheduled",
    })

    expect(updateResult.intentId).toBe("intent-2")
    expect(intents.proposals).toHaveLength(2)
    expect(validateIntent(intents.proposals[1]?.intent).ok).toBe(true)
    expect(intents.proposals[1]?.intent).toMatchObject({
      kind: "calendar.edit",
      args: {
        eventUid: createResult.eventUid,
        title: "Quarterly Planning - Rescheduled",
      },
    })
    expect(smtpConnections).toBe(0)

    // 3. event_delete
    const deleteResult = await facade.event_delete({
      eventUid: createResult.eventUid!,
    })

    expect(deleteResult.intentId).toBe("intent-3")
    expect(intents.proposals).toHaveLength(3)
    expect(validateIntent(intents.proposals[2]?.intent).ok).toBe(true)
    expect(intents.proposals[2]?.intent).toMatchObject({
      kind: "calendar.delete",
      args: { eventUid: createResult.eventUid },
    })
    // Verified: Zero SMTP connections recorded
    expect(smtpConnections).toBe(0)
  })
})
