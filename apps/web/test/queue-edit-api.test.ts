import { afterEach, describe, expect, test, vi } from "vitest"
import { editIntent } from "../lib/queue/api"
import { editableFields } from "../lib/queue/edit"

const INTENT = { kind: "email.reply", args: { subject: "Re: new" } }

function gateAnswers(response: Response | Error) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response)
    )
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("editIntent", () => {
  test("a gate that cannot be reached is a network failure", async () => {
    gateAnswers(new TypeError("offline"))
    expect(await editIntent("i-1", INTENT)).toEqual({
      ok: false,
      error: { code: "network", message: "The gate could not be reached." },
    })
  })

  test("an intent that was already decided keeps its code", async () => {
    gateAnswers(
      Response.json(
        { code: "already_decided", message: "the intent is no longer pending" },
        { status: 409 }
      )
    )
    expect(await editIntent("i-1", INTENT)).toMatchObject({
      ok: false,
      error: { code: "already_decided" },
    })
  })

  test("an error body the gate does not define falls back to the status", async () => {
    gateAnswers(
      Response.json({ code: "busy", message: "later" }, { status: 503 })
    )
    expect(await editIntent("i-1", INTENT)).toEqual({
      ok: false,
      error: { code: "other", message: "The gate answered 503." },
    })
  })

  test("a body that is not JSON falls back to the status", async () => {
    gateAnswers(new Response("oops", { status: 500 }))
    expect(await editIntent("i-1", INTENT)).toEqual({
      ok: false,
      error: { code: "other", message: "The gate answered 500." },
    })
  })

  test("a success that is not a prepared approval is unreadable", async () => {
    gateAnswers(Response.json({ intentId: "i-2" }))
    expect(await editIntent("i-1", INTENT)).toEqual({
      ok: false,
      error: { code: "other", message: "The gate sent an unreadable result." },
    })
  })
})

describe("editableFields on a malformed payload", () => {
  test("an intent whose args are not an object has nothing to edit", () => {
    expect(
      editableFields(JSON.stringify({ kind: "email.reply", args: "x" }))
    ).toEqual([])
  })
})
