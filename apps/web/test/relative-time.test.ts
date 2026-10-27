import { expect, test } from "vitest"
import { formatWaiting } from "../lib/relative-time"

const NOW = new Date("2026-10-18T12:00:00.000Z")

test.each([
  ["2026-10-18T11:59:30.000Z", "Waiting less than a minute"],
  ["2026-10-18T11:55:00.000Z", "Waiting 5 min"],
  ["2026-10-17T14:00:00.000Z", "Waiting 22 h"],
  ["2026-10-15T11:00:00.000Z", "Waiting 3 d"],
  ["2026-10-18T13:00:00.000Z", "Waiting less than a minute"],
])("%s reads %s", (createdAt, expected) => {
  expect(formatWaiting(createdAt, NOW)).toBe(expected)
})
