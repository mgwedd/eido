"use client"

import Link from "next/link"
import * as React from "react"

import type { GateIntentHistory, GatePrepareApproval } from "@eido/schemas"
import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import { Input } from "@eido/ui/components/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@eido/ui/components/sheet"
import { Skeleton } from "@eido/ui/components/skeleton"
import { QueueEditSheet } from "@/components/queue-edit-sheet"
import { ShortcutKeys } from "@/components/shortcuts-provider"
import { useKeydown } from "@/hooks/use-keydown"
import { shortHash } from "@/lib/approval/challenge"
import { prepareApproval, signApproval } from "@/lib/approval/sign"
import {
  confirmFieldIntent,
  editIntent,
  loadHistory,
  loadQueue,
  rejectIntent,
} from "@/lib/queue/api"
import {
  REJECT_REASONS,
  buildCard,
  historyRows,
  parseConfirmField,
  swipeOutcome,
  waitingSince,
  type ConfirmFieldCardData,
} from "@/lib/queue/card"
import {
  buildEditedIntent,
  editRefusalMessage,
  editableFields,
} from "@/lib/queue/edit"
import { isInteractiveTarget, isShortcutEvent } from "@/lib/shortcuts"
import { formatWaiting } from "@/lib/relative-time"
import { describeKind, type PendingIntent } from "@/lib/today"
import { authenticatorCopy, useAuthenticatorLabel } from "@/lib/authenticator"

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

