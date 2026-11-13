import { validateIntent } from "@eido/schemas"

const CONNECTOR_NAMES: Readonly<Record<string, string>> = {
  gmail: "Gmail",
  "proton-mail": "Proton Mail",
  "proton-calendar": "Proton Calendar",
}

function messages(count: number): string {
  return count === 1 ? "1 message" : `${count} messages`
}

function inConnector(connector: string | undefined): string {
  const name = connector === undefined ? undefined : CONNECTOR_NAMES[connector]
  return name === undefined ? "" : ` in ${name}`
}

/**
 * A short sentence for an automatic execution on the Today card (#696), built from the
 * stored intent's kind, counts and pinned connector. It never carries message bodies,
 * subjects, file names or any model text. Returns undefined for a payload that is not a
 * valid intent and for kinds with no sentence, so the reader falls back to the action name.
 */
export function describeIntent(payloadJson: string): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(payloadJson)
  } catch {
    return undefined
  }
  const checked = validateIntent(value)
  if (!checked.ok) return undefined
  const intent = checked.value
  switch (intent.kind) {
    case "email.markRead":
      return `Marked ${messages(intent.args.messageIds.length)} ${
        intent.args.read ? "read" : "unread"
      }${inConnector(intent.connector)}`
    case "email.archive":
      return `Archived ${messages(intent.args.messageIds.length)}${inConnector(intent.connector)}`
    case "email.label":
      return `Changed labels on ${messages(intent.args.messageIds.length)}${inConnector(intent.connector)}`
    case "email.trash":
      return `Moved ${messages(intent.args.messageIds.length)} to trash${inConnector(intent.connector)}`
    case "email.untrash":
      return `Restored ${messages(intent.args.messageIds.length)} from trash${inConnector(intent.connector)}`
    case "things.complete_todo":
      return "Completed a to-do in Things"
    case "things.cancel_todo":
      return "Cancelled a to-do in Things"
    case "things.add_todo":
      return "Added a to-do in Things"
    case "things.update_todo":
      return "Updated a to-do in Things"
    case "things.schedule_todo":
      return "Scheduled a to-do in Things"
    case "things.add_project":
      return "Added a project in Things"
    case "reminder.create":
      return "Added a reminder"
    default:
      return undefined
  }
}
