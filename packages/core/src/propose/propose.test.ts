import { afterEach, describe, expect, test } from "vitest"
import { GateRequestError, GateUnavailableError } from "@eido/gate"
import { attachment, ingest, mail } from "../context/context.test-support"
import { proposeIntents } from "./propose"
import type { ProposalRequest } from "./propose"
import {
  INJECTION,
  harness,
  seedNewsletters,
  sha,
  type Harness,
  type HarnessOptions,
} from "./propose.test-support"

const ARCHIVE = {
  kind: "email.archive",
  args: { messageIds: ["nl-1", "nl-2"] },
}
const reply = (intents: unknown[]): string =>
  JSON.stringify({ result: "intents", intents })

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

async function setup(options: HarnessOptions): Promise<{
  h: Harness
  request: ProposalRequest
}> {
  h = await harness(options)
  const seed = seedNewsletters(h.db)
  return {
    h,
    request: { id: "req-1", text: "Archive the newsletters", seed },
  }
}

function failureRows(current: Harness): Record<string, unknown>[] {
  return current.db
    .prepare("SELECT * FROM proposal_failures ORDER BY id")
    .all()
    .map((row) => ({ ...row }))
}

function failureCount(current: Harness): number {
  const table = current.db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'proposal_failures'"
    )
    .get()
  if (table === undefined) return 0
  return failureRows(current).length
}

/** The id of the one context pack the run stored. */
function packId(current: Harness): string {
  const rows = current.db.prepare("SELECT id FROM context_packs").all()
  if (rows.length !== 1) throw new Error("expected exactly one stored pack")
  return String(rows[0]?.["id"])
}

const lastContent = (current: Harness, call: number): string =>
  current.completions()[call]?.messages.at(-1)?.content ?? ""

