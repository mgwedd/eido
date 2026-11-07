// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AdminModelView } from "../components/admin-model-view"
import type { StackModelList } from "@eido/schemas"
import {
  fetchFailed,
  fetchRunning,
  fetchSucceeded,
  gptOss,
  modelList,
  qwen,
  stackWith,
} from "./fixtures/admin-model"

const admin = vi.hoisted(() => ({
  elevated: vi.fn(),
  sessionEnded: vi.fn(),
}))
vi.mock("../components/admin-step-up", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAdmin: () => ({
    elevatedUntil: null,
    signed: vi.fn(),
    elevated: admin.elevated,
    sessionEnded: admin.sessionEnded,
  }),
}))

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  // Elevation is granted: run the action straight away, as a live step-up does.
  admin.elevated.mockImplementation(
    (_action: string, run: () => Promise<unknown>) => run()
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  admin.elevated.mockReset()
  admin.sessionEnded.mockReset()
})

type Route = (init: RequestInit | undefined) => Response | Promise<Response>
/** Stubs fetch by "METHOD path"; an unlisted route fails like an unreachable gate. */
function gate(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown }[] = []
  const stub = vi.fn<typeof fetch>((input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const key = `${init?.method ?? "GET"} ${url.replace("/api/gate", "")}`
    calls.push({
      key,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    const route = routes[key]
    return route
      ? Promise.resolve(route(init))
      : Promise.reject(new TypeError("no route"))
  })
  vi.stubGlobal("fetch", stub)
  return calls
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

async function render() {
  act(() => {
    root.render(<AdminModelView />)
  })
  await settle()
}

const card = (id: string) =>
  container.querySelector<HTMLElement>(`[aria-labelledby="model-${id}"]`)!
const buttons = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].map((b) => b.textContent)
const click = async (el: Element | undefined | null) => {
  act(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await settle()
}
const buttonIn = (id: string, text: string) =>
  [...card(id).querySelectorAll("button")].find((b) => b.textContent === text)

const okRoutes = {
  "GET /admin/models": () => Response.json(modelList),
  "GET /admin/stack": () => Response.json(stackWith([])),
}

test("reads the models and the stack, and offers Use, Fetch and nothing for the active profile", async () => {
  const calls = gate(okRoutes)
  await render()
  expect(calls.map((c) => c.key).sort()).toEqual([
    "GET /admin/models",
    "GET /admin/stack",
  ])
  expect(card("gemma-4-26b-a4b").textContent).toContain("Default")
  expect(card("gemma-4-26b-a4b").textContent).toContain("Active")
  expect(buttons(card("gemma-4-26b-a4b"))).toEqual([])
  expect(card("qwen3.6-35b-a3b").textContent).toContain(
    "Qwen3.6 35B A3B · Q4_K_M · 21.0 GB"
  )
  expect(card("qwen3.6-35b-a3b").textContent).not.toContain("Active")
  expect(buttons(card("qwen3.6-35b-a3b"))).toEqual(["Use"])
  expect(card("gpt-oss-20b").textContent).toContain("Not on disk")
  expect(buttons(card("gpt-oss-20b"))).toEqual(["Fetch"])
})

test("Use asks for elevation, posts to the profile's use route and moves the Active chip", async () => {
  let release: (r: Response) => void = () => undefined
  const switched: StackModelList = { ...modelList, active: qwen.id }
  const calls = gate({
    ...okRoutes,
    "POST /admin/models/qwen3.6-35b-a3b/use": () =>
      new Promise<Response>((resolve) => {
        release = resolve
      }),
  })
  await render()
  await click(buttonIn(qwen.id, "Use"))
  expect(admin.elevated).toHaveBeenCalledWith(
    "Use qwen3.6-35b-a3b",
    expect.any(Function)
  )
  expect(calls.at(-1)).toEqual({
    key: "POST /admin/models/qwen3.6-35b-a3b/use",
    body: {},
  })
  expect(container.textContent).toContain(
    "Switching to qwen3.6-35b-a3b. llama restarts; Ask waits until it answers."
  )
  expect(buttons(card(qwen.id))).toEqual(["Switching…"])
  expect(buttonIn(qwen.id, "Switching…")?.hasAttribute("disabled")).toBe(true)
  expect(buttonIn(gptOss.id, "Fetch")?.hasAttribute("disabled")).toBe(true)

  act(() => release(Response.json(switched)))
  await settle()
  expect(container.textContent).not.toContain("Switching to")
  expect(card(qwen.id).textContent).toContain("Active")
  expect(card("gemma-4-26b-a4b").textContent).not.toContain("Active")
  expect(buttons(card("gemma-4-26b-a4b"))).toEqual(["Use"])
})

test("a step-up the owner cancels sends nothing and shows no switch", async () => {
  admin.elevated.mockResolvedValue({ kind: "cancelled" })
  const calls = gate(okRoutes)
  await render()
  await click(buttonIn(qwen.id, "Use"))
  expect(calls.map((c) => c.key)).not.toContain(
    "POST /admin/models/qwen3.6-35b-a3b/use"
  )
  expect(container.textContent).not.toContain("Switching")
  expect(buttons(card(qwen.id))).toEqual(["Use"])
})

test("Use refused because another job runs says so and keeps the page", async () => {
  gate({
    ...okRoutes,
    "POST /admin/models/qwen3.6-35b-a3b/use": () =>
      Response.json({ code: "busy", message: "x" }, { status: 503 }),
  })
  await render()
  await click(buttonIn(qwen.id, "Use"))
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Another stack job is running. Try again when it finishes."
  )
  expect(buttons(card(qwen.id))).toEqual(["Use"])
})

test("another refusal of Use names the profile; the supervisor going down replaces the page", async () => {
  gate({
    ...okRoutes,
    "POST /admin/models/qwen3.6-35b-a3b/use": () =>
      Response.json(
        { code: "stack_not_running", message: "x" },
        { status: 409 }
      ),
  })
  await render()
  await click(buttonIn(qwen.id, "Use"))
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not switch to qwen3.6-35b-a3b."
  )

  gate({
    ...okRoutes,
    "POST /admin/models/qwen3.6-35b-a3b/use": () =>
      Response.json(
        { code: "supervisor_unavailable", message: "x" },
        { status: 503 }
      ),
  })
  await click(buttonIn(qwen.id, "Use"))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "The stack supervisor is not answering."
  )
  expect(container.querySelectorAll("button")).toHaveLength(0)
})

