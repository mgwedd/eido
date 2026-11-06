// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { TooltipProvider } from "@eido/ui/components/tooltip"
import { SimpleFinSyncRow } from "../components/settings-view"
import {
  health,
  MIDNIGHT_AT,
  NEXT_SYNC_AT,
  refused,
  synced,
} from "./fixtures/simplefin-sync"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

const time = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
    new Date(iso)
  )

/** Core: `healths` are served in order (the last repeats); `sync` answers the POST. */
function core(healths: unknown[], sync: () => Promise<Response>) {
  let reads = 0
  const fn = vi.fn((input: string, init?: RequestInit) => {
    if (input === "/api/core/connectors/health") {
      const body = healths[Math.min(reads, healths.length - 1)]
      reads += 1
      return Promise.resolve(new Response(JSON.stringify(body)))
    }
    if (
      input === "/api/core/connectors/simplefin/sync" &&
      init?.method === "POST"
    )
      return sync()
    return Promise.reject(new TypeError("unexpected request"))
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

const answer = (body: unknown, status: number) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))

const button = () => container.querySelector("button") as HTMLButtonElement
const syncCalls = (fn: ReturnType<typeof core>) =>
  fn.mock.calls.filter(([url]) => url.endsWith("/sync")).length

async function mount(onSynced?: () => void) {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <SimpleFinSyncRow onSynced={onSynced} />
      </TooltipProvider>
    )
    await flush()
  })
}

describe("SimpleFinSyncRow", () => {
  test("idle shows the next sync time, the request count and a live button", async () => {
    core([health()], answer(synced, 200))
    await mount()
    expect(container.textContent).toContain(
      `Next sync ${time(NEXT_SYNC_AT)} · 3 of 24 requests today`
    )
    expect(button().textContent).toBe("Sync now")
    expect(button().disabled).toBe(false)
  })

  test("one click sends one POST and the button is disabled while it is in flight", async () => {
    let resolve: (r: Response) => void = () => undefined
    const fn = core(
      [health()],
      () => new Promise<Response>((r) => (resolve = r))
    )
    await mount()
    await act(async () => {
      button().click()
      await flush()
    })
    expect(button().disabled).toBe(true)
    expect(button().textContent).toBe("Syncing…")
    await act(async () => {
      button().click()
      await flush()
    })
    expect(syncCalls(fn)).toBe(1)
    await act(async () => {
      resolve(new Response(JSON.stringify(synced)))
      await flush()
    })
    expect(button().disabled).toBe(false)
    expect(button().textContent).toBe("Sync now")
  })

  test("a synced response reads health again, shows the new count and tells the section", async () => {
    const onSynced = vi.fn()
    const fn = core(
      [health({ requestsToday: 3 }), health({ requestsToday: 4 })],
      answer(synced, 200)
    )
    await mount(onSynced)
    await act(async () => {
      button().click()
      await flush()
    })
    expect(container.textContent).toContain("4 of 24 requests today")
    expect(container.textContent).not.toContain("3 of 24")
    expect(
      fn.mock.calls.filter(([url]) => url.endsWith("/health")).length
    ).toBe(2)
    expect(onSynced).toHaveBeenCalledTimes(1)
  })

  test("a refusal does not tell the section to re-read accounts", async () => {
    const onSynced = vi.fn()
    core([health()], answer(refused("sync_failed"), 409))
    await mount(onSynced)
    await act(async () => {
      button().click()
      await flush()
    })
    expect(onSynced).not.toHaveBeenCalled()
  })

  test("a 409 daily_limit gives the reset time and disables the button", async () => {
    core(
      [health({ requestsToday: 24, nextSyncAt: MIDNIGHT_AT })],
      answer(refused("daily_limit", MIDNIGHT_AT), 409)
    )
    await mount()
    // Already spent on load: the button is disabled and the count has no next sync.
    expect(button().disabled).toBe(true)
    expect(container.textContent).toContain("24 of 24 requests today")
    expect(container.textContent).not.toContain("Next sync")
  })

  test("the button stays disabled after a daily_limit refusal even if health lags", async () => {
    core([health()], answer(refused("daily_limit", MIDNIGHT_AT), 409))
    await mount()
    expect(button().disabled).toBe(false)
    await act(async () => {
      button().click()
      await flush()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      `Daily request limit reached. Resets at ${time(MIDNIGHT_AT)}.`
    )
    expect(button().disabled).toBe(true)
  })

  test("after other refusals the button is live again to retry", async () => {
    core([health()], answer(refused("connector_unavailable"), 409))
    await mount()
    await act(async () => {
      button().click()
      await flush()
    })
    expect(button().disabled).toBe(false)
  })

  test("a 200 that does not say synced counts as a failed request", async () => {
    core([health()], answer(refused("sync_failed"), 200))
    await mount()
    await act(async () => {
      button().click()
      await flush()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not reach core. Nothing was synced."
    )
  })

  test("the result clears on the next click", async () => {
    core([health()], answer(refused("sync_failed"), 409))
    await mount()
    await act(async () => {
      button().click()
      await flush()
    })
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    let resolve: (r: Response) => void = () => undefined
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        input.endsWith("/health")
          ? Promise.resolve(new Response(JSON.stringify(health())))
          : new Promise<Response>((r) => (resolve = r))
      )
    )
    await act(async () => {
      button().click()
      await flush()
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => {
      resolve(new Response(JSON.stringify(synced)))
      await flush()
    })
  })

  test("a health read that fails leaves the button usable without counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 500 })))
    )
    await mount()
    expect(container.textContent).not.toContain("requests today")
    expect(button().disabled).toBe(false)
  })

  test("offline disables the button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network")))
    )
    await mount()
    expect(button().disabled).toBe(true)
  })
})
