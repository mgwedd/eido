import type { DatabaseSync } from "node:sqlite"
import { GateRequestError, GateUnavailableError } from "@eido/gate"
import type { IntentClient } from "@eido/gate"
import type { GateIntentStatus } from "@eido/schemas"
import {
  validateCoreApiError,
  validateCoreApiReplyDraftResponse,
} from "@eido/schemas"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mail, sha } from "../context/context.test-support"
import { createModelClient } from "../inference/client"
import { createInferenceQueue } from "../inference/queue"
import { startStubModelServer } from "../inference/stub-server"
import type { StubModelServer } from "../inference/stub-server"
import { addDocs, ledgerFixture } from "../ledger/ledger.test-support"
import { insertObligation } from "../ledger/store"
import { createProposalLimiter } from "../propose/limiter"
import { fakeGate } from "../propose/propose.test-support"
import type { GateAnswer } from "../propose/propose.test-support"
import type { ProfileStore } from "../profile/store"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"
import { createReplyDrafter } from "./reply-draft-route"
import type { ReplyDraftDeps } from "./reply-draft-route"

const DRAFT = {
  kind: "email.draft",
  args: {
    to: ["cleo.varn@example.invalid"],
    subject: "Re: Lease renewal",
    body: "Lorem ipsum dolor sit amet.",
    inReplyToMessageId: "m-2",
  },
}
/** A send the model must never get through: email.send takes no reply threading id. */
const SEND = {
  kind: "email.send",
  args: {
    to: DRAFT.args.to,
    subject: DRAFT.args.subject,
    body: DRAFT.args.body,
  },
}
const reply = (intents: unknown[]): string =>
  JSON.stringify({ result: "intents", intents })

let db: DatabaseSync
let profile: ProfileStore
let entityId: string
let server: StubModelServer | undefined

beforeEach(async () => {
  const fixture = await ledgerFixture()
  db = fixture.db
  profile = fixture.profile
  entityId = fixture.property.id
})

afterEach(async () => {
  db.close()
  await server?.close()
  server = undefined
})

/** A two-message thread from Cleo, and an open reply owed on its newest message. */
async function owedThread(
  options: {
    thread?: string
    source?: string
    direction?: "owed" | "waiting"
    status?: "open" | "done"
  } = {}
): Promise<number> {
  const thread = options.thread ?? "t-1"
  const source = options.source ?? "gmail"
  const docs = ["m-1", "m-2"].map((id, i) => ({
    ...mail({
      id: `${thread === "t-1" ? "" : `${thread}-`}${id}`,
      date: `2030-02-0${String(i + 1)}T08:00:00.000Z`,
      subject: "Lease renewal",
      from: "Cleo Varn",
      body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
      threadId: thread,
    }),
    source,
    entityId,
  }))
  const [, anchor = ""] = addDocs(db, docs)
  return insertObligation(db, {
    entityId,
    action: "Reply to Cleo Varn",
    status: options.status ?? "open",
    docId: anchor,
    span: { start: 0, end: 5 },
    direction: options.direction ?? "owed",
    threadId: `key-${thread}`,
    anchorMessageId: `<${thread}-anchor@example.invalid>`,
  })
}

type Gate = ReturnType<typeof fakeGate> &
  Pick<IntentClient, "status"> & {
    states: Map<string, GateIntentStatus["state"] | GateRequestError>
    /** Intents whose discard (a separate email.trash) the gate reports executed. */
    discarded: Set<string>
    statusCalls: string[]
  }

/** The propose fake, plus a `status` that answers from `states` (default: the intent is approved). */
function gateWith(script: GateAnswer[] = []): Gate {
  const base = fakeGate(script)
  const states = new Map<string, GateIntentStatus["state"] | GateRequestError>()
  const discarded = new Set<string>()
  const statusCalls: string[] = []
  return {
    ...base,
    states,
    discarded,
    statusCalls,
    status: (id: string) => {
      statusCalls.push(id)
      const state = states.get(id) ?? "approved"
      if (state instanceof GateRequestError) return Promise.reject(state)
      return Promise.resolve({
        id,
        kind: "email.draft",
        tier: "auto",
        state,
        edited_from: null,
        discarded: discarded.has(id),
      })
    },
  }
}

