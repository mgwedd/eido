"use client"

import { Button } from "@eido/ui/components/button"
import { cn } from "@eido/ui/lib/utils"
import { resolveFailureMessage, type ResolveState } from "@/lib/replies"

export interface ResolveActionProps {
  /** The row's resolve state; undefined is idle. */
  state: ResolveState | undefined
  isOffline: boolean
  /** Phone rows use 44px targets, desktop rows 36px. */
  size: "phone" | "desktop"
  onResolve: () => void
}

/**
 * The action cell of one Waiting on row: the `Mark resolved` button. The status region
 * announces pending and offline; a failure announces in an alert and leaves the button to retry.
 * On success the row leaves the list, so there is no resolved state to show.
 */
export function ResolveAction({
  state,
  isOffline,
  size,
  onResolve,
}: ResolveActionProps) {
  const pending = state?.status === "pending"
  const failed = state?.status === "failed" ? state.reason : null
  const target = size === "phone" ? "min-h-[44px]" : "min-h-[36px]"

  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={isOffline || pending}
        aria-busy={pending}
        title={isOffline ? "Unavailable offline" : undefined}
        onClick={onResolve}
        className={cn(target, size === "phone" && "px-3 font-medium")}
      >
        {pending ? "Marking…" : "Mark resolved"}
      </Button>
      <span role="status" aria-live="polite" className="contents">
        {pending ? <span className="sr-only">Marking resolved…</span> : null}
        {isOffline ? (
          <span className="sr-only">Unavailable offline</span>
        ) : null}
      </span>
      {failed !== null ? (
        <p role="alert" className="max-w-[220px] text-xs text-destructive">
          {resolveFailureMessage(failed)}
        </p>
      ) : null}
    </div>
  )
}