function formatFieldValue(
  typed: ConfirmFieldCardData["value"]["typed"],
  raw: string
): string {
  if (typed === undefined || typed === null) return raw
  if (typeof typed === "string") return typed
  if (typeof typed === "number") return String(typed)
  if (
    typeof typed === "object" &&
    "amount_minor" in typed &&
    "currency" in typed
  ) {
    const amount = (typed.amount_minor / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    return `${typed.currency} ${amount}`
  }
  return raw
}

function formatFieldLabel(field: string): string {
  switch (field) {
    case "action":
      return "Action"
    case "party":
      return "Party"
    case "amount":
      return "Amount"
    case "due_date":
      return "Due date"
    case "reference_number":
      return "Reference number"
    default:
      return field.replace(/_/g, " ")
  }
}

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
  onReplaced,
  onSkip,
}: {
  intent: PendingIntent
  now: Date
  onDecided: (message: string) => void
  /** The edit replaced this intent with a new pending one that was not approved. */
  onReplaced?: (newIntentId: string, message: string) => void
  onSkip?: () => void
}) {
  const copy = authenticatorCopy(useAuthenticatorLabel())
  const [card, setCard] = React.useState<CardState>({ status: "loading" })
  const [history, setHistory] = React.useState<HistoryState>({
    status: "loading",
  })
  const [action, setAction] = React.useState<Action>({ status: "idle" })
  const [rejectOpen, setRejectOpen] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState(false)
  const [editError, setEditError] = React.useState<string | null>(null)
  const [reloads, setReloads] = React.useState(0)
  const [historyReloads, setHistoryReloads] = React.useState(0)
  const [dx, setDx] = React.useState(0)
  const dragStart = React.useRef<number | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const heading = React.useRef<HTMLHeadingElement>(null)

  const isConfirm = intent.kind === "confirm.field"
  const payloadText =
    card.status === "ready" ? card.prepared.payload : undefined
  const confirmData = React.useMemo(
    () =>
      isConfirm && payloadText ? parseConfirmField(payloadText) : undefined,
    [isConfirm, payloadText]
  )

  const [isEditing, setIsEditing] = React.useState(false)
  const [customEditValue, setCustomEditValue] = React.useState<string | null>(
    null
  )
  const editValue =
    customEditValue ??
    (confirmData
      ? formatFieldValue(confirmData.value.typed, confirmData.value.raw)
      : "")

  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const result = await prepareApproval(intent.id, controller.signal)
      if (controller.signal.aborted) return
      if (!result.ok)
        return setCard({
          status:
            result.error.code === "payload_changed" ? "mismatch" : "failed",
        })
      setCard({ status: "ready", prepared: result.value })
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
    card.status === "ready" && !isConfirm
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
  const canConfirm =
    card.status === "ready" && confirmData !== undefined && !busy

  const approve = async () => {
    if (card.status !== "ready") return
    setAction({ status: "signing" })
    const result = await signApproval(card.prepared)
    if (result.ok) return onDecided("Approved")
    if (result.error.code === "already_decided")
      return onDecided("Already decided")
    if (result.error.code === "payload_changed") {
      setAction({ status: "idle" })
      return setCard({ status: "mismatch" })
    }
    setAction({
      status: "error",
      message:
        result.error.code === "cancelled"
          ? `${copy.subject} did not complete. Nothing was approved.`
          : result.error.code === "verification_failed"
            ? "What you saw and what is stored differ. The intent was rejected and an alert was logged."
            : result.error.message,
    })
  }

  const canEdit =
    card.status === "ready" &&
    view !== undefined &&
    !busy &&
    editableFields(card.prepared.payload).length > 0

  const submitEdit = async (values: Record<string, string>) => {
    if (card.status !== "ready") return
    const edited = buildEditedIntent(card.prepared.payload, values)
    if (edited === undefined) return
    setEditError(null)
    setAction({ status: "signing" })
    const result = await editIntent(intent.id, edited)
    if (!result.ok) {
      setAction({ status: "idle" })
      if (
        result.error.code === "already_decided" ||
        result.error.code === "not_found"
      ) {
        setEditOpen(false)
        return onDecided("Already decided")
      }
      return setEditError(editRefusalMessage(result.error))
    }
    const signed = await signApproval(result.value)
    setEditOpen(false)
    if (signed.ok) return onDecided("Approved")
    // The gate has already replaced this intent with the edited one, so the queue reloads onto it.
    onReplaced?.(
      result.value.intentId,
      signed.error.code === "cancelled"
        ? `Edit saved. ${copy.subject} did not complete, so the edited intent is waiting in the queue.`
        : signed.error.message
    )
  }

  const handleConfirm = async (customValue?: unknown) => {
    if (!confirmData) return
    setAction({ status: "signing" })
    const result = await confirmFieldIntent(
      intent.id,
      confirmData.extractionId,
      confirmData.field,
      customValue
    )
    if (result.ok) {
      return onDecided("Confirmed")
    }
    setAction({ status: "error", message: result.message })
  }

  useKeydown((event) => {
    if (!isShortcutEvent(event) || event.repeat) return
    if (isConfirm) {
      if (
        (event.key === "c" || event.key === "a") &&
        canConfirm &&
        !isEditing
      ) {
        event.preventDefault()
        void handleConfirm(isEditing ? editValue : undefined)
      } else if (event.key === "e" && !busy) {
        event.preventDefault()
        setIsEditing((prev) => !prev)
      } else if (event.key === "s" && !busy) {
        event.preventDefault()
        onSkip?.()
      } else if (event.key === "Enter" && !isInteractiveTarget(event.target)) {
        event.preventDefault()
        heading.current?.focus()
      }
    } else {
      if (event.key === "a" && canApprove) {
        event.preventDefault()
        void approve()
      } else if (event.key === "e" && canEdit) {
        event.preventDefault()
        setEditError(null)
        setEditOpen(true)
      } else if (event.key === "r" && !busy) {
        event.preventDefault()
        setRejectOpen(true)
      } else if (event.key === "Enter" && !isInteractiveTarget(event.target)) {
        event.preventDefault()
        heading.current?.focus()
      }
    }
  })

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
    if (isConfirm) {
      if (outcome === "approve" && canConfirm)
        void handleConfirm(isEditing ? editValue : undefined)
      if (outcome === "reject") onSkip?.()
    } else {
      if (outcome === "approve" && canApprove) void approve()
      if (outcome === "reject" && !busy) setRejectOpen(true)
    }
  }

  const label =
    dx >= 40
      ? isConfirm
        ? "Confirm"
        : "Approve"
      : dx <= -40
        ? isConfirm
          ? "Skip"
          : "Reject"
        : null

  const documentUrl = confirmData
    ? `/documents/${confirmData.source.docSha256}?start=${confirmData.source.start}&end=${confirmData.source.end}${
        confirmData.source.page !== undefined
          ? `&page=${confirmData.source.page}`
          : ""
      }${
        confirmData.source.line !== undefined
          ? `&line=${confirmData.source.line}`
          : ""
      }&from=${encodeURIComponent(`/queue?intent=${intent.id}`)}`
    : undefined

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
            {isConfirm ? (
              <Badge
                variant="outline"
                className="border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
              >
                Confirm
              </Badge>
            ) : (
              <Badge variant="outline">Approval</Badge>
            )}
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
            {confirmData
              ? `Confirm ${confirmData.documentTitle ? `${confirmData.documentTitle} ` : ""}${formatFieldLabel(confirmData.field)}`
              : (view?.title ?? describeKind(intent.kind))}
          </h2>
          {card.status === "loading" ? (
            <>
              <p role="status" className="sr-only">
                Loading the payload…
              </p>
              <Skeleton className="h-20 w-full" />
            </>
          ) : null}
          {card.status === "failed" ||
          (card.status === "ready" && !view && !confirmData) ? (
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

          {confirmData ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  {formatFieldLabel(confirmData.field)}
                </span>
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="text-3xl font-bold tracking-tight">
                    {formatFieldValue(
                      confirmData.value.typed,
                      confirmData.value.raw
                    )}
                  </span>
                  {confirmData.value.raw &&
                  confirmData.value.raw !==
                    formatFieldValue(
                      confirmData.value.typed,
                      confirmData.value.raw
                    ) ? (
                    <span className="font-mono text-sm text-muted-foreground">
                      (raw: &ldquo;{confirmData.value.raw}&rdquo;)
                    </span>
                  ) : null}
                </div>
              </div>

              {isEditing ? (
                <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
                  <label
                    htmlFor={`edit-field-${intent.id}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Edit {formatFieldLabel(confirmData.field)}
                  </label>
                  <Input
                    id={`edit-field-${intent.id}`}
                    type="text"
                    value={editValue}
                    onChange={(e) => setCustomEditValue(e.target.value)}
                    onInput={(e) =>
                      setCustomEditValue((e.target as HTMLInputElement).value)
                    }
                    placeholder="Enter new value"
                    disabled={busy}
                  />
                </div>
              ) : null}

              {documentUrl ? (
                <div className="text-sm">
                  <Link
                    href={documentUrl}
                    className="text-primary underline underline-offset-4 hover:text-primary/80"
                  >
                    Source: {confirmData.documentTitle ?? "Document"}
                    {confirmData.source.page !== undefined
                      ? ` · Page ${confirmData.source.page}`
                      : ""}
                    {confirmData.source.line !== undefined
                      ? ` · Line ${confirmData.source.line}`
                      : ""}
                  </Link>
                </div>
              ) : null}

              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Confidence:</span>
                <span>
                  {Math.round(confirmData.confidence * 100)}% (threshold{" "}
                  {Math.round(confirmData.threshold * 100)}%)
                </span>
              </div>

              {confirmData.contextSources &&
              confirmData.contextSources.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Context sources: {confirmData.contextSources.join(", ")}
                </p>
              ) : card.status === "ready" &&
                card.prepared.documentIds.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Context used · {card.prepared.documentIds.length} linked
                  sources
                </p>
              ) : null}
            </div>
          ) : view ? (
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

          {card.status === "ready" &&
          !confirmData &&
          card.prepared.documentIds.length > 0 ? (
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
                Hashed on this device ·{" "}
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
          {isConfirm ? "Confirming…" : `Waiting for ${copy.waitingFor}`}
        </p>
      ) : null}
      {action.status === "error" ? (
        <Alert variant="destructive">
          <AlertDescription>{action.message}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-center text-xs text-muted-foreground">
        {isConfirm
          ? "Swipe right to confirm · left to skip"
          : "Swipe right to approve · left to reject"}
      </p>
      {isConfirm ? (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="lg"
            className="min-h-11"
            disabled={busy}
            aria-keyshortcuts="s"
            onClick={onSkip}
          >
            Skip
            <ShortcutKeys keys={["s"]} />
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="min-h-11"
            disabled={busy}
            aria-keyshortcuts="e"
            onClick={() => setIsEditing((prev) => !prev)}
          >
            {isEditing ? "Cancel edit" : "Edit value"}
            <ShortcutKeys keys={["e"]} />
          </Button>
          <Button
            size="lg"
            className="min-h-[60px] flex-1 bg-blue-600 text-white hover:bg-blue-700"
            disabled={!canConfirm}
            aria-keyshortcuts="c"
            onClick={() =>
              void handleConfirm(isEditing ? editValue : undefined)
            }
          >
            Confirm
            <ShortcutKeys keys={["c"]} />
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="lg"
            className="min-h-11"
            disabled={busy}
            aria-keyshortcuts="r"
            onClick={() => setRejectOpen(true)}
          >
            Reject
            <ShortcutKeys keys={["r"]} />
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="min-h-11"
            disabled={!canEdit}
            aria-keyshortcuts="e"
            onClick={() => {
              setEditError(null)
              setEditOpen(true)
            }}
          >
            Edit and approve
            <ShortcutKeys keys={["e"]} />
          </Button>
          <Button
            size="lg"
            className="min-h-[60px] flex-1"
            disabled={!canApprove}
            aria-keyshortcuts="a"
            onClick={() => void approve()}
          >
            Approve
            <ShortcutKeys keys={["a"]} />
          </Button>
        </div>
      )}
      {card.status === "ready" ? (
        <QueueEditSheet
          open={editOpen}
          intentId={intent.id}
          payload={card.prepared.payload}
          busy={busy}
          error={editError}
          onSubmit={(values) => void submitEdit(values)}
          onOpenChange={setEditOpen}
        />
      ) : null}
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
  const isConfirm = intent.kind === "confirm.field"
  return (
    <li>
      <button
        type="button"
        data-queue-row={intent.id}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className="flex min-h-11 w-full flex-col items-start rounded-lg border p-3 text-left aria-[current=true]:bg-muted"
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-sm font-medium">
            {describeKind(intent.kind)}
          </span>
          {isConfirm ? (
            <Badge
              variant="outline"
              className="border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
            >
              Confirm
            </Badge>
          ) : null}
        </div>
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

  useKeydown((event) => {
    if (!isShortcutEvent(event) || intents.length === 0) return
    const step = event.key === "j" ? 1 : event.key === "k" ? -1 : 0
    if (step !== 0) {
      event.preventDefault()
      const next = Math.min(
        intents.length - 1,
        Math.max(0, (selected ? intents.indexOf(selected) : 0) + step)
      )
      setSelectedId(intents[next]?.id)
    } else if (event.key === "Escape" && selected) {
      document
        .querySelector<HTMLElement>(`[data-queue-row="${selected.id}"]`)
        ?.focus()
    }
  })

  const decided = (id: string, text: string) => {
    setMessage(text)
    remove(id)
    setSelectedId(undefined)
  }

  const replaced = (id: string, text: string) => {
    setMessage(text)
    setSelectedId(id)
    reload()
  }

  const handleSkip = () => {
    if (intents.length <= 1) return
    const currentIndex = selected ? intents.indexOf(selected) : 0
    const nextIndex = (currentIndex + 1) % intents.length
    setSelectedId(intents[nextIndex]?.id)
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
            onReplaced={replaced}
            onSkip={handleSkip}
          />
        </div>
      ) : null}
    </>
  )
}

export { ApprovalCard, QueueView }
