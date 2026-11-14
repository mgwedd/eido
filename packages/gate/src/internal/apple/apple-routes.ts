import type { DatabaseSync } from "node:sqlite"
import { validateGateAppleRequest } from "@eido/schemas"
import type { GateAppleRequest } from "@eido/schemas"
import { append } from "../audit"
import { payloadHash } from "../canonical"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"
import {
  beginConnectorRead,
  disableConnectorAfterAuthFailure,
  recordConnectorReadFailure,
  recordConnectorReadSuccess,
  releaseConnectorProbe,
} from "../connector-health"
import type { AppleReads } from "./apple-adapter"
import { AppleError } from "./runner"

export const APPLE_CONNECTOR = "apple-eventkit"
const ROUTES: Readonly<Record<string, string>> = {
  "/apple/calendars": "list_calendars",
  "/apple/reminder-lists": "list_reminder_lists",
  "/apple/events": "list_events",
  "/apple/reminders": "list_reminders",
}

function readRequest(request: GateRequest): GateAppleRequest | undefined {
  const operation = ROUTES[request.path]
  const args = Object.fromEntries(request.query)
  if (
    [...request.query.keys()].some(
      (key) => request.query.getAll(key).length !== 1
    )
  )
    return undefined
  const parsed = validateGateAppleRequest({ operation, args })
  if (!parsed.ok) return undefined
  if (parsed.value.operation === "list_events") {
    const { start, end } = parsed.value.args
    const duration = Date.parse(end) - Date.parse(start)
    if (!(duration > 0 && duration <= 366 * 86_400_000)) return undefined
  }
  return parsed.value
}

export async function appleRoute(
  request: GateRequest,
  db: DatabaseSync,
  apple: AppleReads
): Promise<Reply | undefined> {
  if (request.method !== "GET" || ROUTES[request.path] === undefined)
    return undefined
  const parsed = readRequest(request)
  if (parsed === undefined)
    return apiError(400, "invalid_request", "Invalid Apple read parameters")
  const action = `apple.read.${parsed.operation}`
  const audit = (suffix: string, count = 0) =>
    append(db, {
      actor: "data-plane",
      action: action + suffix,
      target: APPLE_CONNECTOR,
      detailHash: payloadHash({ items: count }),
    })
  const attempt = beginConnectorRead(db, APPLE_CONNECTOR)
  if (!attempt.allowed) {
    audit(`.refused.${attempt.reason ?? "connector_open"}`)
    return apiError(
      503,
      "unavailable",
      "Apple connector is disabled or waiting for its next read probe"
    )
  }
  try {
    let body: unknown
    let count: number
    switch (parsed.operation) {
      case "list_calendars": {
        const result = await apple.listCalendars()
        body = result
        count = result.calendars.length
        break
      }
      case "list_reminder_lists": {
        const result = await apple.listReminderLists()
        body = result
        count = result.calendars.length
        break
      }
      case "list_events": {
        const result = await apple.listEvents(
          parsed.args.calendarId,
          parsed.args.start,
          parsed.args.end
        )
        body = result
        count = result.events.length
        break
      }
      case "list_reminders": {
        const result = await apple.listReminders(
          parsed.args.listId,
          parsed.args.completedSince
        )
        body = result
        count = result.reminders.length
        break
      }
      default:
        return apiError(
          400,
          "invalid_request",
          "Only Apple reads are available here"
        )
    }
    recordConnectorReadSuccess(db, APPLE_CONNECTOR, attempt)
    audit("", count)
    return { status: 200, body }
  } catch (error) {
    const code = error instanceof AppleError ? error.code : "unavailable"
    audit(`.failed.${code}`)
    if (code === "permission_denied")
      disableConnectorAfterAuthFailure(db, APPLE_CONNECTOR)
    else recordConnectorReadFailure(db, APPLE_CONNECTOR, "unavailable", attempt)
    if (code === "not_found")
      return apiError(404, "not_found", "Apple calendar or list was not found")
    if (code === "invalid_request")
      return apiError(400, "invalid_request", "Invalid Apple read parameters")
    if (code === "permission_denied")
      return apiError(
        502,
        "auth_failed",
        "Apple Calendar or Reminders permission was denied"
      )
    return apiError(502, "unavailable", "Apple Helper is unavailable")
  } finally {
    releaseConnectorProbe(db, APPLE_CONNECTOR, attempt)
  }
}
