import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ConnectorManifest, Intent } from "@eido/schemas"
import { beginRegistration, registerCredential } from "../credentials"
import { issueNonce, verifyApproval } from "../approvals"
import { createExecutor } from "../executor"
import { propose } from "../intents"
import { intentTier, type AttendeeRead } from "../policy"
import {
  OWNER,
  WEBAUTHN,
  assertion,
  deviceChallenge,
  registration,
  setup,
  testAuthenticator,
  type Setup,
  type TestAuthenticator,
} from "../test-fixtures"
import { InMemoryVault } from "../vault/vault"
import { BRIDGE_PASSWORD_KEY, createProtonBridge } from "./bridge"
import { PROTON_CALENDAR_CONNECTOR } from "./config"
import { startFakeBridge, type FakeBridge } from "./fake-bridge"
import {
  createMemoryCalendarTracker,
  deriveEventUid,
  type CalendarTracker,
} from "./calendar"
import { BRIDGE_WRITERS, bridgeTransport } from "./writers"

const USER = "assistant@example.invalid"
const PASSWORD = "synthetic-bridge-password-1234"

function calendarManifest(name = PROTON_CALENDAR_CONNECTOR): ConnectorManifest {
  return {
    name,
    version: 1,
    description: "Proton Calendar",
    auth: { type: "password", scopes: ["bridge-password"] },
    egress: { hosts: [] },
    operations: [
      {
        name: "event_create",
        effect: "write",
        reversibility: "reversible",
        defaultTier: "auto",
        intentKind: "calendar.create",
        sensitivity: "sensitive",
        untrustedOutput: false,
        authScopes: ["bridge-password"],
      },
      {
        name: "event_update",
        effect: "write",
        reversibility: "reversible",
        defaultTier: "auto",
        intentKind: "calendar.edit",
        sensitivity: "sensitive",
        untrustedOutput: false,
        authScopes: ["bridge-password"],
      },
      {
        name: "event_delete",
        effect: "write",
        reversibility: "reversible",
        defaultTier: "auto",
        intentKind: "calendar.delete",
        sensitivity: "sensitive",
        untrustedOutput: false,
        authScopes: ["bridge-password"],
      },
    ],
    triggers: [],
    ledgerMapping: { source: "proton-calendar", refField: "event_uid" },
    health: {
      backoff: { baseMs: 1000, maxMs: 300_000, jitter: true },
      breaker: { failureThreshold: 3, halfOpenProbeAfterMs: 60_000 },
    },
  }
}

