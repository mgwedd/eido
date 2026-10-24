import { expect, test } from "vitest"
import {
  describeKind,
  formatToday,
  needsYouSummary,
  selectNeedsYou,
  type PendingIntent,
} from "../lib/today"

const intent = (id: string, createdAt: string): PendingIntent => ({
  id,
  kind: "email.send",
  tier: "approval",
  state: "pending",
  origin: "reactive",
  createdAt,
})

test("describeKind names the source and action", () => {
  expect(describeKind("calendar.create")).toBe("Calendar · Send invitation")
})

test("describeKind shows an unknown kind as sent", () => {
  expect(describeKind("widget.spin")).toBe("widget.spin")
})

test("selectNeedsYou orders oldest first and keeps five", () => {
  const intents = [6, 5, 4, 3, 2, 1].map((day) =>
    intent(`i${day}`, `2026-10-0${day}T09:00:00.000Z`)
  )
  expect(selectNeedsYou(intents).map((i) => i.id)).toEqual([
    "i1",
    "i2",
    "i3",
    "i4",
    "i5",
  ])
})

test("formatToday gives weekday, month and day", () => {
  expect(formatToday(new Date(2026, 9, 18, 12))).toBe("Sunday, October 18")
})

test.each([
  [0, "Nothing needs you"],
  [1, "1 item needs you"],
  [2, "2 items need you"],
])("needsYouSummary(%i)", (count, expected) => {
  expect(needsYouSummary(count)).toBe(expected)
})
