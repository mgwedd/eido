import type { ReactNode } from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/** How a stubbed `fetch` behaves for a state. */
type ProbeOutcome =
  { kind: "response"; status: number } | { kind: "network-failure" }

type StateCase = {
  /** The designed state this row covers, named as on the page's spec board (loading, empty, populated, error, gate unreachable, ...). */
  state: string
  /** The fixture-backed element tree to render. */
  render: () => ReactNode
  /** Stub the network for this state (optional). */
  fetch?: ProbeOutcome
  /** The live region that announces the state. */
  role: "status" | "alert"
  /**
   * The state's own message, written as a literal in the test. `null` asserts the region
   * is present and says nothing (the state has no message).
   */
  message: string | null
}

function stubFetch(outcome: ProbeOutcome) {
  const impl: typeof fetch = () =>
    outcome.kind === "network-failure"
      ? Promise.reject(new TypeError("network"))
      : Promise.resolve(new Response(null, { status: outcome.status }))
  vi.stubGlobal("fetch", vi.fn(impl))
}

/**
 * Registers one test per row. Each renders the row's tree, lets effects and the stubbed
 * network settle, then asserts the region with the row's role holds exactly the row's
 * message. A row fails when the component shows the wrong message, the wrong role, or a
 * message when it should be silent.
 */
function describeStates(name: string, cases: readonly StateCase[]) {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.unstubAllGlobals()
  })

  for (const row of cases) {
    test(`${name}: ${row.state}`, async () => {
      if (row.fetch) stubFetch(row.fetch)
      await act(async () => {
        root.render(row.render())
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const region = container.querySelector(`[role="${row.role}"]`)
      expect(region, `no element with role="${row.role}"`).not.toBeNull()
      const text = (region?.textContent ?? "").trim()
      if (row.message === null) expect(text).toBe("")
      else expect(text).toBe(row.message)
    })
  }
}

export { describeStates }
export type { ProbeOutcome, StateCase }
