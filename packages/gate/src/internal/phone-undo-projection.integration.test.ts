import { afterEach, describe, expect, it, vi } from "vitest"
import { createExecutor } from "./executor"
import type { WriteTransport } from "./executor"
import {
  GMAIL_BATCH_MODIFY_PATH,
  GMAIL_HOST,
  gmailArchiveWriter,
  gmailLabelWriter,
} from "./gmail-writers"
import { propose } from "./intents"
import {
  call,
  projection,
  recordExecuted,
  signIn,
  undoHandler,
} from "./phone-undo-harness"
import { auditRows, MAIL_OPS, manifest, sample, setup } from "./test-fixtures"
import type { Setup } from "./test-fixtures"

// Issue #831, mail half: Activity must not offer Undo once the executor will refuse every retry.
// The route and the projection are read side by side over the real executor and Gmail writer.

let s: Setup | undefined
afterEach(() => {
  s?.cleanup()
  s = undefined
})

const IDS = ["synthetic-message-1", "synthetic-message-2"]

function mailbox() {
  const gmail = manifest("gmail", MAIL_OPS)
  gmail.egress.hosts = [
    {
      host: GMAIL_HOST,
      methods: ["POST"],
      pathPrefixes: ["/gmail/v1/users/me"],
    },
  ]
  for (const operation of gmail.operations) {
    // The archive's stored inverse is an email.label, so both are pinned to the batch route.
    if (["email.archive", "email.label"].includes(operation.intentKind ?? "")) {
      operation.routes = [
        {
          host: GMAIL_HOST,
          method: "POST",
          pathPattern: GMAIL_BATCH_MODIFY_PATH,
        },
      ]
    }
  }
  s = setup([gmail])
  const fixture = s
  // Both messages were in the inbox before the archive, so the stored inverse puts INBOX back.
  const transport = vi.fn<WriteTransport>(() =>
    Promise.resolve({
      upstreamRef: null,
      result: {
        priorLabels: Object.fromEntries(IDS.map((id) => [id, ["INBOX"]])),
        previouslyUnread: [],
      },
    })
  )
  const executor = createExecutor(
    fixture.db,
    [gmailArchiveWriter, gmailLabelWriter],
    transport
  )
  const handler = undoHandler(fixture, (id) => executor.undo(id))
  return { ...fixture, transport, executor, handler }
}

async function archived(f: ReturnType<typeof mailbox>) {
  const cookie = await signIn(f, f.handler)
  const proposed = propose(f.db, f.policy, {
    intent: { kind: "email.archive", args: { messageIds: IDS } },
    origin: "reactive",
  })
  if (!proposed.ok) throw new Error(proposed.code)
  expect((await f.executor.execute(proposed.intentId)).ok).toBe(true)
  return { cookie, id: proposed.intentId }
}

describe("Activity undo state after a mail undo attempt", () => {
  it("offers Undo before any attempt", async () => {
    const f = mailbox()
    const { cookie, id } = await archived(f)
    expect((await projection(f.handler, cookie, id))?.undo).toBe("available")
  })

  it("stops offering Undo once an attempt's upstream outcome is unresolved, as the route refuses a retry", async () => {
    const f = mailbox()
    const { cookie, id } = await archived(f)
    f.transport.mockRejectedValueOnce(new Error("synthetic-upstream-failure"))
    expect(
      (await call(f.handler, `/executions/${id}/undo`, cookie)).status
    ).toBe(503)
    const retry = await call(f.handler, `/executions/${id}/undo`, cookie)
    expect(retry.status).toBe(409)
    expect((await projection(f.handler, cookie, id))?.undo).toBe("none")
    // Execute, the unresolved undo, and no retry: the writer was never called a third time.
    expect(f.transport).toHaveBeenCalledTimes(2)
    expect(auditRows(f.db).filter((row) => row.action === "undo")).toEqual([])
  })
})

// Issue #851: Activity offers Undo only where the executor's kind rule can accept the stored
// inverse. Each row stores a hand-picked inverse on an executed archive (as a pre-#832 or faulty
// writer left it) and reads the projection next to the route's answer to the same Undo.
describe("Activity undo state for a stored inverse the executor refuses", () => {
  const REFUSED = [
    "email.send",
    "email.forward",
    "email.reply",
    "email.trash",
    "file.delete",
    "calendar.create",
    "calendar.edit",
    "calendar.delete",
  ] as const

  async function withInverse(inverse: unknown) {
    const f = mailbox()
    const cookie = await signIn(f, f.handler)
    const id = recordExecuted(
      f,
      { kind: "email.archive", args: { messageIds: IDS } },
      inverse
    )
    return { f, cookie, id }
  }

  it.each(REFUSED)(
    "shows none for a stored %s inverse, and the route refuses it as unsafe",
    async (kind) => {
      const { f, cookie, id } = await withInverse(sample(kind))
      expect((await projection(f.handler, cookie, id))?.undo).toBe("none")
      const before = auditRows(f.db).length
      const response = await call(f.handler, `/executions/${id}/undo`, cookie)
      expect(response.status).toBe(409)
      expect(
        auditRows(f.db)
          .slice(before)
          .map((row) => row.action)
      ).toEqual(["undo.refused.unsafe_inverse"])
      expect(f.transport).not.toHaveBeenCalled()
    }
  )

  it("still shows Undo for a stored inverse the rule accepts, and the route does not call it unsafe", async () => {
    // The archive's own recorded inverse, an email.label, untouched.
    const f = mailbox()
    const { cookie, id } = await archived(f)
    expect((await projection(f.handler, cookie, id))?.undo).toBe("available")
    const before = auditRows(f.db).length
    await call(f.handler, `/executions/${id}/undo`, cookie)
    expect(
      auditRows(f.db)
        .slice(before)
        .map((row) => row.action)
    ).not.toContain("undo.refused.unsafe_inverse")
  })

  it("shows none when the recorded intent no longer parses, as the executor cannot run it", async () => {
    const f = mailbox()
    const { cookie, id } = await archived(f)
    f.db
      .prepare("UPDATE intents SET payload_json=? WHERE id=?")
      .run('{"kind":"email.archive","args":{}}', id)
    expect((await projection(f.handler, cookie, id))?.undo).toBe("none")
  })
})
