"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button, buttonVariants } from "@eido/ui/components/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@eido/ui/components/table"
import { cn } from "@eido/ui/lib/utils"
import { DraftReplyAction } from "@/components/draft-reply-action"
import { ResolveAction } from "@/components/resolve-action"
import { useKeydown } from "@/hooks/use-keydown"
import { loadConnectors, type Connector } from "@/lib/connectors"
import { loadLedgerObligations, type ObligationItem } from "@/lib/ledger"
import {
  getPartialCoverageNotice,
  getRepliesUrl,
  getReplySubject,
  moveRowFocus,
  partitionReplies,
  requestDraftReply,
  requestResolveObligation,
  sortReplies,
  type DraftReplyState,
  type ResolveState,
} from "@/lib/replies"
import { isInteractiveTarget, isShortcutEvent } from "@/lib/shortcuts"
import {
  formatDueText,
  loadEntities,
  type FilterEntity,
} from "@/lib/today-due-soon"
import { buildViewerUrl } from "@/lib/viewer-url"

export interface RepliesViewProps {
  initialEntity?: string
  now?: Date
  initialConnectors?: readonly Connector[]
  isOffline?: boolean
}

function EntityFilter({
  entities = [],
  activeEntity,
  onSelectEntity,
  className,
}: {
  entities?: readonly FilterEntity[]
  activeEntity: string
  onSelectEntity: (entityId: string) => void
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label="Filter by entity"
      className={cn(
        "inline-flex h-[34px] items-center rounded-lg border border-border bg-muted/40 p-0.5 text-xs text-muted-foreground",
        className
      )}
    >
      <button
        type="button"
        aria-pressed={activeEntity === "all"}
        onClick={() => onSelectEntity("all")}
        className={cn(
          "inline-flex h-full min-h-[30px] items-center justify-center rounded-md px-2.5 font-medium transition-all",
          activeEntity === "all"
            ? "bg-background text-foreground shadow-xs"
            : "hover:text-foreground"
        )}
      >
        All
      </button>
      {entities.map((entity) => (
        <button
          key={entity.id}
          type="button"
          aria-pressed={activeEntity === entity.id}
          onClick={() => onSelectEntity(entity.id)}
          className={cn(
            "inline-flex h-full min-h-[30px] items-center justify-center rounded-md px-2.5 font-medium whitespace-nowrap transition-all",
            activeEntity === entity.id
              ? "bg-background text-foreground shadow-xs"
              : "hover:text-foreground"
          )}
        >
          {entity.name}
        </button>
      ))}
    </div>
  )
}

function EntityBadge({ entity }: { entity: ObligationItem["entity"] }) {
  return (
    <Badge
      variant="outline"
      className="border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
    >
      {entity.name}
    </Badge>
  )
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange)
  window.addEventListener("offline", onChange)
  return () => {
    window.removeEventListener("online", onChange)
    window.removeEventListener("offline", onChange)
  }
}

