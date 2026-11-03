// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { UndoControl } from "../components/undo-control"
import { EXECUTED_ID } from "./fixtures/activity"
import { describeStates } from "./render-states"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const noop = () => undefined

describeStates("Undo control from the gate's projection", [
  {
    state: "undone",
    render: () => (
      <UndoControl
        executionId={EXECUTED_ID}
        projection="done"
        onSettled={noop}
        onSignedOut={noop}
      />
    ),
    role: "status",
    message: "Undone",
  },
])

let container: HTMLElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const tick = () => new Promise((r) => setTimeout(r, 0))
async function mount(
  projection: "available" | "done" | "none",
  callbacks: { onSettled?: () => void; onSignedOut?: () => void } = {}
) {
  await act(async () => {
    root.render(
      <UndoControl
        executionId={EXECUTED_ID}
        projection={projection}
        onSettled={callbacks.onSettled ?? noop}
        onSignedOut={callbacks.onSignedOut ?? noop}
      />
    )
    await tick()
  })
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label)
const region = (role: "status" | "alert") =>
  container.querySelector(`[role="${role}"]`)?.textContent ?? null

test("none renders nothing", async () => {
  await mount("none")
  expect(container.innerHTML).toBe("")
})

test("available shows Undo with no announcement", async () => {
  await mount("available")
  expect(button("Undo")).toBeDefined()
  expect(region("status")).toBeNull()
  expect(region("alert")).toBeNull()
})

test("Undoing… while the request is open, then Undone on a confirmed response", async () => {
  let release: (r: Response) => void = noop
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() => new Promise((resolve) => (release = resolve)))
  )
  const onSettled = vi.fn()
  await mount("available", { onSettled })
  await act(async () => {
    button("Undo")?.click()
    await tick()
  })
  expect(region("status")).toBe("Undoing…")
  expect(container.querySelector("button")?.disabled).toBe(true)
  expect(onSettled).not.toHaveBeenCalled()
  await act(async () => {
    release(Response.json({ id: EXECUTED_ID, undone: true }))
    await tick()
  })
  expect(region("status")).toBe("Undone")
  expect(container.querySelector("button")).toBeNull()
  expect(onSettled).toHaveBeenCalledTimes(1)
})

test("a double click issues one call", async () => {
  const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(noop))
  vi.stubGlobal("fetch", fetchMock)
  await mount("available")
  await act(async () => {
    const undo = button("Undo")
    undo?.click()
    undo?.click()
    await tick()
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("an unconfirmed response shows the error with Retry, never Undone, and Retry calls again", async () => {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      Response.json({ error: "already_decided" }, { status: 409 })
    )
  )
  vi.stubGlobal("fetch", fetchMock)
  const onSettled = vi.fn()
  await mount("available", { onSettled })
  await act(async () => {
    button("Undo")?.click()
    await tick()
  })
  expect(region("alert")).toBe("Could not undo.")
  expect(region("status")).toBeNull()
  expect(onSettled).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  fetchMock.mockImplementation(() =>
    Promise.resolve(Response.json({ id: EXECUTED_ID, undone: true }))
  )
  await act(async () => {
    button("Retry")?.click()
    await tick()
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(region("status")).toBe("Undone")
})

test("a 401 signs out without settling", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 401 }))
    )
  )
  const onSettled = vi.fn()
  const onSignedOut = vi.fn()
  await mount("available", { onSettled, onSignedOut })
  await act(async () => {
    button("Undo")?.click()
    await tick()
  })
  expect(onSignedOut).toHaveBeenCalledTimes(1)
  expect(onSettled).not.toHaveBeenCalled()
})