describe("Proton Calendar Gate Execution & Policy", () => {
  let s: Setup | undefined
  let fake: FakeBridge | undefined
  let tracker: CalendarTracker

  afterEach(async () => {
    s?.cleanup()
    s = undefined
    await fake?.close()
    fake = undefined
  })

  beforeEach(() => {
    tracker = createMemoryCalendarTracker()
  })

  type TestWorld = {
    db: DatabaseSync
    fake: FakeBridge
    auth: TestAuthenticator
    executor: ReturnType<typeof createExecutor>
    propose: (intent: Intent) => {
      intentId: string
      tier: string
      state: string
    }
  }

  async function createWorld(
    storedEvents: Map<string, { attendees: string[] }> = new Map()
  ): Promise<TestWorld> {
    const calendarM = calendarManifest()
    s = setup([calendarM])
    const db = s.db

    // Configure storedAttendees on policy
    s.policy.storedAttendees = (eventUid: string): AttendeeRead => {
      const found = storedEvents.get(eventUid)
      if (!found) return { ok: false, notFound: true }
      return { ok: true, attendees: found.attendees }
    }

    fake = await startFakeBridge({
      username: USER,
      password: PASSWORD,
    })

    const vault = new InMemoryVault()
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)

    const bridge = createProtonBridge({
      config: {
        host: "127.0.0.1",
        imapPort: fake.imapPort,
        smtpPort: fake.smtpPort,
        tls: "none",
        username: USER,
        searchFolders: ["INBOX"],
      },
      vault,
    })

    const transport = bridgeTransport(bridge, {
      tracker,
      ownerAddress: OWNER,
    })

    const executor = createExecutor(db, BRIDGE_WRITERS, transport)
    const auth = testAuthenticator()

    const begun = beginRegistration(db, "admin")
    if (begun.ok) {
      registerCredential(
        db,
        WEBAUTHN,
        "admin",
        registration(auth, begun.challenge)
      )
    }

    return {
      db,
      fake,
      auth,
      executor,
      propose: (intent) => {
        const res = propose(db, s!.policy, { intent, origin: "task" })
        if (!res.ok) throw new Error(`proposal failed: ${res.code}`)
        return { intentId: res.intentId, tier: res.tier, state: res.state }
      },
    }
  }

  function approveIntent(w: TestWorld, id: string): void {
    const prepared = issueNonce(w.db, id)
    if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`)
    const result = verifyApproval(w.db, WEBAUTHN, {
      intentId: id,
      nonce: prepared.nonce,
      assertion: assertion(
        w.auth,
        deviceChallenge(prepared.payloadHash, id, prepared.nonce)
      ),
    })
    if (!result.ok) throw new Error(`approval refused: ${result.error}`)
  }

  describe("Tier Policy (Criteria 5, 6, 7 Table-Driven)", () => {
    it("table-driven tests for attendees, createdByEido, and operation", async () => {
      const stored = new Map<string, { attendees: string[] }>()
      const knownUidOwner = "eido-cal-known-owner"
      const knownUidGuest = "eido-cal-known-guest"
      stored.set(knownUidOwner, { attendees: [OWNER] })
      stored.set(knownUidGuest, { attendees: [OWNER, "guest@example.invalid"] })

      const w = await createWorld(stored)

      type Case = {
        name: string
        intent: Intent
        expectedTier: "auto" | "approval" | "forbidden"
        expectedReason?: string
      }

      const cases: Case[] = [
        // Create
        {
          name: "create owner only -> auto",
          intent: {
            kind: "calendar.create",
            args: {
              entity: "Astrea Labs LLC",
              title: "Solo Sync",
              start: "2026-11-20T10:00:00Z",
              end: "2026-11-20T11:00:00Z",
              allDay: false,
              guests: [],
            },
          },
          expectedTier: "auto",
        },
        {
          name: "create with owner address in guests -> auto",
          intent: {
            kind: "calendar.create",
            args: {
              entity: "Astrea Labs LLC",
              title: "Solo Sync with self",
              start: "2026-11-20T10:00:00Z",
              end: "2026-11-20T11:00:00Z",
              allDay: false,
              guests: [OWNER],
            },
          },
          expectedTier: "auto",
        },
        {
          name: "create with third party guest -> approval",
          intent: {
            kind: "calendar.create",
            args: {
              entity: "Astrea Labs LLC",
              title: "Meeting with Partner",
              start: "2026-11-20T10:00:00Z",
              end: "2026-11-20T11:00:00Z",
              allDay: false,
              guests: ["partner@example.invalid"],
            },
          },
          expectedTier: "approval",
        },

        // Edit
        {
          name: "edit owner-only known event without new guests -> auto",
          intent: {
            kind: "calendar.edit",
            args: {
              eventUid: knownUidOwner,
              title: "Updated Solo Sync",
            },
          },
          expectedTier: "auto",
        },
        {
          name: "edit owner-only known event adding third party guest -> approval",
          intent: {
            kind: "calendar.edit",
            args: {
              eventUid: knownUidOwner,
              guests: ["thirdparty@example.invalid"],
            },
          },
          expectedTier: "approval",
        },
        {
          name: "edit event with stored guest -> approval",
          intent: {
            kind: "calendar.edit",
            args: {
              eventUid: knownUidGuest,
              title: "Updated Guest Meeting",
            },
          },
          expectedTier: "approval",
        },
        {
          name: "edit of unknown event (not created by Eido) -> forbidden(event_not_found)",
          intent: {
            kind: "calendar.edit",
            args: {
              eventUid: "unknown-external-uid",
              title: "Hacked Event",
            },
          },
          expectedTier: "forbidden",
          expectedReason: "event_not_found",
        },

        // Delete
        {
          name: "delete owner-only known event -> auto",
          intent: {
            kind: "calendar.delete",
            args: {
              eventUid: knownUidOwner,
            },
          },
          expectedTier: "auto",
        },
        {
          name: "delete event with stored guest -> approval",
          intent: {
            kind: "calendar.delete",
            args: {
              eventUid: knownUidGuest,
            },
          },
          expectedTier: "approval",
        },
        {
          name: "delete of unknown event (not created by Eido) -> forbidden(event_not_found)",
          intent: {
            kind: "calendar.delete",
            args: {
              eventUid: "unknown-external-uid-2",
            },
          },
          expectedTier: "forbidden",
          expectedReason: "event_not_found",
        },
      ]

      for (const tc of cases) {
        const decision = intentTier(w.db, s!.policy, tc.intent)
        expect(decision.tier, tc.name).toBe(tc.expectedTier)
        if (tc.expectedReason) {
          expect("reason" in decision && decision.reason, tc.name).toBe(
            tc.expectedReason
          )
        }
      }
    })
  })

  describe("Executor Path & Third-Party Protection (Criterion 8)", () => {
    it("refuses to send to third parties without an approved intent, and sends once approved", async () => {
      const w = await createWorld()

      const intent: Intent = {
        kind: "calendar.create",
        args: {
          entity: "Astrea Labs LLC",
          title: "Confidential Pitch",
          start: "2026-11-22T15:00:00Z",
          end: "2026-11-22T16:00:00Z",
          allDay: false,
          guests: ["investor@example.invalid"],
        },
      }

      // Propose intent: tier is approval, state is pending
      const proposal = w.propose(intent)
      expect(proposal.tier).toBe("approval")
      expect(proposal.state).toBe("pending")

      // Attempt to execute unapproved intent: executor MUST refuse
      const unapprovedRun = await w.executor.execute(proposal.intentId)
      expect(unapprovedRun.ok).toBe(false)
      expect(unapprovedRun).toMatchObject({ code: "invalid_state" })

      // Fake SMTP server must record zero sent messages
      expect(w.fake.sent).toHaveLength(0)

      // Now approve the intent
      approveIntent(w, proposal.intentId)

      // Execute approved intent: should now succeed
      const approvedRun = await w.executor.execute(proposal.intentId)
      expect(approvedRun.ok).toBe(true)

      // Fake SMTP server records the sent message with both recipients
      expect(w.fake.sent).toHaveLength(1)
      const sent = w.fake.sent[0]!
      expect(sent.to).toContain(OWNER)
      expect(sent.to).toContain("investor@example.invalid")
      expect(sent.data).toContain("METHOD:REQUEST")
      expect(sent.data).toContain("STATUS:CONFIRMED")
      expect(sent.data).toContain("Confidential Pitch")
    })
  })

  describe("Undo Execution (Criterion 2)", () => {
    it("undo of create produces METHOD:CANCEL with higher sequence; undo of edit re-sends prior body with higher sequence", async () => {
      const stored = new Map<string, { attendees: string[] }>()
      const w = await createWorld(stored)

      // 1. Create an auto-tier owner-only event
      const createIntent: Intent = {
        kind: "calendar.create",
        args: {
          entity: "Personal",
          title: "Dentist",
          start: "2026-11-30T09:00:00Z",
          end: "2026-11-30T10:00:00Z",
          allDay: false,
          location: "Dental Clinic",
        },
      }
      const createProp = w.propose(createIntent)
      expect(createProp.tier).toBe("auto")

      const uid = deriveEventUid(createIntent.args)
      stored.set(uid, { attendees: [OWNER] })

      // Execute create @ sequence 0
      const execCreate = await w.executor.execute(createProp.intentId)
      expect(execCreate.ok).toBe(true)
      expect(w.fake.sent).toHaveLength(1)
      expect(w.fake.sent[0]!.data).toContain("SEQUENCE:0")
      expect(w.fake.sent[0]!.data).toContain("METHOD:REQUEST")

      // 2. Undo create -> executes inverse METHOD:CANCEL with higher sequence (1)
      const undoCreate = await w.executor.undo(createProp.intentId)
      if (!undoCreate.ok) console.log("undoCreate error:", undoCreate)
      expect(undoCreate.ok).toBe(true)
      expect(w.fake.sent).toHaveLength(2)
      expect(w.fake.sent[1]!.data).toContain("SEQUENCE:1")
      expect(w.fake.sent[1]!.data).toContain("METHOD:CANCEL")
      expect(w.fake.sent[1]!.data).toContain("STATUS:CANCELLED")
      expect(w.fake.sent[1]!.data).toContain(`UID:${uid}`)

      // 3. Edit test: Create a second event and edit it
      const editBaseIntent: Intent = {
        kind: "calendar.create",
        args: {
          entity: "Astrea Labs LLC",
          title: "Quarterly Review",
          start: "2026-12-01T14:00:00Z",
          end: "2026-12-01T15:00:00Z",
          allDay: false,
          location: "Main Boardroom",
        },
      }
      const editBaseProp = w.propose(editBaseIntent)
      const editBaseUid = deriveEventUid(editBaseIntent.args)
      stored.set(editBaseUid, { attendees: [OWNER] })

      await w.executor.execute(editBaseProp.intentId)
      expect(w.fake.sent).toHaveLength(3) // seq 0

      // Propose edit
      const editIntent: Intent = {
        kind: "calendar.edit",
        args: {
          eventUid: editBaseUid,
          title: "Quarterly Review - Moved Online",
          location: "Zoom",
        },
      }
      const editProp = w.propose(editIntent)
      expect(editProp.tier).toBe("auto")

      // Execute edit @ sequence 1
      const execEdit = await w.executor.execute(editProp.intentId)
      expect(execEdit.ok).toBe(true)
      expect(w.fake.sent).toHaveLength(4)
      expect(w.fake.sent[3]!.data).toContain("SEQUENCE:1")
      expect(w.fake.sent[3]!.data).toContain("Quarterly Review - Moved Online")
      expect(w.fake.sent[3]!.data).toContain("LOCATION:Zoom")

      // 4. Undo edit -> re-sends prior body (Main Boardroom, original title) with sequence 2
      const undoEdit = await w.executor.undo(editProp.intentId)
      expect(undoEdit.ok).toBe(true)
      expect(w.fake.sent).toHaveLength(5)
      expect(w.fake.sent[4]!.data).toContain("SEQUENCE:2")
      expect(w.fake.sent[4]!.data).toContain("METHOD:REQUEST")
      expect(w.fake.sent[4]!.data).toContain("Quarterly Review")
      expect(w.fake.sent[4]!.data).toContain("LOCATION:Main Boardroom")
      expect(w.fake.sent[4]!.data).toContain(`UID:${editBaseUid}`)
    })
  })
})