export function RepliesView({
  initialEntity = "all",
  now = new Date(),
  initialConnectors,
  isOffline: initialIsOffline,
}: RepliesViewProps) {
  const [activeEntity, setActiveEntity] = React.useState<string>(initialEntity)
  const [entities, setEntities] = React.useState<FilterEntity[]>([])
  const [obligations, setObligations] = React.useState<ObligationItem[]>([])
  const [connectors, setConnectors] = React.useState<readonly Connector[]>(
    initialConnectors ?? []
  )
  const [loading, setLoading] = React.useState<boolean>(true)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState<number>(0)

  const browserOffline = React.useSyncExternalStore(
    subscribeOnline,
    () => !navigator.onLine,
    () => false
  )
  const isOffline = initialIsOffline ?? browserOffline

  const [drafts, setDrafts] = React.useState<Record<number, DraftReplyState>>(
    {}
  )
  const [resolves, setResolves] = React.useState<Record<number, ResolveState>>(
    {}
  )
  const resolving = React.useRef<Set<number>>(new Set())

  const router = useRouter()
  const [focusedId, setFocusedId] = React.useState<number | null>(null)
  // Rows with a request in flight. A ref, so a second click in the same tick finds it.
  const inFlight = React.useRef<Set<number>>(new Set())

  // Load connectors
  React.useEffect(() => {
    if (initialConnectors !== undefined) return
    const controller = new AbortController()
    void (async () => {
      const res = await loadConnectors(controller.signal)
      if (res.status === "ready") {
        setConnectors(res.connectors)
      }
    })()
    return () => controller.abort()
  }, [initialConnectors])

  // Load entities
  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const res = await loadEntities(controller.signal)
      if (res.status === "ok") {
        setEntities(res.entities)
      }
    })()
    return () => controller.abort()
  }, [])

  // Load obligations
  React.useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      setLoading(true)
      setError(null)
      const res = await loadLedgerObligations(controller.signal, {
        entity: activeEntity,
        status: "open",
        limit: 100,
        offset: 0,
      })

      if (controller.signal.aborted) return

      if (res.status === "ok") {
        setObligations(res.data.obligations)
      } else if (res.status === "unauthenticated") {
        setError("Sign in required to view replies.")
      } else {
        setError(res.message || "Failed to load replies.")
      }
      setLoading(false)
    })()

    return () => controller.abort()
  }, [activeEntity, reloadToken])

  const handleSelectEntity = React.useCallback((entityId: string) => {
    setActiveEntity(entityId)
    const newUrl = getRepliesUrl(entityId)
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", newUrl)
    }
  }, [])

  const handleRetry = React.useCallback(() => {
    setReloadToken((prev) => prev + 1)
  }, [])

  const handleDraftReply = React.useCallback(
    async (row: ObligationItem) => {
      if (
        isOffline ||
        row.hasDraftIntent ||
        drafts[row.id]?.status === "saved" ||
        inFlight.current.has(row.id)
      ) {
        return
      }
      inFlight.current.add(row.id)
      setDrafts((prev) => ({ ...prev, [row.id]: { status: "pending" } }))
      const outcome = await requestDraftReply(row.id)
      inFlight.current.delete(row.id)
      setDrafts((prev) => ({
        ...prev,
        [row.id]:
          outcome.status === "saved"
            ? { status: "saved", activityHref: outcome.activityHref }
            : { status: "failed", reason: outcome.reason },
      }))
    },
    [isOffline, drafts]
  )

  const handleResolve = React.useCallback(
    async (row: ObligationItem) => {
      if (isOffline || resolving.current.has(row.id)) return
      resolving.current.add(row.id)
      setResolves((prev) => ({ ...prev, [row.id]: { status: "pending" } }))
      const outcome = await requestResolveObligation(row.id)
      resolving.current.delete(row.id)
      if (outcome.status === "resolved") {
        setObligations((prev) => prev.filter((o) => o.id !== row.id))
        setResolves((prev) => {
          const rest = { ...prev }
          delete rest[row.id]
          return rest
        })
      } else {
        setResolves((prev) => ({
          ...prev,
          [row.id]: { status: "failed", reason: outcome.reason },
        }))
      }
    },
    [isOffline]
  )

  const partialCoverageNotice = React.useMemo(() => {
    return getPartialCoverageNotice(connectors)
  }, [connectors])

  const currentRepliesUrl = getRepliesUrl(activeEntity)
  const isFiltered = activeEntity !== "all"

  // Partition and sort replies
  const { owed, waiting } = React.useMemo(() => {
    const partitioned = partitionReplies(obligations)
    return {
      owed: sortReplies(partitioned.owed, now),
      waiting: sortReplies(partitioned.waiting, now),
    }
  }, [obligations, now])

  // The focused row only counts while it is still listed (the entity filter can remove it).
  const focusedRow = owed.find((row) => row.id === focusedId) ?? null

  useKeydown((event) => {
    if (loading || error !== null || !isShortcutEvent(event)) return
    if (event.key === "j" || event.key === "k") {
      event.preventDefault()
      setFocusedId(
        moveRowFocus(
          owed.map((row) => row.id),
          focusedRow?.id ?? null,
          event.key === "j" ? "next" : "previous"
        )
      )
    } else if (event.repeat || focusedRow === null) {
      return
    } else if (event.key === "d") {
      event.preventDefault()
      void handleDraftReply(focusedRow)
    } else if (event.key === "Enter" && !isInteractiveTarget(event.target)) {
      event.preventDefault()
      router.push(
        buildViewerUrl(
          focusedRow.source.documentId,
          focusedRow.source.span,
          currentRepliesUrl
        )
      )
    }
  })

  // Keep the focused row on screen. Both the table and phone list rows carry the id; the
  // hidden one is a no-op.
  React.useEffect(() => {
    if (focusedId === null) return
    for (const el of document.querySelectorAll(
      `[data-owed-row="${focusedId}"]`
    )) {
      el.scrollIntoView?.({ block: "nearest" })
    }
  }, [focusedId])

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Replies owed
            </h1>
            <p className="text-sm text-muted-foreground">
              Threads waiting on you, and threads you are waiting on.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/ledger"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "min-h-[44px] px-3 font-medium"
              )}
            >
              Obligations
            </Link>
            <Link
              href="/documents"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "min-h-[44px] px-3 font-medium md:hidden"
              )}
            >
              Documents
            </Link>
          </div>
        </div>

        {/* Sub-nav */}
        <div
          className="flex items-center gap-1.5"
          role="navigation"
          aria-label="Ledger views"
        >
          <Link
            href="/ledger"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "h-8 px-3 text-xs"
            )}
          >
            Obligations
          </Link>
          <Link
            href="/ledger/replies"
            aria-current="page"
            className={cn(
              buttonVariants({ variant: "secondary", size: "sm" }),
              "h-8 px-3 text-xs"
            )}
          >
            Replies owed
          </Link>
          <Link
            href="/documents"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "h-8 px-3 text-xs md:hidden"
            )}
          >
            Documents
          </Link>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <EntityFilter
          entities={entities}
          activeEntity={activeEntity}
          onSelectEntity={handleSelectEntity}
        />
      </div>

      {/* States: Loading, Error, Content */}
      {loading ? (
        <div className="flex flex-col gap-6">
          <div className="sr-only" role="status" aria-live="polite">
            Loading replies owed…
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <Skeleton className="h-5 w-40" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <Skeleton className="h-5 w-40" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </CardContent>
            </Card>
          </div>
        </div>
      ) : error ? (
        <Card className="border-destructive/40 bg-destructive/5" role="alert">
          <CardContent className="flex flex-col items-start gap-3 p-6">
            <div>
              <p className="font-semibold text-destructive">
                Couldn&apos;t load replies owed.
              </p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              className="min-h-[44px]"
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Partial coverage notice */}
          {partialCoverageNotice ? (
            <Alert role="status" className="border-border/60 bg-muted/40">
              <AlertDescription>{partialCoverageNotice}</AlertDescription>
            </Alert>
          ) : null}

          {/* Two groups: side-by-side on desktop, stacking under lg (900px) and on phone */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Owed: You must reply */}
            <Card className="flex flex-col">
              <CardHeader className="border-b border-border/50 px-4 py-3">
                <CardTitle className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Replies owed · you have not answered
                  {owed.length > 0 && ` (${owed.length})`}
                </CardTitle>
              </CardHeader>

              {owed.length === 0 ? (
                <CardContent className="p-6 text-sm text-muted-foreground">
                  {isFiltered
                    ? "No replies owed for this entity."
                    : "No replies owed."}
                </CardContent>
              ) : (
                <>
                  {/* Desktop Table (scoped headers) */}
                  <div className="hidden overflow-x-auto md:block">
                    <Table aria-label="Replies owed">
                      <TableHeader>
                        <TableRow>
                          <TableHead
                            scope="col"
                            className="px-4 py-2.5 text-xs"
                          >
                            From
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-2.5 text-xs"
                          >
                            About
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-2.5 text-xs"
                          >
                            Entity
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-2.5 text-xs"
                          >
                            Waiting
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-2.5 text-right text-xs"
                          >
                            <span className="sr-only">Action</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {owed.map((row) => {
                          const subject = getReplySubject(row)
                          const dueInfo = row.dueAt
                            ? formatDueText(row.dueAt, now, "long")
                            : { text: "No due date", isOverdue: false }
                          const sourceViewerUrl = buildViewerUrl(
                            row.source.documentId,
                            row.source.span,
                            currentRepliesUrl
                          )

                          return (
                            <TableRow
                              key={row.id}
                              data-owed-row={row.id}
                              aria-current={
                                row.id === focusedRow?.id ? "true" : undefined
                              }
                              className={cn(
                                row.id === focusedRow?.id &&
                                  "bg-muted/60 ring-2 ring-ring ring-inset"
                              )}
                            >
                              <TableCell className="px-4 py-3 text-sm font-medium text-foreground">
                                {row.party ?? "Unknown"}
                              </TableCell>
                              <TableCell className="max-w-[240px] px-4 py-3 text-sm">
                                <Link
                                  href={sourceViewerUrl}
                                  className="text-foreground hover:underline"
                                >
                                  {subject}
                                </Link>
                              </TableCell>
                              <TableCell className="px-4 py-3 text-xs">
                                <EntityBadge entity={row.entity} />
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "px-4 py-3 font-mono text-xs whitespace-nowrap tabular-nums",
                                  dueInfo.isOverdue
                                    ? "font-semibold text-red-500 dark:text-red-400"
                                    : "text-muted-foreground"
                                )}
                              >
                                {dueInfo.text}
                              </TableCell>
                              <TableCell className="px-4 py-3 text-right">
                                <DraftReplyAction
                                  state={drafts[row.id]}
                                  hasDraftIntent={row.hasDraftIntent === true}
                                  isOffline={isOffline}
                                  size="desktop"
                                  onDraft={() => void handleDraftReply(row)}
                                />
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Phone List (two-line rows, 44px min targets) */}
                  <ul
                    className="divide-y divide-border/40 md:hidden"
                    role="list"
                  >
                    {owed.map((row) => {
                      const subject = getReplySubject(row)
                      const dueInfo = row.dueAt
                        ? formatDueText(row.dueAt, now, "short")
                        : { text: "No due date", isOverdue: false }
                      const sourceViewerUrl = buildViewerUrl(
                        row.source.documentId,
                        row.source.span,
                        currentRepliesUrl
                      )

                      return (
                        <li
                          key={row.id}
                          data-owed-row={row.id}
                          aria-current={
                            row.id === focusedRow?.id ? "true" : undefined
                          }
                          className={cn(
                            "min-h-[44px] px-4 py-3",
                            row.id === focusedRow?.id &&
                              "bg-muted/60 ring-2 ring-ring ring-inset"
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <Link
                              href={sourceViewerUrl}
                              className="flex min-h-[44px] flex-1 flex-col justify-center gap-1 text-foreground"
                            >
                              <span className="text-sm font-semibold">
                                {row.party ?? "Unknown"}
                              </span>
                              <span className="line-clamp-2 text-sm text-foreground/90">
                                {subject}
                              </span>
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span>{row.entity.name}</span>
                                <span>·</span>
                                <span
                                  className={cn(
                                    "tabular-nums",
                                    dueInfo.isOverdue &&
                                      "font-semibold text-red-500 dark:text-red-400"
                                  )}
                                >
                                  waiting {dueInfo.text}
                                </span>
                              </div>
                            </Link>
                            <div className="flex shrink-0 items-center">
                              <DraftReplyAction
                                state={drafts[row.id]}
                                hasDraftIntent={row.hasDraftIntent === true}
                                isOffline={isOffline}
                                size="phone"
                                onDraft={() => void handleDraftReply(row)}
                              />
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </Card>

            {/* Waiting: You are waiting on someone */}
            <Card className="flex flex-col">
              <CardHeader className="border-b border-border/50 px-4 py-3">
                <CardTitle className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Waiting on · they have not answered
                  {waiting.length > 0 && ` (${waiting.length})`}
                </CardTitle>
              </CardHeader>

              {waiting.length === 0 ? (
                <CardContent className="p-6 text-sm text-muted-foreground">
                  {isFiltered
                    ? "Nothing waiting on others for this entity."
                    : "Nothing waiting on others."}
                </CardContent>
              ) : (
                <>
                  {/* Desktop Table (scoped headers) */}
                  <div className="hidden overflow-x-auto md:block">
                    <Table aria-label="Waiting on">
                      <TableHeader>
                        <TableRow>
                          <TableHead
                            scope="col"
                            className="px-4 py-2.5 text-xs"
                          >
                            Who
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-2.5 text-xs"
                          >
                            About
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-2.5 text-xs"
                          >
                            Entity
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-2.5 text-xs"
                          >
                            Since
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-2.5 text-right text-xs"
                          >
                            <span className="sr-only">Action</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {waiting.map((row) => {
                          const subject = getReplySubject(row)
                          const dueInfo = row.dueAt
                            ? formatDueText(row.dueAt, now, "long")
                            : { text: "No due date", isOverdue: false }
                          const sourceViewerUrl = buildViewerUrl(
                            row.source.documentId,
                            row.source.span,
                            currentRepliesUrl
                          )

                          return (
                            <TableRow key={row.id}>
                              <TableCell className="px-4 py-3 text-sm font-medium text-foreground">
                                {row.party ?? "Unknown"}
                              </TableCell>
                              <TableCell className="max-w-[240px] px-4 py-3 text-sm">
                                <Link
                                  href={sourceViewerUrl}
                                  className="text-foreground hover:underline"
                                >
                                  {subject}
                                </Link>
                              </TableCell>
                              <TableCell className="px-4 py-3 text-xs">
                                <EntityBadge entity={row.entity} />
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "px-4 py-3 font-mono text-xs whitespace-nowrap tabular-nums",
                                  dueInfo.isOverdue
                                    ? "font-semibold text-red-500 dark:text-red-400"
                                    : "text-muted-foreground"
                                )}
                              >
                                {dueInfo.text}
                              </TableCell>
                              <TableCell className="px-4 py-3 text-right">
                                <ResolveAction
                                  state={resolves[row.id]}
                                  isOffline={isOffline}
                                  size="desktop"
                                  onResolve={() => void handleResolve(row)}
                                />
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Phone List (two-line rows, 44px min targets) */}
                  <ul
                    className="divide-y divide-border/40 md:hidden"
                    role="list"
                  >
                    {waiting.map((row) => {
                      const subject = getReplySubject(row)
                      const dueInfo = row.dueAt
                        ? formatDueText(row.dueAt, now, "short")
                        : { text: "No due date", isOverdue: false }
                      const sourceViewerUrl = buildViewerUrl(
                        row.source.documentId,
                        row.source.span,
                        currentRepliesUrl
                      )

                      return (
                        <li key={row.id} className="min-h-[44px] px-4 py-3">
                          <div className="flex items-center justify-between gap-2">
                            <Link
                              href={sourceViewerUrl}
                              className="flex min-h-[44px] flex-1 flex-col justify-center gap-1 text-foreground"
                            >
                              <span className="text-sm font-semibold">
                                {row.party ?? "Unknown"}
                              </span>
                              <span className="line-clamp-2 text-sm text-foreground/90">
                                {subject}
                              </span>
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span>{row.entity.name}</span>
                                <span>·</span>
                                <span
                                  className={cn(
                                    "tabular-nums",
                                    dueInfo.isOverdue &&
                                      "font-semibold text-red-500 dark:text-red-400"
                                  )}
                                >
                                  asked {dueInfo.text}
                                </span>
                              </div>
                            </Link>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <Badge
                                variant="outline"
                                className="border-blue-500/30 bg-blue-500/10 text-xs font-medium text-blue-600 dark:text-blue-400"
                              >
                                Waiting
                              </Badge>
                              <ResolveAction
                                state={resolves[row.id]}
                                isOffline={isOffline}
                                size="phone"
                                onResolve={() => void handleResolve(row)}
                              />
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}
