import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createAppleClient } from "../client"
import { socketAddress } from "../test-fixtures"

describe("Apple gate read client", () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-apple-client-"))
  const socketPath = socketAddress(dir, "gate.sock")
  const client = createAppleClient({ socketPath })
  let status = 200
  let body: unknown = { calendars: [] }
  let received = ""
  const server = createServer((request, response) => {
    received = `${request.method} ${request.url}`
    response.writeHead(status, { "Content-Type": "application/json" })
    response.end(JSON.stringify(body))
  })
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })
  test("schema-checks all read responses and encodes parameters", async () => {
    body = { calendars: [{ id: "cal-1", title: "Work", writable: true }] }
    await expect(client.listCalendars()).resolves.toEqual(body)
    expect(received).toBe("GET /apple/calendars")
    body = { calendars: [] }
    await expect(client.listReminderLists()).resolves.toEqual({ calendars: [] })
    expect(received).toBe("GET /apple/reminder-lists")
    body = { events: [] }
    await expect(
      client.listEvents({
        calendarId: "cal & 1",
        start: "2026-11-14T00:00:00Z",
        end: "2026-11-15T00:00:00Z",
      })
    ).resolves.toEqual({ events: [] })
    expect(received).toBe(
      "GET /apple/events?calendarId=cal+%26+1&start=2026-11-14T00%3A00%3A00Z&end=2026-11-15T00%3A00%3A00Z"
    )
    body = { reminders: [] }
    await expect(
      client.listReminders({
        listId: "list/1",
        completedSince: "2026-11-01T00:00:00Z",
      })
    ).resolves.toEqual({ reminders: [] })
    expect(received).toBe(
      "GET /apple/reminders?listId=list%2F1&completedSince=2026-11-01T00%3A00%3A00Z"
    )
  })
  test("rejects a mismatched response and surfaces a checked gate refusal", async () => {
    body = { reminders: [] }
    await expect(client.listCalendars()).rejects.toMatchObject({
      name: "GateRequestError",
      code: "bad_response",
    })
    status = 503
    body = { code: "unavailable", message: "Apple Helper is unavailable" }
    await expect(client.listCalendars()).rejects.toMatchObject({
      name: "GateRequestError",
      status: 503,
      code: "unavailable",
    })
    status = 200
  })
})