async function drafterDeps(
  replies: string[],
  gate: Pick<IntentClient, "propose" | "status">,
  maxProposalsPerHour = 100
): Promise<ReplyDraftDeps> {
  server = await startStubModelServer({
    contextTokens: 32768,
    replies: replies.map((text) => ({ deltas: [text] })),
  })
  const queue = createInferenceQueue(
    createModelClient({
      baseUrl: server.url,
      contextTokens: 32768,
      maxReplyTokens: 500,
    })
  )
  return {
    db,
    gate,
    queue: () => Promise.resolve(queue),
    limiter: createProposalLimiter({ maxProposalsPerHour }),
    budgetTokens: () => 2000,
    charsPerToken: 3,
    now: () => new Date("2030-03-01T12:00:00.000Z"),
  }
}

function handlerFor(deps: ReplyDraftDeps): ApiHandler {
  return createApiHandler({
    profile,
    allowedHosts: ["core.test"],
    draftReply: createReplyDrafter(deps),
  })
}

function post(handle: ApiHandler, body: unknown): Promise<Response> {
  return handle(
    new Request("http://core.test/replies/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

async function errorOf(response: Response): Promise<{
  code: string
  message: string
}> {
  const checked = validateCoreApiError(await response.json())
  if (!checked.ok) throw new Error(checked.errors.join("; "))
  return checked.value.error
}

function storedDrafts(): Record<string, unknown>[] {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reply_drafts'"
    )
    .get()
  if (table === undefined) return []
  return db
    .prepare("SELECT thread_key, obligation_id, intent_id FROM reply_drafts")
    .all()
    .map((row) => ({ ...row }))
}

const lastPrompt = (): string =>
  server?.completions().at(-1)?.turns.at(-1)?.content ?? ""

describe("POST /replies/draft", () => {
  test("proposes one email.draft intent pinned to the thread's connector and returns its Activity link", async () => {
    const id = await owedThread()
    const gate = gateWith([{ id: "int_7", tier: "auto", state: "approved" }])
    const handle = handlerFor(await drafterDeps([reply([DRAFT])], gate))
    const response = await post(handle, { obligationId: id })
    expect(response.status).toBe(201)
    const body: unknown = await response.json()
    expect(validateCoreApiReplyDraftResponse(body).ok).toBe(true)
    expect(body).toEqual({
      intentId: "int_7",
      tier: "auto",
      state: "approved",
      activityHref: "/activity?intent=int_7",
      created: true,
    })
    expect(gate.proposals.map((p) => p.intent)).toEqual([
      { ...DRAFT, connector: "gmail" },
    ])
    expect(gate.proposals[0]?.origin).toBe("reactive")
    expect(gate.proposals[0]?.sources?.documentIds).toContain(sha("m-2"))
    expect(lastPrompt()).toContain(
      "Intent kinds offered for this request: email.draft\n"
    )
    expect(storedDrafts()).toEqual([
      { thread_key: "key-t-1", obligation_id: id, intent_id: "int_7" },
    ])
  })

  test("the Activity link escapes the intent id", async () => {
    const id = await owedThread()
    const gate = gateWith([{ id: "int/7&x", tier: "auto", state: "approved" }])
    const handle = handlerFor(await drafterDeps([reply([DRAFT])], gate))
    const body = (await (await post(handle, { obligationId: id })).json()) as {
      activityHref: string
    }
    expect(body.activityHref).toBe("/activity?intent=int%2F7%26x")
  })

  test("a Proton thread pins the Proton connector's manifest name", async () => {
    const id = await owedThread({ source: "proton" })
    const gate = gateWith()
    const handle = handlerFor(await drafterDeps([reply([DRAFT])], gate))
    expect((await post(handle, { obligationId: id })).status).toBe(201)
    expect(gate.proposals[0]?.intent).toMatchObject({
      connector: "proton-mail",
    })
  })

  test("the same thread again returns the live draft and proposes nothing", async () => {
    const id = await owedThread()
    const gate = gateWith()
    const handle = handlerFor(await drafterDeps([reply([DRAFT])], gate))
    await post(handle, { obligationId: id })
    gate.states.set("int_1", "executed")
    const again = await post(handle, { obligationId: id })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({
      intentId: "int_1",
      tier: "auto",
      state: "executed",
      activityHref: "/activity?intent=int_1",
      created: false,
    })
    expect(gate.proposals).toHaveLength(1)
    expect(server?.completions()).toHaveLength(1)
  })

  test("two concurrent calls for one thread propose one intent and both return it", async () => {
    const id = await owedThread()
    const gate = gateWith()
    const handle = handlerFor(
      await drafterDeps([reply([DRAFT]), reply([DRAFT])], gate)
    )
    const responses = await Promise.all([
      post(handle, { obligationId: id }),
      post(handle, { obligationId: id }),
    ])
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as {
      intentId: string
      created: boolean
    }[]
    expect(gate.proposals).toHaveLength(1)
    expect(server?.completions()).toHaveLength(1)
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201])
    expect(bodies.map((b) => b.intentId)).toEqual(["int_1", "int_1"])
    expect(storedDrafts()).toHaveLength(1)
  })

  test("calls for two different threads each get their own draft", async () => {
    const first = await owedThread()
    const second = await owedThread({ thread: "t-2" })
    const gate = gateWith()
    const handle = handlerFor(
      await drafterDeps(
        [
          reply([DRAFT]),
          reply([
            {
              ...DRAFT,
              args: { ...DRAFT.args, inReplyToMessageId: "t-2-m-2" },
            },
          ]),
        ],
        gate
      )
    )
    const responses = await Promise.all([
      post(handle, { obligationId: first }),
      post(handle, { obligationId: second }),
    ])
    expect(responses.map((r) => r.status)).toEqual([201, 201])
    expect(gate.proposals).toHaveLength(2)
  })

  test("a draft the gate rejected or that failed is replaced by a new one", async () => {
    const id = await owedThread()
    const gate = gateWith()
    const handle = handlerFor(
      await drafterDeps([reply([DRAFT]), reply([DRAFT]), reply([DRAFT])], gate)
    )
    await post(handle, { obligationId: id })
    gate.states.set("int_1", "rejected")
    const second = await post(handle, { obligationId: id })
    expect(second.status).toBe(201)
    expect(((await second.json()) as { intentId: string }).intentId).toBe(
      "int_2"
    )
    gate.states.set("int_2", "failed")
    expect((await post(handle, { obligationId: id })).status).toBe(201)
    expect(gate.proposals).toHaveLength(3)
    expect(storedDrafts()).toEqual([
      { thread_key: "key-t-1", obligation_id: id, intent_id: "int_3" },
    ])
  })

  test("an executed draft whose discard executed is replaced by a new one", async () => {
    const id = await owedThread()
    const gate = gateWith()
    const handle = handlerFor(
      await drafterDeps([reply([DRAFT]), reply([DRAFT])], gate)
    )
    await post(handle, { obligationId: id })
    gate.states.set("int_1", "executed")
    // The discard is pending or was rejected: the gate does not report it, the draft holds.
    const held = await post(handle, { obligationId: id })
    expect(held.status).toBe(200)
    expect(((await held.json()) as { intentId: string }).intentId).toBe("int_1")
    gate.discarded.add("int_1")
    const replaced = await post(handle, { obligationId: id })
    expect(replaced.status).toBe(201)
    expect(await replaced.json()).toMatchObject({
      intentId: "int_2",
      created: true,
    })
    expect(gate.proposals).toHaveLength(2)
    expect(storedDrafts()).toEqual([
      { thread_key: "key-t-1", obligation_id: id, intent_id: "int_2" },
    ])
  })

  test("a stored draft the gate no longer knows is replaced", async () => {
    const id = await owedThread()
    const gate = gateWith()
    const handle = handlerFor(
      await drafterDeps([reply([DRAFT]), reply([DRAFT])], gate)
    )
    await post(handle, { obligationId: id })
    gate.states.set("int_1", new GateRequestError(404, "not_found", "gone"))
    expect((await post(handle, { obligationId: id })).status).toBe(201)
    expect(gate.proposals).toHaveLength(2)
  })

  test("another gate refusal while checking the stored draft is busy, and nothing is proposed", async () => {
    const id = await owedThread()
    const gate = gateWith()
    const handle = handlerFor(
      await drafterDeps([reply([DRAFT]), reply([DRAFT])], gate)
    )
    await post(handle, { obligationId: id })
    gate.states.set("int_1", new GateRequestError(500, "internal", "boom"))
    const response = await post(handle, { obligationId: id })
    expect(response.status).toBe(503)
    expect((await errorOf(response)).code).toBe("busy")
    expect(gate.proposals).toHaveLength(1)
  })

  test("a reply proposing send, reply or forward is refused: nothing reaches the gate", async () => {
    const id = await owedThread()
    const gate = gateWith()
    const send = SEND
    const forward = {
      kind: "email.forward",
      args: { messageId: "m-2", to: ["ada.quill@example.invalid"] },
    }
    const handle = handlerFor(
      await drafterDeps([reply([send]), reply([forward])], gate)
    )
    const response = await post(handle, { obligationId: id })
    expect(response.status).toBe(422)
    expect(await errorOf(response)).toEqual({
      code: "no_draft",
      message: "the model's draft failed its checks twice",
    })
    expect(gate.proposals).toHaveLength(0)
    expect(lastPrompt()).toContain("kind_not_offered")
    expect(storedDrafts()).toEqual([])
  })

  test("a reply leading with a send is refused whole, and the draft-only retry is proposed", async () => {
    const id = await owedThread()
    const gate = gateWith()
    const send = SEND
    const handle = handlerFor(
      await drafterDeps([reply([send, DRAFT]), reply([DRAFT])], gate)
    )
    expect((await post(handle, { obligationId: id })).status).toBe(201)
    expect(lastPrompt()).toContain("kind_not_offered")
    expect(gate.proposals.map((p) => p.intent)).toEqual([
      { ...DRAFT, connector: "gmail" },
    ])
  })

  test("a send after the draft is past the one-intent cap and never reaches the gate", async () => {
    const id = await owedThread()
    const gate = gateWith()
    const send = SEND
    const handle = handlerFor(await drafterDeps([reply([DRAFT, send])], gate))
    expect((await post(handle, { obligationId: id })).status).toBe(201)
    expect(gate.proposals.map((p) => p.intent)).toEqual([
      { ...DRAFT, connector: "gmail" },
    ])
  })

  test("a model that proposes nothing is no_draft", async () => {
    const id = await owedThread()
    const handle = handlerFor(
      await drafterDeps(
        [JSON.stringify({ result: "none", reason: "Lorem ipsum." })],
        gateWith()
      )
    )
    const response = await post(handle, { obligationId: id })
    expect(response.status).toBe(422)
    expect(await errorOf(response)).toEqual({
      code: "no_draft",
      message: "the model proposed no draft",
    })
  })

  test("a thread too large for the budget is no_draft", async () => {
    const id = await owedThread()
    const deps = await drafterDeps([reply([DRAFT])], gateWith())
    const handle = handlerFor({ ...deps, budgetTokens: () => 1 })
    const response = await post(handle, { obligationId: id })
    expect(response.status).toBe(422)
    expect((await errorOf(response)).message).toBe(
      "the thread is too large to draft from"
    )
  })

  test("a paused connector is a clear connector_paused error with no intent id, and nothing is stored", async () => {
    const id = await owedThread()
    const gate = gateWith([
      {
        id: "int_1",
        tier: "forbidden",
        state: "rejected",
        reason: "connector_disabled",
      },
      { id: "int_2", tier: "auto", state: "approved" },
    ])
    const handle = handlerFor(
      await drafterDeps([reply([DRAFT]), reply([DRAFT])], gate)
    )
    const response = await post(handle, { obligationId: id })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: {
        code: "connector_paused",
        message: "the mail connector is paused",
      },
    })
    expect(storedDrafts()).toEqual([])
    const resumed = await post(handle, { obligationId: id })
    expect(resumed.status).toBe(201)
    expect(((await resumed.json()) as { intentId: string }).intentId).toBe(
      "int_2"
    )
  })

  test("another policy refusal is no_draft", async () => {
    const id = await owedThread()
    const gate = gateWith([
      {
        id: "int_1",
        tier: "forbidden",
        state: "rejected",
        reason: "manifest_forbidden",
      },
    ])
    const handle = handlerFor(await drafterDeps([reply([DRAFT])], gate))
    const response = await post(handle, { obligationId: id })
    expect(response.status).toBe(422)
    expect(await errorOf(response)).toEqual({
      code: "no_draft",
      message: "the gate refused the draft",
    })
  })

  test("past the hourly draft limit the route is busy and the model is not called", async () => {
    const first = await owedThread()
    const second = await owedThread({ thread: "t-2" })
    const handle = handlerFor(
      await drafterDeps([reply([DRAFT])], gateWith(), 1)
    )
    expect((await post(handle, { obligationId: first })).status).toBe(201)
    const response = await post(handle, { obligationId: second })
    expect(response.status).toBe(503)
    expect(await errorOf(response)).toEqual({
      code: "busy",
      message: "too many drafts this hour",
    })
    expect(server?.completions()).toHaveLength(1)
  })

  test("an unreachable gate is gate_unavailable", async () => {
    const id = await owedThread()
    const gate = gateWith()
    const deps = await drafterDeps([reply([DRAFT])], {
      ...gate,
      propose: () => Promise.reject(new GateUnavailableError("down")),
    })
    const response = await post(handlerFor(deps), { obligationId: id })
    expect(response.status).toBe(503)
    expect((await errorOf(response)).code).toBe("gate_unavailable")
  })

  test("a model that cannot be reached is busy", async () => {
    const id = await owedThread()
    const deps = await drafterDeps([reply([DRAFT])], gateWith())
    const handle = handlerFor({
      ...deps,
      queue: () => Promise.reject(new Error("model down")),
    })
    const response = await post(handle, { obligationId: id })
    expect(response.status).toBe(503)
    expect(await errorOf(response)).toEqual({
      code: "busy",
      message: "drafting is temporarily unavailable",
    })
  })

  test("a call after a failed one for the same thread still runs", async () => {
    const id = await owedThread()
    const deps = await drafterDeps([reply([DRAFT])], gateWith())
    let fail = true
    const handle = handlerFor({
      ...deps,
      queue: () => {
        if (!fail) return deps.queue()
        fail = false
        return Promise.reject(new Error("model down"))
      },
    })
    const [first, second] = await Promise.all([
      post(handle, { obligationId: id }),
      post(handle, { obligationId: id }),
    ])
    expect(first?.status).toBe(503)
    expect(second?.status).toBe(201)
  })

  describe("request errors", () => {
    let handle: ApiHandler
    let gate: Gate
    beforeEach(async () => {
      gate = gateWith()
      handle = handlerFor(await drafterDeps([reply([DRAFT])], gate))
    })
    afterEach(() => {
      expect(gate.proposals).toHaveLength(0)
    })

    test("an unknown obligation is not_found", async () => {
      const response = await post(handle, { obligationId: 999 })
      expect(response.status).toBe(404)
      expect((await errorOf(response)).code).toBe("not_found")
    })

    test("a body that is not one obligation id is invalid", async () => {
      const response = await post(handle, { threadId: "t-1" })
      expect(response.status).toBe(422)
      expect((await errorOf(response)).code).toBe("invalid")
    })

    test("a reply the owner is waiting on is not a reply owed", async () => {
      const id = await owedThread({ direction: "waiting" })
      const response = await post(handle, { obligationId: id })
      expect(response.status).toBe(422)
      expect((await errorOf(response)).message).toBe(
        "the obligation is not a reply owed"
      )
    })

    test("an obligation that is not about a reply is not a reply owed", async () => {
      const [doc = ""] = addDocs(db, [
        {
          ...mail({
            id: "inv-1",
            date: "2030-02-03T08:00:00.000Z",
            body: "Lorem ipsum.",
          }),
          entityId,
        },
      ])
      const id = await insertObligation(db, {
        entityId,
        action: "Pay the invoice",
        status: "open",
        docId: doc,
        span: { start: 0, end: 5 },
      })
      const response = await post(handle, { obligationId: id })
      expect(response.status).toBe(422)
    })

    test("a closed obligation is invalid_transition", async () => {
      const id = await owedThread({ status: "done" })
      const response = await post(handle, { obligationId: id })
      expect(response.status).toBe(409)
      expect((await errorOf(response)).code).toBe("invalid_transition")
    })

    test("mail from a source with no draft writer is invalid", async () => {
      const id = await owedThread({ source: "files" })
      const response = await post(handle, { obligationId: id })
      expect(response.status).toBe(422)
      expect((await errorOf(response)).message).toBe(
        "the thread's mail has no draft connector"
      )
    })

    test("only POST is served", async () => {
      const response = await handle(
        new Request("http://core.test/replies/draft")
      )
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("POST")
    })
  })

  test("without a drafter the route is not served", async () => {
    const handle = createApiHandler({ profile, allowedHosts: ["core.test"] })
    expect((await post(handle, { obligationId: 1 })).status).toBe(404)
  })
})
