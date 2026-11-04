// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { CoreApiDocumentType } from "@eido/schemas"
import { DocumentTypeControl } from "../components/document-type-control"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const SHA256 = "c".repeat(64)

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let container: HTMLElement
let root: Root
const onSaved = vi.fn<(saved: CoreApiDocumentType) => void>()

async function mount(props: {
  type: string | null
  typeSource: "model" | "user" | null
}) {
  await act(async () => {
    root.render(
      <DocumentTypeControl sha256={SHA256} onSaved={onSaved} {...props} />
    )
    await flush()
  })
}

function shownType(): string | null | undefined {
  return container.querySelector('[data-slot="select-value"]')?.textContent
}

function trigger(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="combobox"]')
  if (!el) throw new Error("Type select not rendered")
  return el
}

async function choose(label: string) {
  await act(async () => {
    trigger().click()
    await flush()
  })
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]')
  ).find((o) => o.textContent?.includes(label))
  if (!option) throw new Error(`No option ${label}`)
  await act(async () => {
    option.click()
    await flush()
    await flush()
  })
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  onSaved.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("DocumentTypeControl", () => {
  test("offers exactly the schema labels", async () => {
    await mount({ type: "Quote", typeSource: "model" })
    await act(async () => {
      trigger().click()
      await flush()
    })
    expect(
      Array.from(document.querySelectorAll('[role="option"]')).map(
        (o) => o.textContent
      )
    ).toEqual([
      "Invoice",
      "Quote",
      "Receipt",
      "Tax bill",
      "Contract",
      "Insurance policy",
      "Statement",
      "Letter",
      "Other",
    ])
  })

  test("saves the chosen type with PUT and reports the stored result", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            sha256: SHA256,
            type: "Receipt",
            typeSource: "user",
          }),
          { status: 200 }
        )
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    await mount({ type: "Quote", typeSource: "model" })
    await choose("Receipt")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe(`/api/core/documents/${SHA256}/type`)
    expect(init.method).toBe("PUT")
    expect(init.body).toBe('{"type":"Receipt"}')
    expect(onSaved).toHaveBeenCalledWith({
      sha256: SHA256,
      type: "Receipt",
      typeSource: "user",
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  test("marks a type set by the owner and no other", async () => {
    await mount({ type: "Quote", typeSource: "user" })
    expect(container.textContent).toContain("Set by you")
    await mount({ type: "Quote", typeSource: "model" })
    expect(container.textContent).not.toContain("Set by you")
  })

  test.each([
    ["400", () => new Response("{}", { status: 400 })],
    ["404", () => new Response("{}", { status: 404 })],
    ["network failure", () => Promise.reject(new TypeError("network"))],
    [
      "a response for another document",
      () =>
        new Response(
          JSON.stringify({
            sha256: "d".repeat(64),
            type: "Receipt",
            typeSource: "user",
          }),
          { status: 200 }
        ),
    ],
  ])(
    "a failed save (%s) shows the error and keeps the old type",
    async (_n, answer) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => answer())
      )
      await mount({ type: "Quote", typeSource: "model" })
      await choose("Receipt")
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Couldn't change the type. It's still Quote."
      )
      expect(shownType()).toBe("Quote")
      expect(trigger().hasAttribute("disabled")).toBe(false)
      expect(container.textContent).not.toContain("Set by you")
      expect(onSaved).not.toHaveBeenCalled()
    }
  )

  test("shows the new value and disables the select until core answers", async () => {
    let answer: (r: Response) => void = () => undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve
          })
      )
    )
    await mount({ type: "Quote", typeSource: "model" })
    await choose("Receipt")
    expect(shownType()).toBe("Receipt")
    expect(trigger().hasAttribute("disabled")).toBe(true)
    await act(async () => {
      answer(new Response("{}", { status: 404 }))
      await flush()
    })
    expect(shownType()).toBe("Quote")
  })

  test("a document with no type reports the failure without a previous type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 400 })))
    )
    await mount({ type: null, typeSource: null })
    expect(shownType()).toBe("Not set")
    await choose("Letter")
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't change the type."
    )
  })
})
