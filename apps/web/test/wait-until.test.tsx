// @vitest-environment happy-dom
import { act, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"
import { describeStates } from "./render-states"
import { waitUntil } from "./wait-until"

/** A promise the test settles by hand, standing in for a fetch that is still in flight. */
function gate() {
  let release: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { opened, release }
}

/** Shows nothing until the gate opens, as a card does while its fetches are in flight. */
function SlowStatus({ opened }: { opened: Promise<void> }) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    void opened.then(() => setLoaded(true))
  }, [opened])
  return loaded ? <p role="status">Loaded</p> : <p>Loading</p>
}

const loadedIn = (container: HTMLElement) =>
  container.querySelector('[role="status"]') !== null

test("waitUntil rejects with its own message when the deadline passes", async () => {
  await expect(waitUntil(() => false, "never became true", 30)).rejects.toThrow(
    "never became true"
  )
})

test("waitUntil returns only after an update that lands later has rendered", async () => {
  const { opened, release } = gate()
  const container = document.createElement("div")
  const root = createRoot(container)
  act(() => {
    root.render(<SlowStatus opened={opened} />)
  })
  expect(container.textContent).toBe("Loading")
  release()
  await waitUntil(() => loadedIn(container), "never loaded")
  expect(container.textContent).toBe("Loaded")
  act(() => root.unmount())
})

// The update lands after the wait starts, as it does when a loaded runner is slow: the
// wait has to see it. Run as `interact` (inside one `act`) this row stalls and fails.
const slow = gate()
describeStates("Slow-loading status", [
  {
    state: "loads after the wait starts",
    render: () => <SlowStatus opened={slow.opened} />,
    settle: (container) => {
      slow.release()
      return waitUntil(() => loadedIn(container), "never loaded")
    },
    role: "status",
    message: "Loaded",
  },
])
