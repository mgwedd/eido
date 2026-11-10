"use client"

import Link from "next/link"
import * as React from "react"

import { validateGatePendingIntentList } from "@eido/schemas"
import { Badge } from "@eido/ui/components/badge"
import { Button, buttonVariants } from "@eido/ui/components/button"
import { Card, CardContent, CardHeader } from "@eido/ui/components/card"
import { Skeleton } from "@eido/ui/components/skeleton"
import {
  ConnectorsCard,
  type ConnectorsCardState,
} from "@/components/connectors-card"
import { DueSoonCard } from "@/components/due-soon-card"
import { MorningBriefCard } from "@/components/morning-brief-card"
import { PhoneMoreLinks } from "@/components/phone-more-links"
import { expiredUnlockUrl } from "@/lib/auth/unlock"
import { loadConnectors } from "@/lib/connectors"
import { formatWaiting } from "@/lib/relative-time"
import {
  describeKind,
  formatToday,
  needsYouSummary,
  selectNeedsYou,
  type PendingIntent,
} from "@/lib/today"
import { loadLatestBrief, type BriefState } from "@/lib/today-brief"
import {
  loadDueSoon,
  loadEntities,
  LOCAL_STORAGE_ENTITY_KEY,
  type DueSoonState,
  type FilterEntity,
} from "@/lib/today-due-soon"

const PENDING_URL = "/api/gate/approvals"

type NeedsYouState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unauthenticated" }
  | { status: "ready"; intents: PendingIntent[] }

async function loadPending(signal: AbortSignal): Promise<NeedsYouState> {
  try {
    const response = await fetch(PENDING_URL, { cache: "no-store", signal })
    if (response.status === 401) return { status: "unauthenticated" }
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
      if (next.status === "unauthenticated") {
        window.location.replace(
          expiredUnlockUrl(window.location.pathname + window.location.search)
        )
        return
      }
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

function useMorningBrief(): {
  state: BriefState
  retry: () => void
} {
  const [state, setState] = React.useState<BriefState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    void loadLatestBrief(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.status === "unauthenticated") {
        window.location.replace(
          expiredUnlockUrl(window.location.pathname + window.location.search)
        )
        return
      }
      if (result.status === "empty") {
        setState({ status: "empty" })
      } else if (result.status === "ok") {
        setState({ status: "ready", brief: result.brief })
      } else {
        setState({ status: "error" })
      }
    })
    return () => controller.abort()
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])

  return { state, retry }
}

function useConnectors(): {
  state: ConnectorsCardState
  retry: () => void
} {
  const [state, setState] = React.useState<ConnectorsCardState>({
    status: "loading",
  })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    void loadConnectors(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.status === "unauthenticated") {
        window.location.replace(
          expiredUnlockUrl(window.location.pathname + window.location.search)
        )
        return
      }
      setState(
        result.status === "ready"
          ? { status: "ready", connectors: result.connectors }
          : { status: "error" }
      )
    })
    return () => controller.abort()
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  return { state, retry }
}

function useDueSoon(): {
  state: DueSoonState
  retry: () => void
} {
  const [state, setState] = React.useState<DueSoonState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      loadDueSoon(controller.signal),
      loadEntities(controller.signal),
    ]).then(([dueSoonRes, entitiesRes]) => {
      if (controller.signal.aborted) return
      if (
        dueSoonRes.status === "unauthenticated" ||
        entitiesRes.status === "unauthenticated"
      ) {
        window.location.replace(
          expiredUnlockUrl(window.location.pathname + window.location.search)
        )
        return
      }

      if (dueSoonRes.status === "ok") {
        const entityMap = new Map<string, FilterEntity>()
        if (entitiesRes.status === "ok") {
          for (const ent of entitiesRes.entities) {
            entityMap.set(ent.id, ent)
          }
        }
        // Also add any entities present in the due soon entries
        for (const entry of dueSoonRes.data.entries) {
          if (!entityMap.has(entry.entity.id)) {
            entityMap.set(entry.entity.id, entry.entity)
          }
        }
        setState({
          status: "ready",
          entries: dueSoonRes.data.entries,
          entities: Array.from(entityMap.values()),
        })
      } else {
        setState({ status: "error" })
      }
    })
    return () => controller.abort()
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: "loading" })
    setAttempt((n) => n + 1)
  }, [])

  return { state, retry }
}

