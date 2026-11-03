import type { CoreApiConversationGet, CoreApiError } from "@eido/schemas"
import { validateCoreApiConversationGet } from "@eido/schemas"
import type { ConversationStore } from "../conversation/store"

export const CONVERSATION_GET_PATH = /^\/conversations(?:\/([^/]*))?$/
export const MAX_ID_LENGTH = 256

type FieldError = { field: string; message: string }

export type ConversationGetResult =
  | { ok: true; body: CoreApiConversationGet }
  | {
      ok: false
      code: CoreApiError["error"]["code"]
      message: string
      fields?: FieldError[]
    }

export function conversationGetRoute(
  conversations: ConversationStore,
  rawId: string | undefined
): ConversationGetResult {
  if (rawId === undefined || rawId === "") {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: [{ field: "id", message: "conversation id is required" }],
    }
  }

  let id: string
  try {
    id = decodeURIComponent(rawId)
  } catch {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: [{ field: "id", message: "malformed conversation id" }],
    }
  }

  if (id.trim() === "") {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: [{ field: "id", message: "conversation id must not be empty" }],
    }
  }

  if (id.length > MAX_ID_LENGTH) {
    return {
      ok: false,
      code: "invalid",
      message: "invalid input",
      fields: [
        {
          field: "id",
          message: `conversation id must be at most ${String(MAX_ID_LENGTH)} characters`,
        },
      ],
    }
  }

  const turns = conversations.getTurns(id)
  if (turns.length === 0) {
    return {
      ok: false,
      code: "not_found",
      message: "conversation not found",
    }
  }

  const digest = conversations.getConversationDigest(id)
  const start = conversations.digestStart(id)
  const coveredTurns =
    digest !== undefined ? (start?.coveredTurns ?? turns.length) : 0

  const bodyTurns = turns.map((turn, index) => {
    const isDigested = index < coveredTurns
    return {
      id: turn.id,
      role: turn.role,
      text: turn.text,
      at: turn.at,
      sources: turn.sources,
      digested: isDigested,
      digest: isDigested,
    }
  })

  const body: CoreApiConversationGet = {
    id,
    conversationId: id,
    turns: bodyTurns,
    digest:
      digest !== undefined
        ? {
            text: digest.text,
            createdAt: digest.createdAt,
            coveredTurns,
          }
        : null,
  }

  const validation = validateCoreApiConversationGet(body)
  if (!validation.ok) {
    return {
      ok: false,
      code: "internal",
      message: "invalid conversation get response",
    }
  }

  return {
    ok: true,
    body: validation.value,
  }
}
