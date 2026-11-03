// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { GateFileRootsCompletion } from "@eido/schemas"
import {
  challengeCode,
  checkedFileRoots,
  identity,
  prepareFileRoots,
  requestFromSigned,
  resolvedThroughLink,
  signFileRoots,
  trashPath,
  type FileRootsDevice,
  type PreparedFolders,
} from "@/lib/file-roots"
import {
  CONTROL_ID,
  NONCE,
  identifiedRoots,
  preparedFor,
  reviewRequest,
  signedRoots,
} from "./fixtures/file-roots"
import { stubWebAuthnGlobals } from "./push-device"

const PREPARE = "/api/gate/file-roots/prepare"
const COMPLETE = "/api/gate/file-roots/complete"

type Call = { url: string; body: unknown }

/** Stubs fetch with one handler per URL and records every call's parsed body. */
function gate(
  routes: Record<string, () => Response | Promise<Response>>
): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      calls.push({
        url: input,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      })
      const handler = routes[input]
      return handler
        ? Promise.resolve(handler())
        : Promise.reject(new TypeError("net"))
    })
  )
  return calls
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status })
const apiError = (status: number) =>
  json({ error: "invalid_request", message: "refused" }, status)

beforeEach(() => stubWebAuthnGlobals())
afterEach(() => vi.unstubAllGlobals())

describe("display helpers", () => {
  test("the review request asks for each signed folder by its canonical path", () => {
    expect(requestFromSigned(signedRoots)).toEqual(reviewRequest)
  })

  test("a folder is resolved through a link when the host path differs", () => {
    const [notes, studio] = identifiedRoots.roots
    expect(
      resolvedThroughLink({
        id: "notes",
        requested: "/Users/owner.example/Notes",
        root: notes!.root, // fixture has two roots
      })
    ).toBe(false)
    expect(
      resolvedThroughLink({
        id: "studio",
        requested: "/Users/owner.example/Studio",
        root: studio!.root, // fixture has two roots
      })
    ).toBe(true)
  })

  test("identity is dev:ino", () => {
    expect(
      identity({ path: "/x", dev: "1000004", ino: "2f81a3", trashDir: "t" })
    ).toBe("1000004:2f81a3")
  })

  test("the trash path joins the root with its own separator", () => {
    const root = { dev: "1", ino: "2", trashDir: ".eido-trash" }
    expect(trashPath({ ...root, path: "/Users/owner.example/Notes" })).toBe(
      "/Users/owner.example/Notes/.eido-trash"
    )
    expect(trashPath({ ...root, path: "C:\\Users\\owner\\Notes" })).toBe(
      "C:\\Users\\owner\\Notes\\.eido-trash"
    )
    expect(trashPath({ ...root, path: "/" })).toBe("/.eido-trash")
  })

  test("the challenge code is the first eight bytes in hex, grouped by four", () => {
    expect(
      challengeCode(
        new Uint8Array([0xb7, 0xe2, 0x19, 0xc4, 0x55, 0xaf, 0x0d, 0x31, 0xff])
      )
    ).toBe("b7e2 19c4 55af 0d31")
  })
})

describe("checkedFileRoots", () => {
  test("accepts a list hashed and bound as the gate does", async () => {
    const prepared = preparedFor(identifiedRoots)
    const checked = await checkedFileRoots(reviewRequest, prepared)
    expect(checked?.folders.map((f) => [f.id, f.requested, f.root.path])).toEqual(
      [
        ["notes", "/Users/owner.example/Notes", "/Users/owner.example/Notes"],
        ["studio", "/Users/owner.example/Studio", "/Volumes/Work.example/Studio"],
      ]
    )
    expect(Buffer.from(checked!.challenge).toString("base64url")).toBe(
      prepared.challenge
    )
  })

  test("refuses a payload hash that does not cover the roots", async () => {
    const prepared = preparedFor(identifiedRoots, {
      payloadHash: "0".repeat(64),
    })
    expect(await checkedFileRoots(reviewRequest, prepared)).toBeUndefined()
  })

  test("refuses a challenge over anything else", async () => {
    const prepared = preparedFor(identifiedRoots, { challenge: "A".repeat(43) })
    expect(await checkedFileRoots(reviewRequest, prepared)).toBeUndefined()
  })

  test("refuses a list with a folder dropped, renamed, reordered or retargeted trash", async () => {
    const [notes, studio] = identifiedRoots.roots
    const cases = [
      { roots: [notes!] },
      { roots: [studio!, notes!] },
      { roots: [notes!, { ...studio!, id: "other" }] },
      {
        roots: [
          notes!,
          { ...studio!, root: { ...studio!.root, trashDir: ".other" } },
        ],
      },
    ]
    for (const roots of cases)
      expect(
        await checkedFileRoots(reviewRequest, preparedFor(roots))
      ).toBeUndefined()
  })
})

