import type { Intent } from "@eido/schemas"

export const APPLE_DESTINATIONS = {
  "apple.event_create": "eventkit:create_event",
  "apple.event_update": "eventkit:update_event",
  "apple.reminder_create": "eventkit:create_reminder",
  "apple.reminder_complete": "eventkit:complete_reminder",
} as const satisfies Partial<Record<Intent["kind"], string>>

export function appleDestination(kind: Intent["kind"]): string | undefined {
  return Object.entries(APPLE_DESTINATIONS).find(([name]) => name === kind)?.[1]
}