test("Fetch posts to the fetch route, shows progress, polls the stack and re-reads the profiles when it ends", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const stackReads = [
    stackWith([{ ...fetchRunning, receivedBytes: 9_000_000_000 }]),
    stackWith([fetchSucceeded]),
  ]
  let modelReads = 0
  let stackCalls = 0
  const calls = gate({
    "GET /admin/models": () => {
      modelReads += 1
      return Response.json(
        modelReads === 1
          ? modelList
          : {
              ...modelList,
              profiles: modelList.profiles.map((p) =>
                p.id === gptOss.id
                  ? { ...p, disk: "present", verified: true }
                  : p
              ),
            }
      )
    },
    "GET /admin/stack": () =>
      Response.json(
        stackCalls++ === 0
          ? stackWith([])
          : (stackReads.shift() ?? stackWith([]))
      ),
    "POST /admin/models/gpt-oss-20b/fetch": () =>
      Response.json({ processes: [], tasks: [fetchRunning] }, { status: 202 }),
  })
  await render()
  await click(buttonIn(gptOss.id, "Fetch"))
  expect(admin.elevated).toHaveBeenCalledWith(
    "Fetch gpt-oss-20b",
    expect.any(Function)
  )
  expect(calls.at(-1)?.key).toBe("POST /admin/models/gpt-oss-20b/fetch")
  const bar = () =>
    card(gptOss.id)
      .querySelector('[role="progressbar"]')
      ?.getAttribute("aria-valuenow")
  expect(bar()).toBe("51")
  expect(buttons(card(gptOss.id))).toEqual([])
  expect(buttonIn(qwen.id, "Use")?.hasAttribute("disabled")).toBe(true)

  const before = calls.length
  act(() => {
    vi.advanceTimersByTime(2000)
  })
  await settle()
  expect(calls[before]?.key).toBe("GET /admin/stack")
  expect(card(gptOss.id).textContent).toContain("9.0 of 12.1 GB")
  expect(bar()).toBe("74")

  act(() => {
    vi.advanceTimersByTime(2000)
  })
  await settle()
  expect(card(gptOss.id).textContent).toContain("On disk · verified")
  expect(card(gptOss.id).querySelector('[role="progressbar"]')).toBeNull()

  const after = calls.length
  act(() => {
    vi.advanceTimersByTime(10_000)
  })
  expect(calls).toHaveLength(after)
})

