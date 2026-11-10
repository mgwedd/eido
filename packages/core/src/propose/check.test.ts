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

describe("checkReply reply-draft bounds", () => {
  const bounds = {
    seedMessageId: "m-1",
    allowed: new Set([
      "cleo.varn@example.invalid",
      "ada.quill@example.invalid",
    ]),
  }
  const draftContext = {
    ...context,
    referable: [
      ...context.referable,
      { tag: "[M2]", messageId: "m-2", messageSha256: "c".repeat(64) },
    ],
    draft: bounds,
  }
  const draft = (args: Record<string, unknown>): string =>
    reply({
      kind: "email.draft",
      args: { subject: "Lorem", body: "Ipsum", ...args },
    })
  const failuresOf = (text: string): unknown => {
    const checked = checkReply(text, draftContext, 5)
    return checked.ok ? [] : checked.failures
  }

  test("thread participants pass, matched case-insensitively and with a display name", () => {
    const checked = checkReply(
      draft({
        to: ["Cleo Varn <CLEO.Varn@Example.Invalid>"],
        cc: ["ada.quill@example.invalid"],
        inReplyToMessageId: "m-1",
      }),
      draftContext,
      5
    )
    expect(checked.ok).toBe(true)
  })

  test("an address outside the thread is named by field and position", () => {
    expect(
      failuresOf(
        draft({
          to: ["cleo.varn@example.invalid"],
          cc: ["ada.quill@example.invalid", "attacker@evil.example"],
        })
      )
    ).toEqual([
      { code: "recipient_not_on_thread", path: "$.intents[0].args.cc[1]" },
    ])
  })

  test("a quoted display name carrying a thread address does not hide the real one", () => {
    expect(
      failuresOf(
        draft({
          to: ['"Cleo <cleo.varn@example.invalid>" <attacker@evil.example>'],
        })
      )
    ).toEqual([
      { code: "recipient_not_on_thread", path: "$.intents[0].args.to[0]" },
    ])
  })

  test("a recipient that is not one address is refused", () => {
    expect(
      failuresOf(
        draft({
          to: ["cleo.varn@example.invalid, attacker@evil.example"],
        })
      )
    ).toEqual([
      { code: "recipient_not_on_thread", path: "$.intents[0].args.to[0]" },
    ])
  })

  test("any bcc is refused", () => {
    expect(
      failuresOf(
        draft({
          to: ["cleo.varn@example.invalid"],
          bcc: ["ada.quill@example.invalid"],
        })
      )
    ).toEqual([{ code: "bcc_not_allowed", path: "$.intents[0].args.bcc" }])
  })

  test("a reply target other than the seed message is refused", () => {
    expect(
      failuresOf(
        draft({
          to: ["cleo.varn@example.invalid"],
          inReplyToMessageId: "m-2",
        })
      )
    ).toEqual([
      {
        code: "reply_target_not_seed",
        path: "$.intents[0].args.inReplyToMessageId",
      },
    ])
  })

  test("without bounds an outside recipient is not this check's business", () => {
    const checked = checkReply(
      draft({ to: ["attacker@evil.example"] }),
      context,
      5
    )
    expect(checked.ok).toBe(true)
  })
})
