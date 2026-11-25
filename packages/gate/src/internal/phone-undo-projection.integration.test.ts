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
import { call, projection, signIn, undoHandler } from "./phone-undo-harness"
import { auditRows, MAIL_OPS, manifest, setup } from "./test-fixtures"
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
