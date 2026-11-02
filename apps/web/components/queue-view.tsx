"use client"

import Link from "next/link"
import * as React from "react"

import type { GateIntentHistory, GatePrepareApproval } from "@eido/schemas"
import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@eido/ui/components/sheet"
import { Skeleton } from "@eido/ui/components/skeleton"
import { shortHash } from "@/lib/approval/challenge"
import { prepareApproval, signApproval } from "@/lib/approval/sign"
import {
  loadHistory,
  loadQueue,
  payloadMatchesHash,
  rejectIntent,
} from "@/lib/queue/api"
import {
  REJECT_REASONS,
  buildCard,
  historyRows,
  swipeLabel,
  swipeOutcome,
  waitingSince,
} from "@/lib/queue/card"
import { formatWaiting } from "@/lib/relative-time"
import { describeKind, type PendingIntent } from "@/lib/today"

type ListState =
  | { status: "loading" }
  | { status: "unreachable" }
  | { status: "ready"; intents: PendingIntent[] }

type CardState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "mismatch" }
  | { status: "ready"; prepared: GatePrepareApproval }

type HistoryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; history: GateIntentHistory }

type Action =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "error"; message: string }

const localTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso))

function useQueue() {
  const [state, setState] = React.useState<ListState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    const controller = new AbortController()
    void loadQueue(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setState(
        result.ok
          ? { status: "ready", intents: result.value }
          : { status: "unreachable" }
      )
    })
    return () => controller.abort()
  }, [attempt])
  const reload = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  return {
    state,
    reload,
    remove: (id: string) =>
      setState((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              intents: current.intents.filter((intent) => intent.id !== id),
            }
          : current
      ),
  }
}

