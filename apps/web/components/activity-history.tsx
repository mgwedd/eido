"use client"

import { ArrowLeft, WifiOff } from "lucide-react"
import * as React from "react"

import { Button } from "@eido/ui/components/button"
import { Skeleton } from "@eido/ui/components/skeleton"
import { expiredUnlockUrl } from "@/lib/auth/unlock"
import {
  formatTimestamp,
  loadHistory,
  type HistoryEntry,
  type HistoryLoad,
} from "@/lib/activity"

type HistoryState =
  { status: "loading" } | Exclude<HistoryLoad, { status: "unauthenticated" }>

function useHistory(intentId: string) {
  const [state, setState] = React.useState<HistoryState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    const controller = new AbortController()
    void loadHistory(intentId, controller.signal).then((next) => {
      if (controller.signal.aborted) return
      if (next.status === "unauthenticated") {
        window.location.replace(
          expiredUnlockUrl(window.location.pathname + window.location.search)
        )
        return
      }
      setState(next)
    })
    return () => controller.abort()
  }, [intentId, attempt])
  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  return { state, retry }
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  return (
    <li className="flex min-h-11 flex-col gap-0.5 border-b py-2 text-sm">
      <span>
        <span className="font-mono">{entry.from ?? "start"}</span>
        <span aria-label=" to "> → </span>
        <span className="font-mono">{entry.to}</span>
        <span className="text-muted-foreground"> · {entry.actor}</span>
      </span>
      <time
        dateTime={entry.at}
        className="font-mono text-xs text-muted-foreground tabular-nums"
      >
        {formatTimestamp(entry.at)}
      </time>
      {entry.reason ? (
        <span className="text-xs break-words text-muted-foreground">
          Reason: {entry.reason}
        </span>
      ) : null}
    </li>
  )
}

function HistoryBody({
  state,
  onRetry,
}: {
  state: HistoryState
  onRetry: () => void
}) {
  if (state.status === "loading")
    return (
      <>
        <p role="status" className="sr-only">
          Loading history…
        </p>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </>
    )
  if (state.status === "error" || state.status === "offline")
    return (
      <>
        {state.status === "offline" ? (
          <p role="status" className="flex items-center gap-2 text-sm">
            <WifiOff aria-hidden className="size-4" />
            Offline. History is not stored on this device.
          </p>
        ) : (
          <p role="alert" className="text-sm">
            Could not read this intent&apos;s history.
          </p>
        )}
        <Button
          variant="outline"
          onClick={onRetry}
          className="min-h-11 self-start"
        >
          Retry
        </Button>
      </>
    )
  if (state.entries.length === 0)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        No history recorded
      </p>
    )
  return (
    <>
      <p role="status" className="sr-only">
        {state.entries.length === 1
          ? "1 history entry"
          : `${state.entries.length} history entries`}
      </p>
      <ol aria-label="Intent history, oldest first" className="flex flex-col">
        {state.entries.map((entry, index) => (
          <HistoryRow key={`${entry.at}-${index}`} entry={entry} />
        ))}
      </ol>
    </>
  )
}

function ActivityHistory({ intentId }: { intentId: string }) {
  const { state, retry } = useHistory(intentId)
  return (
    <>
      <header className="flex flex-col gap-1">
        <a
          href="/activity"
          className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Back to Activity
        </a>
        <h1 className="text-xl font-semibold tracking-tight">Intent history</h1>
        <p className="font-mono text-xs break-all text-muted-foreground">
          {intentId}
        </p>
      </header>
      <HistoryBody state={state} onRetry={retry} />
    </>
  )
}

export { ActivityHistory, HistoryBody }
export type { HistoryState }
