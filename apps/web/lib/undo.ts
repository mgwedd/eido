import { validateGateUndoResult } from "@eido/schemas"

/** The gate's undo route for one execution; the id is the executed intent's id. */
export const undoUrl = (executionId: string) =>
  `/api/gate/executions/${encodeURIComponent(executionId)}/undo`

/**
 * One undo control's state. `undone` comes only from a confirmed gate response;
 * `failed` covers every unconfirmed answer (refused, network, unreadable).
 */
export type UndoState = "idle" | "undoing" | "undone" | "failed"
export type UndoEvent = "start" | "confirmed" | "unconfirmed"

/** Pure transitions. A start while undoing or undone does nothing, so a second click issues no call. */
export function nextUndoState(state: UndoState, event: UndoEvent): UndoState {
  switch (event) {
    case "start":
      return state === "idle" || state === "failed" ? "undoing" : state
    case "confirmed":
      return state === "undoing" ? "undone" : state
    case "unconfirmed":
      return state === "undoing" ? "failed" : state
  }
}

export type UndoOutcome = "confirmed" | "unconfirmed" | "unauthenticated"

/**
 * POSTs the empty undo request. Only a 200 whose body is a GateUndoResult for this id
 * confirms the undo; anything else is unconfirmed and the caller re-reads the audit log.
 */
export async function requestUndo(executionId: string): Promise<UndoOutcome> {
  try {
    const response = await fetch(undoUrl(executionId), {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    if (response.status === 401) return "unauthenticated"
    if (!response.ok) return "unconfirmed"
    const parsed = validateGateUndoResult(await response.json())
    return parsed.ok && parsed.value.id === executionId
      ? "confirmed"
      : "unconfirmed"
  } catch {
    return "unconfirmed"
  }
}