test("polling stops when the page unmounts", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const calls = gate({
    "GET /admin/models": () => Response.json(modelList),
    "GET /admin/stack": () => Response.json(stackWith([fetchRunning])),
  })
  await render()
  expect(card(gptOss.id).querySelector('[role="progressbar"]')).not.toBeNull()
  act(() => root.unmount())
  const count = calls.length
  act(() => {
    vi.advanceTimersByTime(10_000)
  })
  expect(calls).toHaveLength(count)
  root = createRoot(container)
})

test("a fetch that failed shows how far it got and offers Fetch again", async () => {
  gate({
    "GET /admin/models": () => Response.json(modelList),
    "GET /admin/stack": () => Response.json(stackWith([fetchFailed])),
    "POST /admin/models/gpt-oss-20b/fetch": () =>
      Response.json(
        {
          processes: [],
          tasks: [fetchFailed, { ...fetchRunning, id: "task-2" }],
        },
        { status: 202 }
      ),
  })
  await render()
  expect(card(gptOss.id).querySelector('[role="alert"]')?.textContent).toBe(
    "Fetch failed: the download stopped at 3.4 GB. Nothing was kept."
  )
  expect(buttons(card(gptOss.id))).toEqual(["Fetch again"])
  await click(buttonIn(gptOss.id, "Fetch again"))
  expect(card(gptOss.id).querySelector('[role="alert"]')).toBeNull()
  expect(card(gptOss.id).querySelector('[role="progressbar"]')).not.toBeNull()
})

test("a wrong-size file is offered Fetch", async () => {
  gate({
    "GET /admin/models": () =>
      Response.json({
        ...modelList,
        profiles: [{ ...gptOss, disk: "wrong_size" }],
      }),
    "GET /admin/stack": () => Response.json(stackWith([])),
  })
  await render()
  expect(card(gptOss.id).textContent).toContain("On disk · wrong size")
  expect(buttons(card(gptOss.id))).toEqual(["Fetch"])
})

test("the supervisor being down shows its message with no Use or Fetch", async () => {
  gate({
    "GET /admin/models": () =>
      Response.json(
        { code: "supervisor_unavailable", message: "x" },
        { status: 503 }
      ),
    "GET /admin/stack": () => Response.json({ supervisor: "unavailable" }),
  })
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "The stack supervisor is not answering. Start, Stop, Restart and the checks are hidden until it answers. On the Mac, run pnpm stack:status."
  )
  expect(container.querySelectorAll("button")).toHaveLength(0)
})

test("an unreachable gate shows the shared message and Retry reads again", async () => {
  gate({})
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Can't reach the gate on the host."
  )
  const calls = gate(okRoutes)
  await click(container.querySelector("button"))
  expect(calls.map((c) => c.key)).toContain("GET /admin/models")
  expect(card(qwen.id)).not.toBeNull()
})

test("an unreadable answer shows the error with Retry", async () => {
  gate({
    "GET /admin/models": () => Response.json({ nope: true }),
    "GET /admin/stack": () => Response.json(stackWith([])),
  })
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not read the models from the gate."
  )
})

test("a session that ended sends the owner to sign in again", async () => {
  gate({
    "GET /admin/models": () => new Response(null, { status: 401 }),
    "GET /admin/stack": () => new Response(null, { status: 401 }),
  })
  await render()
  expect(admin.sessionEnded).toHaveBeenCalledTimes(1)
})

