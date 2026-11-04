"use client"

import * as React from "react"
import { ChevronLeft, Search, X } from "lucide-react"
import type { CoreApiConversationGet } from "@eido/schemas"
import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@eido/ui/components/input-group"
import { Skeleton } from "@eido/ui/components/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@eido/ui/components/toggle-group"
import { cn } from "@eido/ui/lib/utils"
import { useReachability } from "@/components/reachability"
import {
  conversationDate,
  isSearchable,
  KIND_FILTERS,
  loadConversation,
  loadSearch,
  matchCountLabel,
  MAX_QUERY_LENGTH,
  routeUrl,
  SEARCH_DEBOUNCE_MS,
  snippetParts,
  turnCountLabel,
  type AskRoute,
  type ConversationLoad,
  type KindFilter,
  type SearchLoad,
  type SearchHit,
} from "@/lib/ask-search"

export type SearchListState =
  | { status: "empty" }
  | { status: "searching"; previous: readonly SearchHit[] }
  | { status: "results"; hits: readonly SearchHit[] }
  | { status: "none"; query: string }
  | { status: "error" }
export type ViewerState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; conversation: CoreApiConversationGet }
  | { status: "gone" }
  | { status: "error" }

export const SEARCH_OFFLINE_MESSAGE = "Search needs a connection to the host."

function statusMessage(list: SearchListState, offline: boolean): string {
  if (offline) return SEARCH_OFFLINE_MESSAGE
  switch (list.status) {
    case "searching":
      return "Searching…"
    case "results":
      return matchCountLabel(list.hits.length)
    case "none":
      return `No conversations match "${list.query}".`
    case "empty":
    case "error":
      return ""
  }
}

function Snippet({ snippet }: { snippet: string }) {
  return (
    <span className="text-sm break-words">
      {snippetParts(snippet).map((part, index) =>
        part.match ? (
          <mark
            key={index}
            className="rounded-sm bg-primary/25 px-0.5 text-foreground"
          >
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        )
      )}
    </span>
  )
}

function isSelected(
  hit: SearchHit,
  selected: { conversation: string | null; turn: string | null }
): boolean {
  return (
    selected.conversation === hit.conversationId &&
    (hit.turnId ?? null) === selected.turn
  )
}

function ResultList({
  hits,
  dimmed,
  selected,
  onOpen,
}: {
  hits: readonly SearchHit[]
  dimmed: boolean
  selected: { conversation: string | null; turn: string | null }
  onOpen: (hit: SearchHit) => void
}) {
  return (
    <ul
      className={cn("flex flex-col gap-2", dimmed && "opacity-50")}
      aria-busy={dimmed}
    >
      {hits.map((hit, index) => {
        const current = isSelected(hit, selected)
        return (
          <li
            key={`${hit.conversationId}-${hit.turnId ?? "digest"}-${String(index)}`}
          >
            <a
              href={routeUrl({
                search: null,
                conversation: hit.conversationId,
                turn: hit.turnId ?? null,
              })}
              aria-current={current ? "true" : undefined}
              className={cn(
                "flex min-h-11 flex-col gap-1 rounded-xl border bg-card px-3 py-2.5 text-card-foreground",
                current && "border-ring bg-muted"
              )}
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.button !== 0
                )
                  return
                event.preventDefault()
                onOpen(hit)
              }}
            >
              <Badge variant={hit.kind === "digest" ? "outline" : "secondary"}>
                {hit.kind === "digest" ? "Digest" : "Turn"}
              </Badge>
              <Snippet snippet={hit.snippet} />
            </a>
          </li>
        )
      })}
    </ul>
  )
}

