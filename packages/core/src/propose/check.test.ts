import { describe, expect, test } from "vitest"
import { checkReply } from "./check"

const context = {
  kinds: new Set(["email.forward", "email.draft"]),
  referable: [{ tag: "[M1]", messageId: "m-1", messageSha256: "a".repeat(64) }],
}
const reply = (intent: unknown): string =>
  JSON.stringify({ result: "intents", intents: [intent] })

describe("checkReply references", () => {
  test("a message id and hash outside the pack are both named", () => {
    const checked = checkReply(
      reply({
        kind: "email.forward",
        args: {
          messageId: "m-9",
          messageSha256: "b".repeat(64),
          to: ["ada@example.invalid"],
        },
      }),
      context,
      5
    )
    expect(checked).toEqual({
      ok: false,
      failures: [
        { code: "unknown_reference", path: "$.intents[0].args.messageId" },
        { code: "unknown_reference", path: "$.intents[0].args.messageSha256" },
      ],
    })
  })

  test("a draft replying to a message outside the pack is refused", () => {
    const checked = checkReply(
      reply({
        kind: "email.draft",
        args: {
          to: ["ada@example.invalid"],
          subject: "Lorem",
          body: "Ipsum",
          inReplyToMessageId: "m-9",
        },
      }),
      context,
      5
    )
    expect(checked).toEqual({
      ok: false,
      failures: [
        {
          code: "unknown_reference",
          path: "$.intents[0].args.inReplyToMessageId",
        },
      ],
    })
  })

  test("ids inside the pack pass", () => {
    const intent = {
      kind: "email.forward",
      args: {
        messageId: "m-1",
        messageSha256: "a".repeat(64),
        to: ["ada@example.invalid"],
      },
    }
    expect(checkReply(reply(intent), context, 5)).toEqual({
      ok: true,
      intents: [intent],
    })
  })
})
