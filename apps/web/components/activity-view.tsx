"use client"

import {
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  TriangleAlert,
  WifiOff,
} from "lucide-react"
import * as React from "react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Button } from "@eido/ui/components/button"
import { Skeleton } from "@eido/ui/components/skeleton"
import { ActivityHistory } from "@/components/activity-history"
import { expiredUnlockUrl } from "@/lib/auth/unlock"
import {
  ACTOR_LABEL,
  ROW_KIND_LABEL,
  chainBrokenMessage,
  formatTime,
  formatTimestamp,
  groupByDay,
  intentHref,
  intentIdOf,
  loadAudit,
  loadChain,
  mergePage,
  nextCursor,
  rowKind,
  shortHash,
  type AuditEntry,
  type ChainLoad,
} from "@/lib/activity"

type ChainState =
  { status: "loading" } | Exclude<ChainLoad, { status: "unauthenticated" }>

type ListState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "offline" }
  | {
      status: "ready"
      entries: AuditEntry[]
      /** The lowest seq loaded when the gate has more; null on the last page. */
      cursor: number | null
      more: "idle" | "loading" | "error"
    }

function signedOut() {
  window.location.replace(
    expiredUnlockUrl(window.location.pathname + window.location.search)
  )
}

function useChain() {
  const [state, setState] = React.useState<ChainState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    const controller = new AbortController()
    void loadChain(controller.signal).then((next) => {
      if (controller.signal.aborted) return
      if (next.status === "unauthenticated") return signedOut()
      setState(next)
    })
    return () => controller.abort()
  }, [attempt])
  const verify = React.useCallback(() => {
    // Never keep a stale green banner while a new check runs.
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  return { state, verify }
}

function useAuditList() {
  const [state, setState] = React.useState<ListState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    const controller = new AbortController()
    void loadAudit(controller.signal).then((next) => {
      if (controller.signal.aborted) return
      if (next.status === "unauthenticated") return signedOut()
      if (next.status !== "ready") return setState(next)
      setState({
        status: "ready",
        entries: next.entries,
        cursor: nextCursor(next.entries, next.nextBefore),
        more: "idle",
      })
    })
    return () => controller.abort()
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])

  const inFlight = React.useRef(false)
  const loadMore = React.useCallback(
    (current: Extract<ListState, { status: "ready" }>) => {
      if (current.cursor === null || inFlight.current) return
      inFlight.current = true
      setState({ ...current, more: "loading" })
      void loadAudit(new AbortController().signal, current.cursor).then(
        (next) => {
          inFlight.current = false
          if (next.status === "unauthenticated") return signedOut()
          if (next.status !== "ready")
            return setState({ ...current, more: "error" })
          const entries = mergePage(current.entries, next.entries)
          setState({
            status: "ready",
            entries,
            cursor: nextCursor(entries, next.nextBefore),
            more: "idle",
          })
        }
      )
    },
    []
  )
  return { state, retry, loadMore }
}

function ChainBanner({
  state,
  onVerify,
}: {
  state: ChainState
  onVerify: () => void
}) {
  const verifyButton = (label: string) => (
    <Button
      variant="outline"
      onClick={onVerify}
      className="min-h-11 self-start md:self-auto"
    >
      <RefreshCw aria-hidden data-icon="inline-start" />
      {label}
    </Button>
  )
  if (state.status === "loading")
    return (
      <p role="status" className="min-h-11 text-sm text-muted-foreground">
        Verifying audit chain…
      </p>
    )
  if (state.status === "ready" && !state.chain.ok)
    return (
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <Alert variant="destructive" role="alert">
          <ShieldAlert aria-hidden />
          <AlertDescription>{chainBrokenMessage(state.chain)}</AlertDescription>
        </Alert>
        {verifyButton("Verify again")}
      </div>
    )
  if (state.status === "ready" && state.chain.ok)
    return (
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <Alert role="status">
          <ShieldCheck aria-hidden />
          <AlertDescription>
            Audit chain verified · {state.chain.rows}{" "}
            {state.chain.rows === 1 ? "entry" : "entries"}
          </AlertDescription>
        </Alert>
        {verifyButton("Verify again")}
      </div>
    )
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
      <Alert role="status">
        <ShieldQuestion aria-hidden />
        <AlertDescription>Chain status unavailable</AlertDescription>
      </Alert>
      <Button
        variant="outline"
        onClick={onVerify}
        className="min-h-11 self-start md:self-auto"
      >
        Retry
      </Button>
    </div>
  )
}

const ACTOR_STYLE: Record<AuditEntry["displayActor"], string> = {
  you: "border-blue-500/40 text-blue-300",
  auto: "border-emerald-500/40 text-emerald-300",
  gate: "text-muted-foreground",
}

