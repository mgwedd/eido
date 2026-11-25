import { validateGatePushRegistration } from "@eido/schemas"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"
import {
  PushHostRefused,
  checkedSubscription,
  preparePushRegistration,
  registerPushSubscription,
} from "../push-subscriptions"
import { jsonBody, invalid } from "./shared"
import type { PhoneState } from "./types"

const hostRefused = () =>
  apiError(
    422,
    "push_host_refused",
    "this browser's push service is not one the gate sends to"
  )

export async function preparePush(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  if (state.push === undefined)
    return apiError(503, "unavailable", "push is not configured")
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  try {
    checkedSubscription(body.value)
    return { status: 200, body: preparePushRegistration(state.db, body.value) }
  } catch (error) {
    if (error instanceof PushHostRefused) return hostRefused()
    return apiError(400, "invalid_request", "invalid push subscription")
  }
}

export async function registerPush(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  if (state.push === undefined)
    return apiError(503, "unavailable", "push is not configured")
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGatePushRegistration(body.value)
  if (!checked.ok) return invalid("a push registration", checked.errors)
  try {
    const id = registerPushSubscription(state.db, checked.value.subscription, {
      config: state.webAuthn,
      request: checked.value.approval,
    })
    return { status: 201, body: { id } }
  } catch (error) {
    if (error instanceof PushHostRefused) return hostRefused()
    return apiError(403, "verification_failed", "push registration refused")
  }
}
