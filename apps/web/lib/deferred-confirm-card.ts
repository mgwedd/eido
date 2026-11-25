import { validateCoreApiConfirmCardResponse } from "@eido/schemas"

/** Core's route that opens the confirm card behind a deferred extraction brief line. */
export const CONFIRM_CARD_URL = "/api/core/extractions/confirm-card"

/**
 * What one request for a confirm card came to. `opened` carries core's queue address for the
 * pending card; every refusal or unreadable answer is `failed`.
 */
export type ConfirmCardOutcome =
  | { status: "opened"; queueHref: string }
  | { status: "unauthenticated" }
  | { status: "failed" }

/**
 * Asks core for the confirm card of a deferred extraction line. Core returns the pending card
 * (200) or proposes one through the gate (201); the owner still approves it in the queue.
 */
export async function requestConfirmCard(
  extractionId: number
): Promise<ConfirmCardOutcome> {
  try {
    const response = await fetch(CONFIRM_CARD_URL, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extractionId }),
    })
    if (response.status === 401) return { status: "unauthenticated" }
    if (response.status !== 200 && response.status !== 201)
      return { status: "failed" }
    const parsed = validateCoreApiConfirmCardResponse(await response.json())
    if (!parsed.ok) return { status: "failed" }
    return { status: "opened", queueHref: parsed.value.queueHref }
  } catch {
    return { status: "failed" }
  }
}
