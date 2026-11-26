import { act } from "react"

/** How long a condition may take before the wait gives up. Generous on purpose: a loaded CI runner is slow, not broken. */
const WAIT_DEADLINE_MS = 15_000

/** The vitest timeout for a test that uses `waitUntil`; longer than the deadline so the wait's own message is what fails. */
const WAITING_TEST_TIMEOUT_MS = 30_000

const POLL_MS = 10

/**
 * Waits until `condition` holds, checking it between `act` steps.
 *
 * Each poll sleeps inside its own `act` scope, so updates that land during the sleep are
 * rendered before the condition is checked again. Call it outside any other `act` scope (the
 * `settle` hook of `describeStates`, not `interact`): inside an outer async `act`, React holds
 * back the renders for fetches that settle during that scope until it ends, a nested `act` does
 * not release them, and the wait runs out (#869).
 *
 * The bound is a wall-clock deadline, not a count of polls, so a slow runner gets the same time
 * as a fast one. `failure` is the message when the deadline passes.
 */
async function waitUntil(
  condition: () => boolean,
  failure: string,
  deadlineMs: number = WAIT_DEADLINE_MS
): Promise<void> {
  const deadline = performance.now() + deadlineMs
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(failure)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    })
  }
}

export { waitUntil, WAIT_DEADLINE_MS, WAITING_TEST_TIMEOUT_MS }