function ActivityRow({ entry }: { entry: AuditEntry }) {
  const kind = rowKind(entry.action)
  const label = ROW_KIND_LABEL[kind]
  const intentId = intentIdOf(entry)
  return (
    <li
      data-kind={kind}
      className="grid min-h-11 gap-0.5 border-b px-1 py-2 text-sm md:grid-cols-[6.5rem_4.5rem_minmax(0,1fr)_minmax(0,1.5fr)_5.5rem] md:items-center md:gap-x-3"
    >
      <div className="flex min-w-0 flex-col gap-0.5 md:contents">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 md:order-3 md:min-w-0">
          {label ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 px-2 text-xs text-amber-300">
              <TriangleAlert aria-hidden className="size-3" />
              {label}
            </span>
          ) : null}
          <span className="font-mono break-all">{entry.action}</span>
        </span>
        <span className="min-w-0 break-all text-muted-foreground md:order-4 md:text-foreground">
          {intentId ? (
            <a
              href={intentHref(intentId)}
              className="inline-flex min-h-11 items-center underline underline-offset-2"
              aria-label={`History of ${entry.target}`}
            >
              {entry.target}
            </a>
          ) : (
            entry.target
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground md:contents">
        <time
          dateTime={entry.ts}
          title={formatTimestamp(entry.ts)}
          className="font-mono tabular-nums md:order-1"
        >
          {formatTime(entry.ts)}
        </time>
        <span
          className={`inline-flex w-fit items-center rounded-full border px-2 md:order-2 ${ACTOR_STYLE[entry.displayActor]}`}
        >
          {ACTOR_LABEL[entry.displayActor]}
        </span>
        <span
          className="font-mono tabular-nums md:order-5"
          title={entry.detailHash}
        >
          {shortHash(entry.detailHash)}
        </span>
      </div>
    </li>
  )
}

function ColumnHeader() {
  return (
    <div
      aria-hidden
      className="hidden grid-cols-[6.5rem_4.5rem_minmax(0,1fr)_minmax(0,1.5fr)_5.5rem] gap-x-3 border-b px-1 py-2 text-xs text-muted-foreground md:grid"
    >
      <span>Time</span>
      <span>Actor</span>
      <span>Action</span>
      <span>Target</span>
      <span>Hash</span>
    </div>
  )
}

function EntryGroups({ entries }: { entries: readonly AuditEntry[] }) {
  const groups = groupByDay(entries)
  return (
    <div className="flex flex-col">
      <ColumnHeader />
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`day-${group.key}`}>
          <h2
            id={`day-${group.key}`}
            className="sticky top-0 z-10 bg-background px-1 py-2 text-xs font-medium text-muted-foreground"
          >
            {group.label}
          </h2>
          <ul>
            {group.entries.map((entry) => (
              <ActivityRow key={entry.seq} entry={entry} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function ActivityBody({
  state,
  onRetry,
  onLoadMore,
}: {
  state: ListState
  onRetry: () => void
  onLoadMore: () => void
}) {
  if (state.status === "loading")
    return (
      <>
        <p role="status" className="sr-only">
          Loading activity…
        </p>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </>
    )
  if (state.status === "error" || state.status === "offline")
    return (
      <>
        {state.status === "offline" ? (
          <Alert role={undefined}>
            <WifiOff aria-hidden />
            <AlertDescription role="status">
              Offline. Activity is not stored on this device.
            </AlertDescription>
          </Alert>
        ) : (
          <p role="alert" className="text-sm">
            Could not read the audit log.
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
        No activity yet.
      </p>
    )
  return (
    <>
      <p role="status" className="sr-only">
        {state.entries.length === 1
          ? "1 entry loaded"
          : `${state.entries.length} entries loaded`}
      </p>
      <EntryGroups entries={state.entries} />
      {state.more === "error" ? (
        <p role="alert" className="text-sm">
          Could not load more entries.
        </p>
      ) : null}
      {state.cursor !== null ? (
        <Button
          variant="outline"
          onClick={onLoadMore}
          disabled={state.more === "loading"}
          className="min-h-11 self-center"
        >
          {state.more === "loading"
            ? "Loading more…"
            : state.more === "error"
              ? "Retry loading more"
              : "Load more"}
        </Button>
      ) : null}
    </>
  )
}

function ActivityList() {
  const chain = useChain()
  const list = useAuditList()
  return (
    <>
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Activity</h1>
      </header>
      <ChainBanner state={chain.state} onVerify={chain.verify} />
      <ActivityBody
        state={list.state}
        onRetry={list.retry}
        onLoadMore={() => {
          if (list.state.status === "ready") list.loadMore(list.state)
        }}
      />
    </>
  )
}

/** `/activity`, or `/activity?intent=<id>` for one intent's history. */
function ActivityView({ intentId }: { intentId?: string }) {
  return intentId ? <ActivityHistory intentId={intentId} /> : <ActivityList />
}

export { ActivityBody, ActivityView, ChainBanner }
export type { ChainState, ListState }