function getInitialEntity(): string {
  if (typeof window === "undefined") return "all"
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("entity")
    if (fromUrl) return fromUrl
    const fromStorage = localStorage.getItem(LOCAL_STORAGE_ENTITY_KEY)
    if (fromStorage) return fromStorage
  } catch {
    // In non-browser / test environment
  }
  return "all"
}

function useEntityFilter() {
  const [activeEntity, setActiveEntity] =
    React.useState<string>(getInitialEntity)

  const setEntity = React.useCallback((id: string) => {
    setActiveEntity(id)
    try {
      localStorage.setItem(LOCAL_STORAGE_ENTITY_KEY, id)
      const url = new URL(window.location.href)
      if (!id || id === "all") {
        url.searchParams.delete("entity")
      } else {
        url.searchParams.set("entity", id)
      }
      window.history.replaceState({}, "", url.toString())
    } catch {
      // In non-browser / test environment
    }
  }, [])

  return { activeEntity, setEntity }
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
              {shown.map((intent) => {
                const isConfirm = intent.kind === "confirm.field"
                const title =
                  isConfirm && intent.title
                    ? intent.title
                    : describeKind(intent.kind)
                const subtitle =
                  isConfirm && intent.subtitle
                    ? intent.subtitle
                    : formatWaiting(intent.createdAt, now)

                return (
                  <li
                    key={intent.id}
                    className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-medium">{title}</span>
                      <span className="text-xs text-muted-foreground">
                        {subtitle}
                      </span>
                    </div>
                    {isConfirm ? (
                      <div className="flex items-center gap-2">
                        <Badge className="border-blue-500/20 bg-blue-500/10 text-blue-500 hover:bg-blue-500/20">
                          Confirm
                        </Badge>
                        <Link
                          href={`/queue?intent=${encodeURIComponent(intent.id)}`}
                          className={
                            buttonVariants({ variant: "outline", size: "sm" }) +
                            " h-7 text-xs"
                          }
                        >
                          Review
                        </Link>
                      </div>
                    ) : (
                      <Badge variant="outline">Approval</Badge>
                    )}
                  </li>
                )
              })}
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
  const { state: needsState, loadedAt, retry: retryNeeds } = useNeedsYou()
  const { state: briefState, retry: retryBrief } = useMorningBrief()
  const { state: dueSoonState, retry: retryDueSoon } = useDueSoon()
  const { state: connectorsState, retry: retryConnectors } = useConnectors()
  const { activeEntity, setEntity } = useEntityFilter()

  const today = React.useSyncExternalStore(
    subscribeNever,
    readToday,
    () => null
  )

  const subtitle = [
    today,
    needsState.status === "ready"
      ? needsYouSummary(needsState.intents.length)
      : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <>
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-xl font-semibold tracking-tight">Today</h1>
          <p className="min-h-5 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <PhoneMoreLinks />
      </header>

      {/* Responsive layout:
          Desktop: 2 columns with wide column (Morning brief + Due soon) and narrow column (Needs you).
          Phone: single column ordered Needs you -> Morning brief -> Due soon. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="order-2 flex flex-col gap-6 lg:order-1 lg:col-span-2">
          <MorningBriefCard
            state={briefState}
            now={loadedAt}
            onRetry={retryBrief}
          />
          <DueSoonCard
            state={dueSoonState}
            now={loadedAt}
            activeEntity={activeEntity}
            onSelectEntity={setEntity}
            onRetry={retryDueSoon}
          />
        </div>
        <div className="order-1 flex flex-col gap-6 lg:order-2 lg:col-span-1">
          <NeedsYouCard
            state={needsState}
            now={loadedAt}
            onRetry={retryNeeds}
          />
          <ConnectorsCard
            state={connectorsState}
            now={loadedAt}
            onRetry={retryConnectors}
          />
        </div>
      </div>
    </>
  )
}

export { NeedsYouCard, TodayView }
export type { NeedsYouState }