test("Use that cannot reach the gate shows the shared message", async () => {
  gate({ ...okRoutes })
  await render()
  await click(buttonIn(qwen.id, "Use"))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Can't reach the gate on the host."
  )
})

test("Use answered outside the schema, or a step-up that did not stick, says it could not switch", async () => {
  gate({
    ...okRoutes,
    "POST /admin/models/qwen3.6-35b-a3b/use": () => Response.json({ nope: 1 }),
  })
  await render()
  await click(buttonIn(qwen.id, "Use"))
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not switch to qwen3.6-35b-a3b."
  )
  admin.elevated.mockResolvedValue({ kind: "step-up" })
  await click(buttonIn(qwen.id, "Use"))
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not switch to qwen3.6-35b-a3b."
  )
})

test("a Use that ends with the session sends the owner to sign in and keeps the page", async () => {
  admin.elevated.mockResolvedValue({ kind: "expired" })
  gate(okRoutes)
  await render()
  await click(buttonIn(qwen.id, "Use"))
  expect(card(qwen.id)).not.toBeNull()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

test("Fetch refused because another job runs, or with an answer outside the schema, says so", async () => {
  gate({
    ...okRoutes,
    "POST /admin/models/gpt-oss-20b/fetch": () =>
      Response.json({ code: "busy", message: "x" }, { status: 503 }),
  })
  await render()
  await click(buttonIn(gptOss.id, "Fetch"))
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Another stack job is running. Try again when it finishes."
  )
  gate({
    ...okRoutes,
    "POST /admin/models/gpt-oss-20b/fetch": () =>
      Response.json(
        { code: "supervisor_failed", message: "x" },
        { status: 502 }
      ),
  })
  await click(buttonIn(gptOss.id, "Fetch"))
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not start the fetch of gpt-oss-20b."
  )
  admin.elevated.mockResolvedValue({ kind: "step-up" })
  await click(buttonIn(gptOss.id, "Fetch"))
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not start the fetch of gpt-oss-20b."
  )
})

test("a cancelled Fetch step-up sends nothing; an unreachable gate or a dead supervisor replaces the page", async () => {
  admin.elevated.mockResolvedValue({ kind: "cancelled" })
  const calls = gate(okRoutes)
  await render()
  await click(buttonIn(gptOss.id, "Fetch"))
  expect(calls.map((c) => c.key)).not.toContain(
    "POST /admin/models/gpt-oss-20b/fetch"
  )
  expect(buttons(card(gptOss.id))).toEqual(["Fetch"])

  admin.elevated.mockImplementation((_a: string, run: () => Promise<unknown>) =>
    run()
  )
  gate(okRoutes)
  await click(buttonIn(gptOss.id, "Fetch"))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Can't reach the gate on the host."
  )

  await click(container.querySelector("button"))
  gate({
    ...okRoutes,
    "POST /admin/models/gpt-oss-20b/fetch": () =>
      Response.json(
        { code: "supervisor_unavailable", message: "x" },
        { status: 503 }
      ),
  })
  await click(buttonIn(gptOss.id, "Fetch"))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "The stack supervisor is not answering."
  )
})

test("the supervisor dying mid-fetch replaces the page with its message", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  let stackCalls = 0
  gate({
    "GET /admin/models": () => Response.json(modelList),
    "GET /admin/stack": () =>
      Response.json(
        stackCalls++ === 0
          ? stackWith([fetchRunning])
          : { supervisor: "unavailable" }
      ),
  })
  await render()
  act(() => {
    vi.advanceTimersByTime(2000)
  })
  await settle()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "The stack supervisor is not answering."
  )
  expect(container.querySelectorAll("button")).toHaveLength(0)
})

test("a failed poll keeps the last progress and tries again", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  let stackCalls = 0
  gate({
    "GET /admin/models": () => Response.json(modelList),
    "GET /admin/stack": () =>
      stackCalls++ === 0
        ? Response.json(stackWith([fetchRunning]))
        : new Response(null, { status: 500 }),
  })
  await render()
  act(() => {
    vi.advanceTimersByTime(2000)
  })
  await settle()
  expect(card(gptOss.id).textContent).toContain("6.2 of 12.1 GB")
})
