// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { FolderReviewView } from "../components/folder-review-view"
import type { FileRootsDevice } from "@/lib/file-roots"
import { clearDraft, readDraft, saveDraft } from "@/lib/file-roots-draft"
import {
  challengeHex,
  firstFolderIdentified,
  firstFolderRequest,
  identifiedRoots,
  preparedFor,
  signedRoots,
} from "./fixtures/file-roots"
import { stubWebAuthnGlobals } from "./push-device"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const LIST = "/api/gate/file-roots"
const PREPARE = "/api/gate/file-roots/prepare"
const COMPLETE = "/api/gate/file-roots/complete"

type Routes = Record<string, () => Response>

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status })

function gate(routes: Routes): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      urls.push(input)
      const handler = routes[input]
      return handler
        ? Promise.resolve(handler())
        : Promise.reject(new TypeError("net"))
    })
  )
  return urls
}

const reviewable: Routes = {
  [LIST]: json(signedRoots),
  [PREPARE]: json(preparedFor(identifiedRoots)),
}

/** A passkey prompt the test settles by hand, or that follows the abort signal. */
function prompt() {
  let resolve: (value: Credential | null) => void = () => undefined
  const device: FileRootsDevice = {
    rpId: "eido.example.invalid",
    getCredential: (options) =>
      new Promise((done, fail) => {
        resolve = done
        options.signal?.addEventListener("abort", () =>
          fail(new DOMException("aborted", "AbortError"))
        )
      }),
  }
  return {
    device,
    approve: () => resolve(new PublicKeyCredential()),
  }
}

let container: HTMLElement
let root: Root

beforeEach(() => {
  stubWebAuthnGlobals()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  clearDraft()
  vi.unstubAllGlobals()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const PREPARING = "Asking the host to identify each folder…"

/** WebCrypto hashing resolves over many ticks: let the page work until it leaves preparing. */
async function render(device?: FileRootsDevice, untilPrepared = true) {
  await act(async () => {
    root.render(<FolderReviewView device={device} />)
    await settle()
  })
  if (untilPrepared)
    await vi.waitFor(async () => {
      await act(settle)
      expect(container.textContent).not.toContain(PREPARING)
    })
}

const button = (name: RegExp) => {
  const found = [...container.querySelectorAll("button")].find((b) =>
    name.test(b.textContent ?? "")
  )
  if (found === undefined) throw new Error(`no button ${String(name)}`)
  return found
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click()
    await settle()
  })
}

const status = () =>
  container.querySelector('p[role="status"]')?.textContent ?? ""
const alertText = () =>
  container.querySelector('[role="alert"]')?.textContent ?? ""

describe("reviewing", () => {
  test("re-identifies the signed folders and shows each as the host sees it", async () => {
    const urls = gate(reviewable)
    await render()
    expect(urls).toEqual([LIST, PREPARE])
    const table = container.querySelector("table")?.textContent ?? ""
    for (const value of [
      "/Users/owner.example/Studio",
      "/Volumes/Work.example/Studio",
      "1000009:a0c47e",
      "/Volumes/Work.example/Studio/.eido-trash",
      "/Users/owner.example/Notes/.eido-trash",
    ])
      expect(table).toContain(value)
  })

  test("marks only the folder resolved through a link", async () => {
    gate(reviewable)
    await render()
    const rows = [...container.querySelectorAll("tbody tr")]
    expect(
      rows.map((row) => row.textContent?.includes("Resolved through a link"))
    ).toEqual([false, true])
  })

  test("shows the challenge beside Sign", async () => {
    gate(reviewable)
    await render()
    const card = button(/Sign with/).closest('[data-slot="card"]')
    expect(card?.textContent).toContain(
      challengeHex(preparedFor(identifiedRoots).challenge)
    )
  })

  test("no signed folders asks the host for nothing", async () => {
    const urls = gate({ [LIST]: json({ roots: [] }) })
    await render()
    expect(urls).toEqual([LIST])
    expect(status()).toBe("No allowed folders are signed.")
  })

  test("a list the host cannot identify says so", async () => {
    gate({
      [LIST]: json(signedRoots),
      [PREPARE]: json({ code: "invalid_request", message: "no" }, 400),
    })
    await render()
    expect(alertText()).toBe(
      "The host couldn't identify every folder. Nothing was changed."
    )
  })

  test("a list that cannot be read says so", async () => {
    gate({ [LIST]: () => new Response("{}", { status: 500 }) })
    await render()
    expect(alertText()).toBe(
      "Could not read the allowed folders from the gate."
    )
  })

  test("an expired session sends the owner to unlock", async () => {
    gate({ [LIST]: json({}, 401) })
    const replace = vi.fn()
    vi.stubGlobal("location", {
      ...window.location,
      replace,
      pathname: "/settings/folders/review",
      search: "",
    })
    await render(undefined, false)
    expect(String(replace.mock.calls[0]?.[0])).toContain("/unlock")
  })
})

