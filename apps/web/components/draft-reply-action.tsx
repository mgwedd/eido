"use client"

import Link from "next/link"
import { Button } from "@eido/ui/components/button"
import { cn } from "@eido/ui/lib/utils"
import {
  ACTIVITY_URL,
  CONNECTORS_URL,
  draftFailureMessage,
  type DraftReplyState,
} from "@/lib/replies"

export interface DraftReplyActionProps {
  /** The row's draft state; undefined is idle. */
  state: DraftReplyState | undefined
  /** The list says a draft intent already exists for the row's thread (`hasDraftIntent`). */
  hasDraftIntent: boolean
  isOffline: boolean
  /** Phone rows use 44px targets, desktop rows 36px. */
  size: "phone" | "desktop"
  onDraft: () => void
}

/**
 * The action cell of one Replies owed row: the `Draft reply` button, then `Draft saved`
 * linking to the draft's entry in Activity. The status region announces pending, saved and
 * offline; a failure announces in an alert and leaves the button to retry.
 */
export function DraftReplyAction({
  state,
  hasDraftIntent,
  isOffline,
  size,
  onDraft,
}: DraftReplyActionProps) {
  const saved =
    state?.status === "saved"
      ? { href: state.activityHref }
      : hasDraftIntent
        ? { href: ACTIVITY_URL }
        : null
  const pending = state?.status === "pending"
  const failed = state?.status === "failed" ? state.reason : null
  const target = size === "phone" ? "min-h-[44px]" : "min-h-[36px]"

  return (
    <div className="flex flex-col items-end gap-1 text-right">
      {saved ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isOffline || pending}
          aria-busy={pending}
          title={isOffline ? "Unavailable offline" : undefined}
          onClick={onDraft}
          className={cn(target, size === "phone" && "px-3 font-medium")}
        >
          {pending ? "Drafting…" : "Draft reply"}
        </Button>
      )}
      <span role="status" aria-live="polite" className="contents">
        {saved ? (
          <Link
            href={saved.href}
            className={cn(
              "inline-flex items-center text-xs font-medium text-primary underline underline-offset-4 hover:opacity-80",
              target
            )}
          >
            Draft saved
          </Link>
        ) : null}
        {pending ? <span className="sr-only">Drafting reply…</span> : null}
        {!saved && isOffline ? (
          <span className="sr-only">Unavailable offline</span>
        ) : null}
      </span>
      {failed !== null && !saved ? (
        <p role="alert" className="max-w-[220px] text-xs text-destructive">
          {draftFailureMessage(failed)}
          {failed === "connector_paused" ? (
            <>
              {" "}
              <Link
                href={CONNECTORS_URL}
                className="font-medium underline underline-offset-4"
              >
                Open Connectors
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
