"use client"

import { Undo2 } from "lucide-react"
import * as React from "react"

import { Button } from "@eido/ui/components/button"
import {
  nextUndoState,
  requestUndo,
  type UndoEvent,
  type UndoState,
} from "@/lib/undo"

type Projection = "available" | "done" | "none"

/**
 * Undo for one execution, driven by the gate's `undo` projection: nothing for `none`,
 * "Undone" for `done`, and for `available` a button that runs Undoing…, then Undone or
 * an error with Retry. `onSettled` runs after every answer so the caller re-reads the
 * gate; it never retries on its own.
 */
function UndoControl({
  executionId,
  projection,
  onSettled,
  onSignedOut,
}: {
  executionId: string
  projection: Projection
  onSettled: () => void
  onSignedOut: () => void
}) {
  const [state, dispatch] = React.useReducer(
    (current: UndoState, event: UndoEvent) => nextUndoState(current, event),
    "idle"
  )
  // A second click can land before React re-renders the disabled button.
  const inFlight = React.useRef(false)

  const run = React.useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    dispatch("start")
    void requestUndo(executionId).then((outcome) => {
      inFlight.current = false
      if (outcome === "unauthenticated") return onSignedOut()
      dispatch(outcome)
      onSettled()
    })
  }, [executionId, onSettled, onSignedOut])

  if (projection === "none") return null
  if (projection === "done" || state === "undone")
    return (
      <span role="status" className="text-xs text-muted-foreground">
        Undone
      </span>
    )
  if (state === "failed")
    return (
      <span className="flex flex-wrap items-center gap-x-2">
        <span role="alert" className="text-xs text-destructive">
          Could not undo.
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={run}
          className="min-h-11 md:min-h-7"
        >
          Retry
        </Button>
      </span>
    )
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={run}
      disabled={state === "undoing"}
      className="min-h-11 self-start md:min-h-7"
    >
      <Undo2 aria-hidden data-icon="inline-start" />
      {state === "undoing" ? <span role="status">Undoing…</span> : "Undo"}
    </Button>
  )
}

export { UndoControl }
