"use client"

import Link from "next/link"

import { Button } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import { UndoControl } from "@/components/undo-control"
import { formatAction, formatTime, type AuditEntry } from "@/lib/activity"
import { selectDoneAutomatically } from "@/lib/today-done"

export type DoneAutomaticallyState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; entries: AuditEntry[] }

/** The Done automatically card on Today: the latest automatic actions, each with its undo. */
export function DoneAutomaticallyCard({
  state,
  onRetry,
  onUndoSettled,
  onSignedOut,
}: {
  state: DoneAutomaticallyState
  onRetry: () => void
  /** Re-reads the audit log after every undo answer. */
  onUndoSettled: () => void
  onSignedOut: () => void
}) {
  const rows =
    state.status === "ready" ? selectDoneAutomatically(state.entries) : []
  return (
    <Card role="region" aria-labelledby="today-done-heading">
      <CardHeader>
        <div className="flex items-baseline justify-between gap-3">
          <h2
            id="today-done-heading"
            className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Done automatically
          </h2>
          <Link href="/activity" className="text-xs underline">
            Audit log
          </Link>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.status === "loading" ? (
          <>
            <p role="status" className="sr-only">
              Loading automatic actions…
            </p>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </>
        ) : null}
        {state.status === "error" ? (
          <>
            <p role="alert" className="text-sm">
              Couldn&apos;t load automatic actions.
            </p>
            <Button variant="outline" onClick={onRetry} className="self-start">
              Retry
            </Button>
          </>
        ) : null}
        {state.status === "ready" && rows.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Nothing done automatically yet.
          </p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((entry) => (
              <li
                key={entry.seq}
                className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium break-all">
                    {entry.description ?? formatAction(entry.action)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <time dateTime={entry.ts}>{formatTime(entry.ts)}</time>
                    {" · "}
                    {entry.target}
                  </span>
                </div>
                <UndoControl
                  executionId={entry.target}
                  projection={entry.undo}
                  onSettled={onUndoSettled}
                  onSignedOut={onSignedOut}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  )
}
