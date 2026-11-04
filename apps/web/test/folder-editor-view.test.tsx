// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { FolderEditorView } from "../components/folder-editor-view"
import { clearDraft, readDraft, saveDraft } from "@/lib/file-roots-draft"
import { firstFolderRequest, signedRoots } from "./fixtures/file-roots"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const push = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

const LIST = "/api/gate/file-roots"

function gate(list: () => Response): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      urls.push(input)
      return input === LIST
        ? Promise.resolve(list())
        : Promise.reject(new TypeError("net"))
    })
  )
  return urls
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status })

let container: HTMLElement
let root: Root

beforeEach(() => {
  push.mockReset()
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

async function render() {
  await act(async () => {
    root.render(<FolderEditorView />)
    await settle()
  })
  await act(settle)
}

const button = (name: RegExp) => {
  const found = [...container.querySelectorAll("button")].find((b) =>
    name.test(b.getAttribute("aria-label") ?? b.textContent ?? "")
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

/** Each folder row as [id, path, trash name], read from the inputs. */
const rows = () =>
  [...container.querySelectorAll("li")].map((li) =>
    [...li.querySelectorAll("input")].map((input) => input.value)
  )

const inputs = (row: number) => [
  ...(container.querySelectorAll("li")[row]?.querySelectorAll("input") ?? []),
]

async function type(input: HTMLInputElement | undefined, value: string) {
  if (input === undefined) throw new Error("no input")
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
  })
}

const status = () =>
  container.querySelector('p[role="status"]')?.textContent ?? ""
const alertText = () =>
  container.querySelector('[role="alert"]')?.textContent ?? ""

describe("starting", () => {
  test("fills the editor with the signed list", async () => {
    gate(json(signedRoots))
    await render()
    expect(status()).toBe("2 folders")
    expect(rows()).toEqual([
      ["notes", "/Users/owner.example/Notes", ".eido-trash"],
      ["studio", "/Users/owner.example/Studio", ".eido-trash"],
    ])
    const labels = [
      ...container.querySelectorAll("li")[0]!.querySelectorAll("label"),
    ].map((label) => label.textContent)
    expect(labels).toEqual(["Id", "Path", "Trash name"])
  })

  test("a list kept for review comes back without asking the gate", async () => {
    saveDraft(firstFolderRequest)
    const urls = gate(json(signedRoots))
    await render()
    expect(urls).toEqual([])
    expect(rows()).toEqual([
      ["rental", "/Users/owner.example/Rental", ".eido-trash"],
    ])
  })

  test("an expired session sends the owner to unlock", async () => {
    gate(json({}, 401))
    const replace = vi.fn()
    vi.stubGlobal("location", {
      ...window.location,
      replace,
      pathname: "/settings/folders/edit",
      search: "",
    })
    await render()
    expect(String(replace.mock.calls[0]?.[0])).toContain("/unlock")
  })
})

describe("editing", () => {
  test("Add folder adds a blank folder with the default trash name", async () => {
    gate(json(signedRoots))
    await render()
    await click(button(/^Add folder$/))
    expect(status()).toBe("3 folders")
    expect(rows()[2]).toEqual(["", "", ".eido-trash"])
  })

  test("Remove takes only that folder out", async () => {
    gate(json(signedRoots))
    await render()
    await click(button(/^Remove notes$/))
    expect(rows()).toEqual([
      ["studio", "/Users/owner.example/Studio", ".eido-trash"],
    ])
  })

  test("typing changes only the field typed in", async () => {
    gate(json(signedRoots))
    await render()
    await type(inputs(1)[1], "/Volumes/Work.example/Studio")
    expect(rows()).toEqual([
      ["notes", "/Users/owner.example/Notes", ".eido-trash"],
      ["studio", "/Volumes/Work.example/Studio", ".eido-trash"],
    ])
  })
})

describe("reviewing", () => {
  test("an owner with no folders adds one and Review hands exactly it to review", async () => {
    gate(json({ roots: [] }))
    await render()
    expect(status()).toBe("No folders yet.")
    await click(button(/^Add folder$/))
    await type(inputs(0)[0], "rental")
    await type(inputs(0)[1], "/Users/owner.example/Rental")
    await click(button(/^Review$/))
    expect(push).toHaveBeenCalledWith("/settings/folders/review?list=edited")
    expect(readDraft()).toEqual(firstFolderRequest)
  })

  test("a bad id stops Review, marks the field and clears once fixed", async () => {
    gate(json(signedRoots))
    await render()
    await type(inputs(1)[0], "Studio")
    await click(button(/^Review$/))
    expect(push).not.toHaveBeenCalled()
    expect(readDraft()).toBeUndefined()
    expect(alertText()).toBe("Ids use lowercase letters, digits and dashes.")
    expect(
      [inputs(0)[0], inputs(1)[0]].map((input) =>
        input?.getAttribute("aria-invalid")
      )
    ).toEqual([null, "true"])
    await type(inputs(1)[0], "studio")
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(inputs(1)[0]?.getAttribute("aria-invalid")).toBeNull()
  })

  test("Cancel drops the kept list and goes back to Settings", async () => {
    saveDraft(firstFolderRequest)
    gate(json(signedRoots))
    await render()
    await click(button(/^Cancel$/))
    expect(readDraft()).toBeUndefined()
    expect(push).toHaveBeenCalledWith("/settings")
  })
})
