"use client"

import * as React from "react"

import { validateGatePendingIntentList } from "@eido/schemas"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import { formatWaiting } from "@/lib/relative-time"
import {
  describeKind,
  formatToday,
  needsYouSummary,
  selectNeedsYou,
  type PendingIntent,
} from "@/lib/today"

const PENDING_URL = "/api/gate/approvals"

type NeedsYouState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; intents: PendingIntent[] }

async function loadPending(signal: AbortSignal): Promise<NeedsYouState> {
  try {
    const response = await fetch(PENDING_URL, { cache: "no-store", signal })
    if (!response.ok) return { status: "error" }
    const parsed = validateGatePendingIntentList(await response.json())
    return parsed.ok
      ? { status: "ready", intents: parsed.value.intents }
      : { status: "error" }
  } catch {
    return { status: "error" }
  }
}

/** Loads the pending list through the gate; the response is parsed with the schema. */
function useNeedsYou(): {
  state: NeedsYouState
  loadedAt: Date
  retry: () => void
} {
  const [state, setState] = React.useState<NeedsYouState>({ status: "loading" })
  const [loadedAt, setLoadedAt] = React.useState(() => new Date())
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    void loadPending(controller.signal).then((next) => {
      if (controller.signal.aborted) return
      setLoadedAt(new Date())
      setState(next)
    })
    return () => controller.abort()
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  return { state, loadedAt, retry }
}

function NeedsYouCard({
  state,
  now,
  onRetry,
}: {
  state: NeedsYouState
  now: Date
  onRetry: () => void
}) {
  const shown = state.status === "ready" ? selectNeedsYou(state.intents) : []
  const total = state.status === "ready" ? state.intents.length : 0
  return (
    <Card role="region" aria-labelledby="needs-you-heading">
      <CardHeader>
        <h2
          id="needs-you-heading"
          className="text-xs font-semibold tracking-wider text-muted-foreground uppercase"
        >
          {total > 0 ? `Needs you · ${total}` : "Needs you"}
        </h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.status === "loading" ? (
          <>
            <p role="status" className="sr-only">
              Loading what needs you…
            </p>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        ) : null}
        {state.status === "error" ? (
          <>
            <p role="alert" className="text-sm">
              Couldn&apos;t load what needs you.
            </p>
            <Button variant="outline" onClick={onRetry} className="self-start">
              Retry
            </Button>
          </>
        ) : null}
        {state.status === "ready" && shown.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Nothing waiting for you.
          </p>
        ) : null}
        {state.status === "ready" && shown.length > 0 ? (
          <>
            <p role="status" className="sr-only">
              {needsYouSummary(total)}
            </p>
            <ul className="flex flex-col divide-y divide-border">
              {shown.map((intent) => (
                <li
                  key={intent.id}
                  className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {describeKind(intent.kind)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatWaiting(intent.createdAt, now)}
                    </span>
                  </div>
                  <Badge variant="outline">Approval</Badge>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

const subscribeNever = () => () => undefined
/** The date line comes from the browser's clock and time zone; the server renders none. */
const readToday = () => formatToday(new Date())

function TodayView() {
  const { state, loadedAt, retry } = useNeedsYou()
  const today = React.useSyncExternalStore(
    subscribeNever,
    readToday,
    () => null
  )

  const subtitle = [
    today,
    state.status === "ready" ? needsYouSummary(state.intents.length) : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <>
      <header className="flex flex-col gap-0.5">
        <h1 className="text-xl font-semibold tracking-tight">Today</h1>
        <p className="min-h-5 text-sm text-muted-foreground">{subtitle}</p>
      </header>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] items-start gap-4">
        <NeedsYouCard state={state} now={loadedAt} onRetry={retry} />
      </div>
    </>
  )
}

export { NeedsYouCard, TodayView }
export type { NeedsYouState }