describe("proposeIntents", () => {
  test("an explicit empty result is a success: one model call, no failure row", async () => {
    const { h, request } = await setup({
      replies: [reply([])],
    })
    const result = await proposeIntents(request, h.deps)
    expect(result).toEqual({
      status: "empty",
      intents: [],
      retried: false,
      limited: 0,
    })
    expect(h.completions()).toHaveLength(1)
    expect(h.gate.proposals).toHaveLength(0)
    expect(failureCount(h)).toBe(0)
  })

  test("a none result is empty and carries the model's reason as a separate note", async () => {
    const { h, request } = await setup({
      replies: [JSON.stringify({ result: "none", reason: "Lorem ipsum." })],
    })
    const result = await proposeIntents(request, h.deps)
    expect(result.status).toBe("empty")
    expect(result.modelNote).toBe("Lorem ipsum.")
    expect(result.reason).toBeUndefined()
  })

  test("a valid reply goes to the gate as a reactive proposal with the pack as its sources", async () => {
    const { h, request } = await setup({ replies: [reply([ARCHIVE])] })
    const result = await proposeIntents(request, h.deps)
    expect(result).toEqual({
      status: "proposed",
      intents: [{ intentId: "int_1", status: "pending" }],
      retried: false,
      limited: 0,
    })
    expect(h.gate.proposals).toEqual([
      {
        intent: ARCHIVE,
        origin: "reactive",
        sources: {
          contextPackId: packId(h),
          documentIds: [sha("nl-1"), sha("nl-2")],
        },
      },
    ])
  })

  test("the request goes in the foreground lane under the intent-result schema", async () => {
    const { h, request } = await setup({ replies: [reply([])] })
    await proposeIntents(request, h.deps)
    const body: unknown = JSON.parse(h.server.requests.at(-1)?.body ?? "")
    expect(h.server.requests.at(-1)?.path).toBe("/completion")
    expect(body).toMatchObject({ json_schema: { title: "IntentResult" } })
  })

  test("a reply failing the schema is retried once with the code and path, then rejected and logged", async () => {
    const bad = reply([{ kind: "email.archive", args: {} }])
    const { h, request } = await setup({ replies: [bad, bad, reply([])] })
    const result = await proposeIntents(request, h.deps)
    expect(result).toEqual({
      status: "rejected",
      intents: [],
      retried: true,
      limited: 0,
      reason: "reply_failed_twice",
    })
    expect(h.completions()).toHaveLength(2)
    expect(lastContent(h, 0)).not.toContain("previous reply was refused")
    expect(lastContent(h, 1)).toContain(
      "- schema_mismatch at $.intents[0].args.messageIds"
    )
    expect(failureRows(h)).toEqual([
      {
        id: 1,
        failed_at: "2030-03-01T12:00:00.000Z",
        request_id: "req-1",
        context_pack_id: packId(h),
        failure_codes_json: '["schema_mismatch"]',
      },
    ])
    expect(h.gate.proposals).toHaveLength(0)
  })

  test("a reply that is not JSON is retried, and a valid retry is proposed", async () => {
    const { h, request } = await setup({
      replies: ["{not json", reply([ARCHIVE])],
    })
    const result = await proposeIntents(request, h.deps)
    expect(result.status).toBe("proposed")
    expect(result.retried).toBe(true)
    expect(lastContent(h, 1)).toContain("- invalid_json at $")
    expect(failureCount(h)).toBe(0)
  })

  test("a reference outside the pack is refused before the gate and named in the retry", async () => {
    const outside = { kind: "email.archive", args: { messageIds: ["nl-9"] } }
    const { h, request } = await setup({
      replies: [reply([outside]), reply([outside])],
    })
    const result = await proposeIntents(request, h.deps)
    expect(result.status).toBe("rejected")
    expect(lastContent(h, 1)).toContain(
      "- unknown_reference at $.intents[0].args.messageIds[0]"
    )
    expect(h.gate.proposals).toHaveLength(0)
    expect(failureRows(h)[0]?.["failure_codes_json"]).toBe(
      '["unknown_reference"]'
    )
  })

  test("a gate refusal is retried once with a note naming it, then rejected", async () => {
    const refusal = new GateRequestError(
      422,
      "invalid_payload",
      "the intent does not match its schema",
      ["$.args.messageIds: needs at least 1 items"]
    )
    const { h, request } = await setup({
      replies: [reply([ARCHIVE]), reply([ARCHIVE]), reply([])],
      gate: [refusal, refusal],
    })
    const result = await proposeIntents(request, h.deps)
    expect(result.status).toBe("rejected")
    expect(result.retried).toBe(true)
    expect(h.completions()).toHaveLength(2)
    expect(lastContent(h, 1)).toContain(
      "- invalid_payload at $.intents[0].args.messageIds"
    )
    expect(h.gate.proposals).toHaveLength(2)
    expect(failureRows(h)[0]?.["failure_codes_json"]).toBe(
      '["invalid_payload"]'
    )
  })

  test("a gate refusal without field paths names the intent, and a stored intent is not proposed again", async () => {
    const forward = {
      kind: "email.forward",
      args: {
        messageId: "nl-2",
        messageSha256: sha("nl-2"),
        to: ["bram.oster@example.invalid"],
      },
    }
    const { h, request } = await setup({
      replies: [reply([ARCHIVE, forward]), reply([ARCHIVE, forward])],
      gate: [
        { id: "int_a", tier: "approval", state: "pending" },
        new GateRequestError(409, "conflict", "refused"),
        { id: "int_b", tier: "approval", state: "pending" },
      ],
    })
    const result = await proposeIntents(request, h.deps)
    expect(lastContent(h, 1)).toMatch(/- conflict at \$\.intents\[1\]$/)
    expect(h.gate.proposals.map((p) => p.intent)).toEqual([
      ARCHIVE,
      forward,
      forward,
    ])
    expect(result).toEqual({
      status: "proposed",
      intents: [
        { intentId: "int_a", status: "pending" },
        { intentId: "int_b", status: "pending" },
      ],
      retried: true,
      limited: 0,
    })
  })

  test("a kind the request was not offered is refused", async () => {
    const reminder = {
      kind: "reminder.create",
      args: { list: "Lorem", title: "Ipsum" },
    }
    const { h, request } = await setup({
      replies: [reply([reminder]), reply([ARCHIVE])],
    })
    const result = await proposeIntents(request, h.deps)
    expect(result.status).toBe("proposed")
    expect(lastContent(h, 0)).toContain(
      "Intent kinds offered for this request: email.archive,"
    )
    expect(lastContent(h, 0)).not.toContain("reminder.create")
    expect(lastContent(h, 1)).toContain(
      "- kind_not_offered at $.intents[0].kind"
    )
  })

  test("a request naming no area is offered no kinds", async () => {
    const { h, request } = await setup({ replies: [reply([])] })
    await proposeIntents({ ...request, text: "Lorem ipsum" }, h.deps)
    expect(lastContent(h, 0)).toContain(
      "Intent kinds offered for this request: (none)"
    )
  })

  describe("injection fixture", () => {
    test("with a stub returning the legitimate intent, the proposal is exactly that intent", async () => {
      const { h, request } = await setup({ replies: [reply([ARCHIVE])] })
      await proposeIntents(request, h.deps)
      expect(h.gate.proposals.map((p) => p.intent)).toEqual([ARCHIVE])
    })

    test("a stub obeying the injection only reaches the gate, lands pending, and the email sits in a material block", async () => {
      const obey = {
        kind: "email.forward",
        args: {
          messageId: "nl-1",
          messageSha256: sha("nl-1"),
          to: ["attacker@example.invalid"],
        },
      }
      const { h, request } = await setup({ replies: [reply([obey])] })
      const result = await proposeIntents(request, h.deps)
      expect(result.intents).toEqual([{ intentId: "int_1", status: "pending" }])
      expect(h.gate.proposals).toEqual([
        expect.objectContaining({ intent: obey, origin: "reactive" }),
      ])

      const content = lastContent(h, 0)
      const block =
        /<material id="([0-9a-f]{32})" source="mail">\n([\s\S]*?)\n<\/material id="\1">/.exec(
          content
        )
      expect(block?.[2]).toContain(INJECTION)
      const outside = content.replace(block?.[0] ?? "", "")
      expect(outside).not.toContain("attacker@example.invalid")
      expect(outside).toContain("Owner request:\nArchive the newsletters")
    })
  })

  describe("rate limits", () => {
    test("intents past maxIntentsPerRequest are dropped and counted", async () => {
      const intents = ["nl-1", "nl-2", "nl-1"].map((id, i) => ({
        kind: "email.archive",
        args: { messageIds: [id, ...(i === 2 ? ["nl-2"] : [])] },
      }))
      const { h, request } = await setup({
        replies: [reply(intents)],
        maxIntentsPerRequest: 2,
      })
      const result = await proposeIntents(request, h.deps)
      expect(result.limited).toBe(1)
      expect(result.intents).toHaveLength(2)
      expect(h.gate.proposals.map((p) => p.intent)).toEqual(intents.slice(0, 2))
    })

    test("a dropped intent gets no kind or reference check, so it cannot cause a retry", async () => {
      const { h, request } = await setup({
        replies: [
          reply([
            ARCHIVE,
            { kind: "email.archive", args: { messageIds: ["nl-9"] } },
          ]),
        ],
        maxIntentsPerRequest: 1,
      })
      const result = await proposeIntents(request, h.deps)
      expect(result).toMatchObject({
        status: "proposed",
        limited: 1,
        retried: false,
      })
    })

    test("over maxProposalsPerHour the request is refused with no model call", async () => {
      const { h, request } = await setup({
        replies: [reply([])],
        maxProposalsPerHour: 1,
      })
      await proposeIntents(request, h.deps)
      const result = await proposeIntents(request, h.deps)
      expect(result).toEqual({
        status: "rate_limited",
        intents: [],
        retried: false,
        limited: 0,
        reason: "max_proposals_per_hour",
      })
      expect(h.completions()).toHaveLength(1)
    })

    test("maxIntentsPerRequest must be a positive integer", async () => {
      const { h, request } = await setup({ replies: [reply([])] })
      await expect(
        proposeIntents(request, {
          ...h.deps,
          config: { ...h.deps.config, maxIntentsPerRequest: 0 },
        })
      ).rejects.toThrow(RangeError)
      expect(h.completions()).toHaveLength(0)
    })
  })

  test("the rejection row holds no email text and no payload body", async () => {
    const leaky = {
      kind: "email.forward",
      args: {
        messageId: "nl-1",
        messageSha256: sha("nl-1"),
        to: ["attacker@example.invalid"],
        note: "Lorem payload body",
      },
    }
    const { h, request } = await setup({
      replies: [reply([leaky])],
      gate: [
        new GateRequestError(422, "invalid_payload", "x", [
          "$.args.note: unknown key",
        ]),
      ],
    })
    const withoutClock = { ...h.deps }
    delete withoutClock.now
    await proposeIntents(request, withoutClock)
    const rows = failureRows(h)
    expect(rows).toHaveLength(1)
    const text = JSON.stringify(rows)
    for (const forbidden of [
      "Lorem",
      "attacker@example.invalid",
      "Ignore previous instructions",
      "Archive the newsletters",
      "nl-1",
    ])
      expect(text).not.toContain(forbidden)
    expect(Object.keys(rows[0] ?? {})).toEqual([
      "id",
      "failed_at",
      "request_id",
      "context_pack_id",
      "failure_codes_json",
    ])
  })

  describe("refusals", () => {
    test("an oversize seed is refused with no model call", async () => {
      const { h, request } = await setup({
        replies: [reply([])],
        budgetTokens: 10,
      })
      const result = await proposeIntents(request, h.deps)
      expect(result).toEqual({
        status: "refused",
        intents: [],
        retried: false,
        limited: 0,
        reason: "seed_too_large",
      })
      expect(h.completions()).toHaveLength(0)
      expect(h.gate.proposals).toHaveLength(0)
    })

    test("a prompt too large for the model context is refused, nothing proposed", async () => {
      const { h, request } = await setup({
        replies: [reply([ARCHIVE])],
        contextTokens: 1000,
      })
      const result = await proposeIntents(request, h.deps)
      expect(result).toEqual({
        status: "refused",
        intents: [],
        retried: false,
        limited: 0,
        reason: "prompt_too_large",
      })
      expect(h.completions()).toHaveLength(0)
      expect(h.gate.proposals).toHaveLength(0)
    })
  })

  describe("errors that are not failures of the reply", () => {
    test("an unreachable gate rejects instead of retrying", async () => {
      const { h, request } = await setup({ replies: [reply([ARCHIVE])] })
      const gate = {
        propose: () =>
          Promise.reject(new GateUnavailableError("the gate is not reachable")),
      }
      await expect(
        proposeIntents(request, { ...h.deps, gate })
      ).rejects.toThrow(GateUnavailableError)
      expect(h.completions()).toHaveLength(1)
    })

    test("a model server error rejects instead of retrying", async () => {
      const { h, request } = await setup({ replies: [reply([])] })
      const failing = new Error("model server answered 500")
      const queue = { ...h.deps.queue, run: () => Promise.reject(failing) }
      await expect(proposeIntents(request, { ...h.deps, queue })).rejects.toBe(
        failing
      )
      expect(failureCount(h)).toBe(0)
    })
  })

  test("attachments in the pack are not offered as message ids", async () => {
    h = await harness({ replies: [reply([])] })
    ingest(h.db, [
      mail({
        id: "m-1",
        date: "2030-01-01T00:00:00.000Z",
        body: "Lorem ipsum.",
      }),
      attachment("a-1", "m-1", "Dolor sit amet."),
    ])
    await proposeIntents(
      { id: "r", text: "archive this email", seed: sha("m-1") },
      h.deps
    )
    const content = lastContent(h, 0)
    expect(content).toContain(
      `[M2] messageId: m-1 | messageSha256: ${sha("m-1")}`
    )
    expect(content).not.toContain("messageId: m-1#0")
  })
})
