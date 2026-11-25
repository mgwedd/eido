import { validateIntent, validateGateAppleItemRef } from "@eido/schemas"
import type { GateAppleRequest, Intent } from "@eido/schemas"
import type { UpstreamWriter, WriteTransport } from "../executor"
import type { AppleRunner } from "./runner"
import { AppleError } from "./runner"
import { APPLE_CONNECTOR } from "./apple-routes"

import { appleDestination } from "./destinations"
export { APPLE_DESTINATIONS, appleDestination } from "./destinations"

const APPLE_KINDS = [
  "apple.event_create",
  "apple.event_update",
  "apple.reminder_create",
  "apple.reminder_complete",
] as const

export const APPLE_WRITERS: readonly UpstreamWriter[] = APPLE_KINDS.map(
  (kind) => ({
    kind,
    connector: APPLE_CONNECTOR,
    channel: "eventkit" as const,
    buildRequest: (intent: Intent) => ({
      method: "POST",
      url: appleDestination(intent.kind) ?? "",
      body: intent,
    }),
    intentFromRequest: (request: { body: unknown }) => request.body,
    inverse: () => null,
  })
)

function helperRequest(intent: Intent): GateAppleRequest {
  switch (intent.kind) {
    case "apple.event_create":
      return { operation: "create_event", args: intent.args }
    case "apple.event_update":
      return { operation: "update_event", args: intent.args }
    case "apple.reminder_create":
      return { operation: "create_reminder", args: intent.args }
    case "apple.reminder_complete":
      return { operation: "complete_reminder", args: intent.args }
    default:
      throw new AppleError("invalid_request")
  }
}

export function createAppleTransport(run: AppleRunner): WriteTransport {
  return async (request) => {
    if (request.connector !== APPLE_CONNECTOR || request.method !== "POST")
      throw new AppleError("invalid_request")
    let parsed: unknown
    try {
      parsed = JSON.parse(request.body)
    } catch {
      throw new AppleError("invalid_request")
    }
    const intent = validateIntent(parsed)
    if (
      !intent.ok ||
      intent.value.kind !== request.intentKind ||
      request.url !== appleDestination(intent.value.kind)
    )
      throw new AppleError("invalid_request")
    const helper = helperRequest(intent.value)
    if (request.operation !== helper.operation)
      throw new AppleError("invalid_request")
    const result = validateGateAppleItemRef(await run(helper))
    if (!result.ok) throw new AppleError("unavailable")
    return { upstreamRef: result.value.id, result: result.value }
  }
}