describe("prepareFileRoots", () => {
  test("posts the request and returns the checked folders", async () => {
    const calls = gate({ [PREPARE]: json(preparedFor(identifiedRoots)) })
    const outcome = await prepareFileRoots(reviewRequest)
    expect(calls).toEqual([{ url: PREPARE, body: reviewRequest }])
    expect(outcome.ok && outcome.value.folders.map((f) => f.id)).toEqual([
      "notes",
      "studio",
    ])
  })

  test.each([
    [
      "an unreachable gate",
      {},
      "Can't reach the gate on the host. Nothing was changed.",
      true,
    ],
    [
      "the proxy reporting the gate down",
      { [PREPARE]: () => new Response("Bad Gateway", { status: 502 }) },
      "Can't reach the gate on the host. Nothing was changed.",
      true,
    ],
    [
      "no file helper",
      { [PREPARE]: apiError(503) },
      "The file helper isn't running on the host. Nothing was changed.",
      false,
    ],
    [
      "a folder the host cannot identify",
      { [PREPARE]: apiError(400) },
      "The host couldn't identify every folder. Nothing was changed.",
      false,
    ],
    [
      "an error body that is not a gate error",
      { [PREPARE]: () => new Response("<html>", { status: 500 }) },
      "The gate sent an unreadable answer. Nothing was changed.",
      false,
    ],
    [
      "a 200 that is not JSON",
      { [PREPARE]: () => new Response("<html>") },
      "The gate sent an unreadable answer. Nothing was changed.",
      false,
    ],
    [
      "a response outside the schema",
      { [PREPARE]: json({ ...preparedFor(identifiedRoots), purpose: "x" }) },
      "The gate sent an unreadable answer. Nothing was changed.",
      false,
    ],
    [
      "a list that does not match the request",
      { [PREPARE]: json(preparedFor({ roots: [] })) },
      "The list the gate prepared does not match the folders asked for. Nothing was signed.",
      false,
    ],
  ])("reports %s", async (_name, routes, message, unreachable) => {
    gate(routes)
    expect(await prepareFileRoots(reviewRequest)).toEqual({
      ok: false,
      message,
      unreachable,
    })
  })

  test("a 401 is an expired session", async () => {
    gate({ [PREPARE]: json({}, 401) })
    expect(await prepareFileRoots(reviewRequest)).toEqual({
      ok: false,
      expired: true,
    })
  })
})

describe("signFileRoots", () => {
  let folders: PreparedFolders
  beforeEach(async () => {
    const checked = await checkedFileRoots(
      reviewRequest,
      preparedFor(identifiedRoots)
    )
    if (checked === undefined) throw new Error("fixture does not check out")
    folders = checked
  })

  function device(
    credential: () => Promise<Credential | null> = () =>
      Promise.resolve(new PublicKeyCredential() as unknown as Credential)
  ) {
    const asked: CredentialRequestOptions[] = []
    const fake: FileRootsDevice = {
      rpId: "eido.example.invalid",
      getCredential: (options) => {
        asked.push(options)
        return credential()
      },
    }
    return { fake, asked }
  }

  test("signs the challenge shown and sends the roots with the authorization", async () => {
    const calls = gate({ [COMPLETE]: json({ saved: true }) })
    const { fake, asked } = device()
    expect(await signFileRoots(folders, fake)).toEqual({ ok: true })
    const publicKey = asked[0]?.publicKey
    expect(publicKey?.rpId).toBe("eido.example.invalid")
    expect(publicKey?.userVerification).toBe("required")
    expect(
      Buffer.from(publicKey?.challenge as ArrayBuffer).toString("base64url")
    ).toBe(preparedFor(identifiedRoots).challenge)
    const expected: GateFileRootsCompletion = {
      roots: identifiedRoots,
      authorization: {
        id: CONTROL_ID,
        nonce: NONCE,
        assertion: {
          credentialId: "CQ",
          authenticatorData: "AQI",
          clientDataJSON: "Aw",
          signature: "BAU",
        },
      },
    }
    expect(calls).toEqual([{ url: COMPLETE, body: expected }])
  })

  test("a dismissed prompt is cancelled and sends nothing", async () => {
    const calls = gate({})
    const { fake } = device(() =>
      Promise.reject(new DOMException("no", "NotAllowedError"))
    )
    expect(await signFileRoots(folders, fake)).toEqual({
      ok: false,
      cancelled: true,
    })
    expect(calls).toEqual([])
  })

  test("a prompt that returns no passkey credential is cancelled", async () => {
    const calls = gate({})
    const { fake } = device(() => Promise.resolve(null))
    expect(await signFileRoots(folders, fake)).toEqual({
      ok: false,
      cancelled: true,
    })
    expect(calls).toEqual([])
  })

  test("Cancel pressed while the prompt was open sends nothing", async () => {
    const calls = gate({ [COMPLETE]: json({ saved: true }) })
    const controller = new AbortController()
    const { fake } = device(() => {
      controller.abort()
      return Promise.resolve(new PublicKeyCredential() as unknown as Credential)
    })
    expect(await signFileRoots(folders, fake, controller.signal)).toEqual({
      ok: false,
      cancelled: true,
    })
    expect(calls).toEqual([])
  })

  test.each([
    [
      "a refused signature",
      { [COMPLETE]: apiError(409) },
      "The gate refused the signature. The allowed folders are unchanged.",
      false,
    ],
    [
      "no WebAuthn on the gate",
      { [COMPLETE]: apiError(503) },
      "The gate can't check signatures right now. Nothing was changed.",
      false,
    ],
    [
      "an unreachable gate",
      {},
      "Can't reach the gate on the host. Nothing was changed.",
      true,
    ],
    [
      "an answer that is not saved",
      { [COMPLETE]: json({ saved: false }) },
      "The gate sent an unreadable answer. Nothing was changed.",
      false,
    ],
  ])("reports %s", async (_name, routes, message, unreachable) => {
    gate(routes)
    expect(await signFileRoots(folders, device().fake)).toEqual({
      ok: false,
      message,
      unreachable,
    })
  })

  test("a 401 at complete is an expired session", async () => {
    gate({ [COMPLETE]: json({}, 401) })
    expect(await signFileRoots(folders, device().fake)).toEqual({
      ok: false,
      expired: true,
    })
  })
})