function HistoryList({
  state,
  onRetry,
}: {
  state: HistoryState
  onRetry: () => void
}) {
  if (state.status === "loading")
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading history…
      </p>
    )
  if (state.status === "error")
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm">
          Could not load history from the audit log.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    )
  const rows = historyRows(state.history, localTime)
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">No history recorded</p>
  return (
    <ol className="flex flex-col gap-2 text-sm">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-col">
          <span>
            <time dateTime={row.iso} title={row.iso}>
              {row.time}
            </time>
            {" · "}
            {row.change}
            {" · "}
            {row.actor}
          </span>
          {row.reason ? (
            <span className="text-muted-foreground">{row.reason}</span>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function RejectSheet({
  open,
  busy,
  onChoose,
  onOpenChange,
}: {
  open: boolean
  busy: boolean
  onChoose: (code: (typeof REJECT_REASONS)[number]["code"] | undefined) => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Reject</SheetTitle>
          <SheetDescription>Why? You can skip this.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap gap-2 px-4">
          {REJECT_REASONS.map((reason) => (
            <Button
              key={reason.code}
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => onChoose(reason.code)}
            >
              {reason.label}
            </Button>
          ))}
        </div>
        <SheetFooter>
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={busy}
            onClick={() => onChoose(undefined)}
          >
            Skip
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** One approval card: the payload as labelled fields, the model's note apart, then actions. */
function ApprovalCard({
  intent,
  now,
  onDecided,
}: {
  intent: PendingIntent
  now: Date
  onDecided: (message: string) => void
}) {
  const [card, setCard] = React.useState<CardState>({ status: "loading" })
  const [history, setHistory] = React.useState<HistoryState>({
    status: "loading",
  })
  const [action, setAction] = React.useState<Action>({ status: "idle" })
  const [rejectOpen, setRejectOpen] = React.useState(false)
  const [reloads, setReloads] = React.useState(0)
  const [historyReloads, setHistoryReloads] = React.useState(0)
  const [dx, setDx] = React.useState(0)
  const dragStart = React.useRef<number | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const heading = React.useRef<HTMLHeadingElement>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const result = await prepareApproval(intent.id, controller.signal)
      if (controller.signal.aborted) return
      if (!result.ok) return setCard({ status: "failed" })
      const matches = await payloadMatchesHash(
        result.value.payload,
        result.value.payloadHash
      )
      if (controller.signal.aborted) return
      setCard(
        matches
          ? { status: "ready", prepared: result.value }
          : { status: "mismatch" }
      )
    })()
    return () => controller.abort()
  }, [intent.id, reloads])

  React.useEffect(() => {
    const controller = new AbortController()
    void loadHistory(intent.id, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setHistory(
        result.ok
          ? { status: "ready", history: result.value }
          : { status: "error" }
      )
    })
    return () => controller.abort()
  }, [intent.id, historyReloads])

  const view =
    card.status === "ready"
      ? buildCard(card.prepared.kind, card.prepared.payload)
      : undefined
  const waiting = formatWaiting(
    waitingSince(
      history.status === "ready" ? history.history : undefined,
      intent.createdAt
    ),
    now
  )
  const busy = action.status === "signing"
  const canApprove = card.status === "ready" && view !== undefined && !busy

  const approve = async () => {
    if (card.status !== "ready") return
    setAction({ status: "signing" })
    const result = await signApproval(card.prepared)
    if (result.ok) return onDecided("Approved")
    if (result.error.code === "already_decided")
      return onDecided("Already decided")
    setAction({
      status: "error",
      message:
        result.error.code === "cancelled"
          ? "Face ID did not complete. Nothing was approved."
          : result.error.code === "verification_failed"
            ? "What you saw and what is stored differ. The intent was rejected and an alert was logged."
            : result.error.message,
    })
  }

  const reject = async (code?: (typeof REJECT_REASONS)[number]["code"]) => {
    setAction({ status: "signing" })
    const result = await rejectIntent(intent.id, code)
    setRejectOpen(false)
    if (result.ok)
      return onDecided(code ? "Rejected · reason saved for evals" : "Rejected")
    if (result.error.code === "already_decided")
      return onDecided("Already decided")
    setAction({ status: "error", message: result.error.message })
  }

  const finishSwipe = () => {
    const outcome = swipeOutcome(dx)
    dragStart.current = null
    setDragging(false)
    setDx(0)
    if (outcome === "approve" && canApprove) void approve()
    if (outcome === "reject" && !busy) setRejectOpen(true)
  }
  const label = swipeLabel(dx)

  return (
    <article
      aria-labelledby={`card-${intent.id}`}
      className="flex touch-pan-y flex-col gap-4"
      style={{
        transform: dx ? `translateX(${dx}px) rotate(${dx / 24}deg)` : undefined,
        transition: dragging ? undefined : "transform 200ms",
      }}
      onPointerDown={(event) => {
        dragStart.current = event.clientX
        setDragging(true)
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (dragStart.current !== null) setDx(event.clientX - dragStart.current)
      }}
      onPointerUp={finishSwipe}
      onPointerCancel={() => {
        dragStart.current = null
        setDragging(false)
        setDx(0)
      }}
    >
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {describeKind(intent.kind)}
            </p>
            <Badge variant="outline">Approval</Badge>
          </div>
          {label ? (
            <p className="text-sm font-semibold" aria-hidden="true">
              {label}
            </p>
          ) : null}
          <h2
            id={`card-${intent.id}`}
            ref={heading}
            tabIndex={-1}
            className="text-lg font-semibold outline-none"
          >
            {view?.title ?? describeKind(intent.kind)}
          </h2>
          {card.status === "loading" ? (
            <>
              <p role="status" className="sr-only">
                Loading the payload…
              </p>
              <Skeleton className="h-20 w-full" />
            </>
          ) : null}
          {card.status === "failed" || (card.status === "ready" && !view) ? (
            <div className="flex flex-col items-start gap-2">
              <p role="alert" className="text-sm">
                Could not load the payload.
              </p>
              <Button
                variant="outline"
                onClick={() => setReloads((n) => n + 1)}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {card.status === "mismatch" ? (
            <div className="flex flex-col items-start gap-2">
              <p role="alert" className="text-sm">
                Payload changed. Reload the card.
              </p>
              <Button
                variant="outline"
                onClick={() => setReloads((n) => n + 1)}
              >
                Reload
              </Button>
            </div>
          ) : null}
          {view ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {view.fields.map((field) => (
                <React.Fragment key={field.label}>
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd
                    className={
                      field.block
                        ? "rounded-lg border p-3 break-words whitespace-pre-wrap"
                        : "break-words"
                    }
                  >
                    {field.value}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          ) : null}
          {card.status === "ready" && card.prepared.documentIds.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Context used · {card.prepared.documentIds.length} linked sources
            </p>
          ) : null}
          {card.status === "ready" && card.prepared.rationale ? (
            <section className="flex flex-col gap-1 border-t border-dashed pt-3">
              <h3 className="text-xs text-muted-foreground">
                Agent&apos;s note · written by the model, not part of the action
              </h3>
              <p className="text-sm break-words whitespace-pre-wrap">
                {card.prepared.rationale}
              </p>
            </section>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{waiting}</span>
            {card.status === "ready" ? (
              <span>
                Payload hash ·{" "}
                <code>{shortHash(card.prepared.payloadHash)}</code>
              </span>
            ) : null}
          </div>
          <section aria-label="History">
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">
              History
            </h3>
            <HistoryList
              state={history}
              onRetry={() => {
                setHistory({ status: "loading" })
                setHistoryReloads((n) => n + 1)
              }}
            />
          </section>
        </CardContent>
      </Card>
      {action.status === "signing" ? (
        <p role="status" className="text-sm">
          Waiting for Face ID
        </p>
      ) : null}
      {action.status === "error" ? (
        <Alert variant="destructive">
          <AlertDescription>{action.message}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-center text-xs text-muted-foreground">
        Swipe right to approve · left to reject
      </p>
      <div className="flex items-center justify-center gap-3">
        <Button
          variant="outline"
          size="lg"
          className="min-h-11"
          disabled={busy}
          onClick={() => setRejectOpen(true)}
        >
          Reject
        </Button>
        <Button
          size="lg"
          className="min-h-[60px] flex-1"
          disabled={!canApprove}
          onClick={() => void approve()}
        >
          Approve
        </Button>
      </div>
      <RejectSheet
        open={rejectOpen}
        busy={busy}
        onChoose={(code) => void reject(code)}
        onOpenChange={setRejectOpen}
      />
    </article>
  )
}

function QueueRow({
  intent,
  now,
  selected,
  onSelect,
}: {
  intent: PendingIntent
  now: Date
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className="flex min-h-11 w-full flex-col items-start rounded-lg border p-3 text-left aria-[current=true]:bg-muted"
      >
        <span className="text-sm font-medium">{describeKind(intent.kind)}</span>
        <span className="text-xs text-muted-foreground">
          {formatWaiting(intent.createdAt, now)}
        </span>
      </button>
    </li>
  )
}

function QueueView({ initialId }: { initialId?: string }) {
  const { state, reload, remove } = useQueue()
  const [selectedId, setSelectedId] = React.useState(initialId)
  const [message, setMessage] = React.useState<string | null>(null)
  const [now] = React.useState(() => new Date())

  const intents = state.status === "ready" ? state.intents : []
  const selected =
    intents.find((intent) => intent.id === selectedId) ?? intents[0]
  const position = selected ? intents.indexOf(selected) + 1 : 0

  const decided = (id: string, text: string) => {
    setMessage(text)
    remove(id)
    setSelectedId(undefined)
  }

  return (
    <>
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Queue</h1>
        {selected ? (
          <p className="text-sm text-muted-foreground">
            {position} of {intents.length}
          </p>
        ) : null}
      </header>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {state.status === "loading" ? (
        <>
          <p role="status" className="sr-only">
            Loading the queue…
          </p>
          <Skeleton className="h-64 w-full" />
        </>
      ) : null}
      {state.status === "unreachable" ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm">
            Couldn&apos;t load the queue.
          </p>
          <Button variant="outline" onClick={reload}>
            Retry
          </Button>
        </div>
      ) : null}
      {state.status === "ready" && intents.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p role="status" className="text-sm">
            Queue clear. Every decision is in Activity.
          </p>
          <Link href="/" className="text-sm underline">
            Back to Today
          </Link>
        </div>
      ) : null}
      {selected ? (
        <div className="grid items-start gap-4 md:grid-cols-[minmax(220px,300px)_1fr]">
          <ul className="hidden flex-col gap-2 md:flex">
            {intents.map((intent) => (
              <QueueRow
                key={intent.id}
                intent={intent}
                now={now}
                selected={intent.id === selected.id}
                onSelect={() => setSelectedId(intent.id)}
              />
            ))}
          </ul>
          <ApprovalCard
            key={selected.id}
            intent={selected}
            now={now}
            onDecided={(text) => decided(selected.id, text)}
          />
        </div>
      ) : null}
    </>
  )
}

export { ApprovalCard, QueueView }