describe("signing", () => {
  test("Sign waits for the passkey, then stores the list", async () => {
    const urls = gate({ ...reviewable, [COMPLETE]: json({ saved: true }) })
    const { device, approve } = prompt()
    await render(device)
    await click(button(/Sign with/))
    expect(status()).toBe("Waiting for your passkey…")
    expect(button(/Sign with/).disabled).toBe(true)
    await act(async () => {
      approve()
      await settle()
    })
    await vi.waitFor(async () => {
      await act(settle)
      expect(status()).toBe("Allowed folders updated.")
    })
    expect(urls).toEqual([LIST, PREPARE, COMPLETE])
  })

  test("a refused signature says the folders are unchanged", async () => {
    gate({
      ...reviewable,
      [COMPLETE]: json({ code: "already_decided", message: "no" }, 409),
    })
    const { device, approve } = prompt()
    await render(device)
    await click(button(/Sign with/))
    await act(async () => {
      approve()
      await settle()
    })
    await vi.waitFor(async () => {
      await act(settle)
      expect(alertText()).toBe(
        "The gate refused the signature. The allowed folders are unchanged."
      )
    })
  })

  test("an expired session at complete sends the owner to unlock", async () => {
    gate({ ...reviewable, [COMPLETE]: json({}, 401) })
    const replace = vi.fn()
    vi.stubGlobal("location", {
      ...window.location,
      replace,
      pathname: "/settings/folders/review",
      search: "",
    })
    const { device, approve } = prompt()
    await render(device)
    await click(button(/Sign with/))
    await act(async () => {
      approve()
      await settle()
    })
    await vi.waitFor(async () => {
      await act(settle)
      expect(String(replace.mock.calls[0]?.[0])).toContain("/unlock")
    })
  })
})

describe("cancelling", () => {
  test("Cancel before signing discards the list and sends nothing", async () => {
    const urls = gate(reviewable)
    await render(prompt().device)
    await click(button(/^Cancel$/))
    expect(status()).toBe("Not signed. The allowed folders are unchanged.")
    expect(container.querySelector("table")).toBeNull()
    expect(urls).toEqual([LIST, PREPARE])
  })

  test("Cancel while the passkey prompt is open closes it and sends nothing", async () => {
    const urls = gate({ ...reviewable, [COMPLETE]: json({ saved: true }) })
    await render(prompt().device)
    await click(button(/Sign with/))
    await click(button(/^Cancel$/))
    expect(status()).toBe("Not signed. The allowed folders are unchanged.")
    expect(urls).toEqual([LIST, PREPARE])
  })
})

describe("an edited list", () => {
  const openedFromEditor = (replace = vi.fn()) => {
    vi.stubGlobal("location", {
      ...window.location,
      replace,
      pathname: "/settings/folders/review",
      search: "?list=edited",
    })
    return replace
  }

  test("an owner with no signed folders signs the first folder from the editor", async () => {
    saveDraft(firstFolderRequest)
    openedFromEditor()
    const urls = gate({
      [PREPARE]: json(preparedFor(firstFolderIdentified)),
      [COMPLETE]: json({ saved: true }),
    })
    const { device, approve } = prompt()
    await render(device)
    const sent = vi.mocked(fetch).mock.calls[0]?.[1]?.body
    expect(typeof sent === "string" ? JSON.parse(sent) : sent).toEqual(
      firstFolderRequest
    )
    expect(status()).toBe(
      "1 folder · check each one as the host sees it, then sign."
    )
    await click(button(/Sign with/))
    await act(async () => {
      approve()
      await settle()
    })
    await vi.waitFor(async () => {
      await act(settle)
      expect(status()).toBe("Allowed folders updated.")
    })
    expect(urls).toEqual([PREPARE, COMPLETE])
    expect(readDraft()).toBeUndefined()
  })

  test("with no list kept, sends the owner back to the editor and asks for nothing", async () => {
    const replace = openedFromEditor()
    const urls = gate(reviewable)
    await render(undefined, false)
    expect(replace).toHaveBeenCalledWith("/settings/folders/edit")
    expect(urls).toEqual([])
  })

  test("Cancel drops the kept list", async () => {
    saveDraft(firstFolderRequest)
    openedFromEditor()
    gate({ [PREPARE]: json(preparedFor(firstFolderIdentified)) })
    await render(prompt().device)
    await click(button(/^Cancel$/))
    expect(status()).toBe("Not signed. The allowed folders are unchanged.")
    expect(readDraft()).toBeUndefined()
  })
})