function SourceLabels({ sources }: { sources: readonly string[] }) {
  if (sources.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Sources">
      {sources.map((source, index) => (
        <li key={`${source}-${String(index)}`}>
          <Badge variant="outline" className="font-mono">
            {source}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

const TARGET_OUTLINE = "outline-2 outline-offset-4 outline-ring rounded-xl"

function Turn({
  turn,
  target,
}: {
  turn: CoreApiConversationGet["turns"][number]
  target: boolean
}) {
  const marker = target
    ? ({ "data-target": "true", "aria-current": "true" } as const)
    : {}
  if (turn.role === "user") {
    return (
      <div
        data-turn-id={turn.id}
        {...marker}
        className={cn(
          "max-w-[85%] self-end rounded-2xl bg-muted px-3 py-2 break-words whitespace-pre-wrap",
          target && TARGET_OUTLINE
        )}
      >
        {turn.text}
      </div>
    )
  }
  if (turn.role === "summary") {
    return (
      <div
        data-turn-id={turn.id}
        {...marker}
        className={cn(
          "flex flex-col gap-1 rounded-xl border border-dashed px-3 py-2.5",
          target && TARGET_OUTLINE
        )}
      >
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Summary
        </h3>
        <p className="text-sm break-words whitespace-pre-wrap">{turn.text}</p>
      </div>
    )
  }
  return (
    <div
      data-turn-id={turn.id}
      {...marker}
      className={cn("flex flex-col gap-1.5", target && TARGET_OUTLINE)}
    >
      <p className="break-words whitespace-pre-wrap">{turn.text}</p>
      <SourceLabels sources={turn.sources} />
    </div>
  )
}

function Viewer({
  viewer,
  turn,
  onBack,
  onNewQuestion,
  onRetry,
}: {
  viewer: Exclude<ViewerState, { status: "none" }>
  turn: string | null
  onBack: () => void
  onNewQuestion: () => void
  onRetry: () => void
}) {
  const ref = React.useRef<HTMLElement>(null)
  const ready = viewer.status === "ready"
  React.useEffect(() => {
    if (!ready) return
    ref.current
      ?.querySelector<HTMLElement>('[data-target="true"]')
      ?.scrollIntoView({ block: "center" })
  }, [ready, turn])
  const back = (
    <Button
      variant="ghost"
      className="min-h-11 self-start min-[1100px]:hidden"
      onClick={onBack}
    >
      <ChevronLeft aria-hidden />
      Back to results
    </Button>
  )
  return (
    <section
      ref={ref}
      aria-label="Conversation"
      className="flex min-w-0 flex-col gap-3"
    >
      {viewer.status !== "gone" && back}
      {viewer.status === "loading" && (
        <Card>
          <CardContent
            role="status"
            aria-label="Loading conversation"
            aria-busy="true"
            className="flex flex-col gap-3"
          >
            <Skeleton className="h-6 w-40" />
            <Skeleton className="ml-auto h-10 w-2/3" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </CardContent>
        </Card>
      )}
      {viewer.status === "gone" && (
        <Alert>
          <AlertDescription>
            <p>This conversation is no longer stored.</p>
            <Button
              variant="outline"
              className="min-h-11 self-start"
              onClick={onBack}
            >
              Back to results
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {viewer.status === "error" && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>Search is not responding. Check the host.</p>
            <Button
              variant="outline"
              className="min-h-11 self-start"
              onClick={onRetry}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {viewer.status === "ready" && (
        <Card>
          <CardContent className="flex flex-col gap-4">
            <header className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <h2 className="font-semibold tabular-nums">
                  {conversationDate(viewer.conversation) ?? "Conversation"}
                </h2>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {turnCountLabel(viewer.conversation.turns.length)}
                </p>
              </div>
              <Button
                variant="ghost"
                className="min-h-11"
                onClick={onNewQuestion}
              >
                Ask a new question
              </Button>
            </header>
            {viewer.conversation.turns.map((entry) => (
              <Turn
                key={entry.id}
                turn={entry}
                target={turn !== null && entry.id === turn}
              />
            ))}
            {viewer.conversation.digest && (
              <div
                {...(turn === null
                  ? { "data-target": "true", "aria-current": "true" }
                  : {})}
                className={cn(
                  "flex flex-col gap-1 rounded-xl border border-dashed px-3 py-2.5",
                  turn === null && TARGET_OUTLINE
                )}
              >
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Digest · covers{" "}
                  {viewer.conversation.digest.coveredTurns.toLocaleString()}{" "}
                  {viewer.conversation.digest.coveredTurns === 1
                    ? "turn"
                    : "turns"}
                </h3>
                <p className="text-sm break-words whitespace-pre-wrap">
                  {viewer.conversation.digest.text}
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Past answers are shown as they were given. Proposals from them are
              not offered again.
            </p>
          </CardContent>
        </Card>
      )}
    </section>
  )
}

export function AskSearchScreen({
  text,
  kind,
  offline,
  list,
  viewer,
  selected,
  inputRef,
  onText,
  onKind,
  onClearText,
  onClose,
  onRetry,
  onOpen,
  onBackToResults,
  onNewQuestion,
  onRetryViewer,
}: {
  text: string
  kind: KindFilter
  offline: boolean
  list: SearchListState
  viewer: ViewerState
  selected: { conversation: string | null; turn: string | null }
  inputRef?: React.Ref<HTMLInputElement>
  onText: (text: string) => void
  onKind: (kind: KindFilter) => void
  onClearText: () => void
  onClose: () => void
  onRetry: () => void
  onOpen: (hit: SearchHit) => void
  onBackToResults: () => void
  onNewQuestion: () => void
  onRetryViewer: () => void
}) {
  const viewing = viewer.status !== "none"
  const shown =
    list.status === "results"
      ? list.hits
      : list.status === "searching"
        ? list.previous
        : []
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <Button variant="outline" className="min-h-11" onClick={onClose}>
          <X aria-hidden />
          Close search
        </Button>
      </header>
      <div className="grid min-w-0 items-start gap-4 min-[1100px]:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <section
          aria-label="Search results"
          className={cn(
            "flex min-w-0 flex-col gap-3",
            viewing && "max-[1099px]:hidden"
          )}
        >
          <InputGroup className="h-auto min-h-11">
            <InputGroupAddon align="inline-start">
              <Search aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
              type="search"
              aria-label="Search past conversations"
              placeholder="Search past conversations"
              value={text}
              maxLength={MAX_QUERY_LENGTH}
              disabled={offline}
              className="min-h-11 text-base"
              onChange={(event) => onText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  onClose()
                }
              }}
            />
            {text !== "" && !offline && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-sm"
                  className="min-h-11 min-w-11"
                  aria-label="Clear"
                  onClick={onClearText}
                >
                  <X aria-hidden />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleGroup
              aria-label="Show"
              variant="outline"
              spacing={1}
              value={[kind]}
              onValueChange={(next) => {
                const picked = KIND_FILTERS.find((f) => f.value === next[0])
                if (picked) onKind(picked.value)
              }}
            >
              {KIND_FILTERS.map((filter) => (
                <ToggleGroupItem
                  key={filter.value}
                  value={filter.value}
                  disabled={offline}
                  className="min-h-11 px-4 aria-pressed:bg-foreground aria-pressed:text-background"
                >
                  {filter.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p role="status" className="text-sm text-muted-foreground">
              {statusMessage(list, offline)}
            </p>
          </div>
          {!offline && list.status === "error" && (
            <Alert variant="destructive">
              <AlertDescription>
                <p>Search is not responding. Check the host.</p>
                <Button
                  variant="outline"
                  className="min-h-11 self-start"
                  onClick={onRetry}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!offline && list.status === "none" && (
            <Button
              variant="outline"
              className="min-h-11 self-start"
              onClick={onClearText}
            >
              Clear search
            </Button>
          )}
          {!offline && shown.length > 0 && (
            <ResultList
              hits={shown}
              dimmed={list.status === "searching"}
              selected={selected}
              onOpen={onOpen}
            />
          )}
        </section>
        {viewer.status !== "none" && (
          <Viewer
            viewer={viewer}
            turn={selected.turn}
            onBack={onBackToResults}
            onNewQuestion={onNewQuestion}
            onRetry={onRetryViewer}
          />
        )}
      </div>
    </div>
  )
}

type SearchLoaded = {
  query: string
  kind: KindFilter
  attempt: number
  result: SearchLoad
}
type ViewerLoaded = {
  id: string
  attempt: number
  result: ConversationLoad
}

function listState(
  query: string,
  kind: KindFilter,
  attempt: number,
  loaded: SearchLoaded | null
): SearchListState {
  if (!isSearchable(query)) return { status: "empty" }
  if (
    loaded !== null &&
    loaded.query === query &&
    loaded.kind === kind &&
    loaded.attempt === attempt
  ) {
    if (loaded.result.status === "error") return { status: "error" }
    return loaded.result.hits.length === 0
      ? { status: "none", query: query.trim() }
      : { status: "results", hits: loaded.result.hits }
  }
  return {
    status: "searching",
    previous: loaded?.result.status === "ready" ? loaded.result.hits : [],
  }
}

function viewerState(
  id: string | null,
  attempt: number,
  loaded: ViewerLoaded | null
): ViewerState {
  if (id === null) return { status: "none" }
  if (loaded === null || loaded.id !== id || loaded.attempt !== attempt)
    return { status: "loading" }
  return loaded.result.status === "ready"
    ? { status: "ready", conversation: loaded.result.value }
    : { status: loaded.result.status }
}

export function AskSearchView({
  route,
  inputRef,
  onRoute,
  onClose,
  onBackToResults,
  onNewQuestion,
}: {
  route: AskRoute
  inputRef?: React.Ref<HTMLInputElement>
  onRoute: (next: AskRoute, how: "push" | "replace") => void
  onClose: () => void
  onBackToResults: () => void
  onNewQuestion: () => void
}) {
  const offline = useReachability() === "unreachable"
  const [text, setText] = React.useState(route.search ?? "")
  const [query, setQuery] = React.useState(route.search ?? "")
  const [urlQuery, setUrlQuery] = React.useState(route.search)
  const [kind, setKind] = React.useState<KindFilter>("any")
  const [searched, setSearched] = React.useState<SearchLoaded | null>(null)
  const [opened, setOpened] = React.useState<ViewerLoaded | null>(null)
  const [searchAttempt, setSearchAttempt] = React.useState(0)
  const [viewerAttempt, setViewerAttempt] = React.useState(0)
  const latest = React.useRef(route)
  React.useEffect(() => {
    latest.current = route
  }, [route])

  // Back and Forward change the URL under the page: take the query from it.
  if (route.search !== urlQuery) {
    setUrlQuery(route.search)
    if (route.search !== null) {
      setText(route.search)
      setQuery(route.search)
    }
  }

  React.useEffect(() => {
    if (text === query) return
    const timer = window.setTimeout(() => {
      setQuery(text)
      onRoute({ ...latest.current, search: text }, "replace")
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [text, query, onRoute])

  React.useEffect(() => {
    if (!isSearchable(query)) return
    const controller = new AbortController()
    void loadSearch(query, kind, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setSearched({ query, kind, attempt: searchAttempt, result })
    })
    return () => controller.abort()
  }, [query, kind, searchAttempt])

  const conversation = route.conversation
  React.useEffect(() => {
    if (conversation === null) return
    const controller = new AbortController()
    void loadConversation(conversation, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setOpened({ id: conversation, attempt: viewerAttempt, result })
    })
    return () => controller.abort()
  }, [conversation, viewerAttempt])

  return (
    <AskSearchScreen
      text={text}
      kind={kind}
      offline={offline}
      list={listState(query, kind, searchAttempt, searched)}
      viewer={viewerState(conversation, viewerAttempt, opened)}
      selected={{ conversation: route.conversation, turn: route.turn }}
      inputRef={inputRef}
      onText={setText}
      onKind={setKind}
      onClearText={() => setText("")}
      onClose={onClose}
      onRetry={() => setSearchAttempt((n) => n + 1)}
      onOpen={(hit) =>
        onRoute(
          {
            search: text,
            conversation: hit.conversationId,
            turn: hit.turnId ?? null,
          },
          "push"
        )
      }
      onBackToResults={onBackToResults}
      onNewQuestion={onNewQuestion}
      onRetryViewer={() => setViewerAttempt((n) => n + 1)}
    />
  )
}
