"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowUp, Check, Search, TriangleAlert } from "lucide-react"
import type { CoreApiAskResponse } from "@eido/schemas"
import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@eido/ui/components/card"
import { Field, FieldGroup, FieldLabel } from "@eido/ui/components/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@eido/ui/components/input-group"
import { Kbd } from "@eido/ui/components/kbd"
import { Separator } from "@eido/ui/components/separator"
import { Skeleton } from "@eido/ui/components/skeleton"
import { AskSearchView } from "@/components/ask-search"
import { InjectionFlag } from "@/components/injection-flag"
import {
  CitationSignalMark,
  useMailSignalCounts,
} from "@/components/mail-signals"
import {
  ASK_ROUTE,
  isSearchRoute,
  parseRoute,
  routeUrl,
  type AskRoute,
} from "@/lib/ask-search"
import { ASK_INPUT_ID, consumeAskFocus } from "@/lib/shortcuts"
import {
  actionableFollowUps,
  answerParts,
  computedFigures,
  FIGURE_LABELS,
  loadAnswer,
  submitFollowUp,
  type ProposalLoad,
} from "@/lib/ask"

export type AskState =
  | { status: "idle" }
  | { status: "running" | "error"; question: string }
  | { status: "ready"; question: string; result: CoreApiAskResponse }
export type ProposalState = ProposalLoad | { status: "proposing" }

function SourceList({
  result,
  signalCounts,
}: {
  result: CoreApiAskResponse
  signalCounts: ReadonlyMap<string, number>
}) {
  return (
    <Card className="min-w-0 self-start">
      <CardHeader>
        <CardTitle>
          <h2>Sources</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {result.citations.length === 0 ? (
          <p className="text-muted-foreground">No cited sources.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {result.citations.map((citation, index) => (
              <li
                key={`${citation.tag}-${String(index)}`}
                className="flex flex-col gap-2 break-words"
              >
                {index > 0 && <Separator />}
                <div className="flex items-center gap-1.5">
                  <span
                    className="font-mono text-xs"
                    aria-label={`Source ${citation.tag}`}
                  >
                    [{citation.tag}]
                  </span>
                  <InjectionFlag
                    variant="button"
                    injectionSuspected={citation.injectionSuspected}
                    reasons={citation.injectionReasons}
                  />
                  <CitationMark count={signalCounts.get(citation.documentId)} />
                </div>
                <p>{citation.title || citation.sourceRef}</p>
                <p className="text-xs text-muted-foreground">
                  {citation.source}
                  {citation.occurredAt && (
                    <>
                      {" "}
                      ·{" "}
                      <time dateTime={citation.occurredAt}>
                        {new Date(citation.occurredAt).toLocaleDateString(
                          undefined,
                          { year: "numeric", month: "short", day: "numeric" }
                        )}
                      </time>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function CitationMark({ count }: { count: number | undefined }) {
  return count === undefined ? null : <CitationSignalMark count={count} />
}

export function AskScreen({
  state,
  input,
  proposals,
  busy,
  inputRef,
  onInput,
  onSubmit,
  onRetry,
  onPropose,
  onOpenSearch,
  keyboardInset = 0,
}: {
  state: AskState
  input: string
  proposals: Readonly<Record<number, ProposalState>>
  busy: boolean
  keyboardInset?: number
  inputRef?: React.Ref<HTMLInputElement>
  onInput: (text: string) => void
  onSubmit: () => void
  onRetry: () => void
  onPropose: (index: number) => void
  onOpenSearch: () => void
}) {
  const result = state.status === "ready" ? state.result : undefined
  const figures = result ? computedFigures(result) : []
  const signalCounts = useMailSignalCounts(
    result?.citations.map((citation) => citation.documentId) ?? []
  )
  const citedDocument = new Map(
    result?.citations.map((citation) => [citation.tag, citation.documentId])
  )
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Ask Eido</h1>
        <Button
          variant="outline"
          className="min-h-11 min-w-11"
          aria-label="Search conversations"
          onClick={onOpenSearch}
        >
          <Search aria-hidden />
          <span aria-hidden className="hidden md:inline">
            Search conversations
          </span>
          <Kbd aria-hidden className="hidden md:inline-flex">
            ⌘K
          </Kbd>
        </Button>
      </header>
      <div className="grid min-w-0 flex-1 content-start gap-5 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
        <div className="flex min-w-0 flex-col gap-5" aria-live="polite">
          {state.status === "idle" && (
            <p role="status" className="text-muted-foreground">
              Ask about your mail, calendar and files.
            </p>
          )}
          {state.status !== "idle" && (
            <Card className="ml-auto max-w-full">
              <CardContent>
                <p
                  className="break-words whitespace-pre-wrap"
                  aria-label="Your question"
                >
                  {state.question}
                </p>
              </CardContent>
            </Card>
          )}
          {state.status === "running" && (
            <div className="flex flex-col gap-3" aria-busy="true">
              <p role="status">Reading your mail…</p>
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {state.status === "error" && (
            <Alert variant="destructive">
              <AlertDescription>
                <p>
                  Ask could not reach the local model. Check the Mac and try
                  again.
                </p>
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
          {result && (
            <>
              <article aria-label="Eido's answer">
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <h2>Answer</h2>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    {result.status === "refused" ? (
                      <p>
                        {result.reason ||
                          "This question needs more context than fits in one pass. Narrow the question."}
                      </p>
                    ) : (
                      <p className="break-words whitespace-pre-wrap">
                        {answerParts(result).map((part, index) =>
                          part.tag ? (
                            <React.Fragment key={index}>
                              <span
                                className="font-mono text-muted-foreground"
                                aria-label={`Source ${part.tag}`}
                              >
                                {part.text}
                              </span>
                              <CitationMark
                                count={signalCounts.get(
                                  citedDocument.get(part.tag) ?? ""
                                )}
                              />
                            </React.Fragment>
                          ) : (
                            <React.Fragment key={index}>
                              {part.text}
                            </React.Fragment>
                          )
                        )}
                      </p>
                    )}
                    {figures.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <Badge variant="secondary" className="self-start">
                          Count from search, not the model
                        </Badge>
                        <dl className="flex flex-wrap gap-x-6 gap-y-2">
                          {figures.map((figure) => (
                            <div key={figure.key}>
                              <dt className="text-xs text-muted-foreground">
                                {FIGURE_LABELS[figure.key]}
                              </dt>
                              <dd className="font-mono font-semibold">
                                {figure.value.toLocaleString()}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}
                    <p role="status" className="text-sm text-muted-foreground">
                      {result.coverage.label}
                    </p>
                    {result.possiblyTruncated && (
                      <Alert>
                        <TriangleAlert aria-hidden />
                        <AlertDescription>
                          The model may not have read all supplied context.
                          Treat this answer with caution.
                        </AlertDescription>
                      </Alert>
                    )}
                  </CardContent>
                </Card>
              </article>
            </>
          )}
        </div>
        {result && <SourceList result={result} signalCounts={signalCounts} />}
        {result && (
          <>
            {actionableFollowUps(result).length > 0 && (
              <section
                aria-label="Follow-up proposals"
                className="flex flex-col gap-3 min-[1100px]:col-start-1"
              >
                {actionableFollowUps(result).map((followUp, index) => {
                  const proposal = proposals[index]
                  return (
                    <Card key={index}>
                      <CardHeader>
                        <CardTitle>{followUp.label}</CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col items-start gap-3">
                        {proposal?.status === "proposed" ? (
                          <p
                            role="status"
                            className="flex flex-wrap items-center gap-2"
                          >
                            <Check aria-hidden className="size-4" />
                            Proposed{" "}
                            <Link
                              className="inline-flex min-h-11 items-center underline underline-offset-4"
                              href={proposal.href}
                            >
                              {proposal.href === "/queue"
                                ? "Open Queue"
                                : "Open Activity"}
                            </Link>
                          </p>
                        ) : (
                          <>
                            <Button
                              variant="outline"
                              className="min-h-11 max-w-full text-left whitespace-normal"
                              disabled={busy || proposal?.status === "error"}
                              onClick={() => onPropose(index)}
                            >
                              {followUp.label}
                            </Button>
                            {proposal?.status === "proposing" && (
                              <p role="status">Proposing…</p>
                            )}
                            {proposal?.status === "error" && (
                              <div className="flex flex-col gap-2">
                                <p
                                  role="alert"
                                  className="text-sm text-destructive"
                                >
                                  Could not confirm the proposal. Check Activity
                                  before trying again.
                                </p>
                                <Link
                                  href="/activity"
                                  className="inline-flex min-h-11 items-center underline underline-offset-4"
                                >
                                  Open Activity
                                </Link>
                              </div>
                            )}
                          </>
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
              </section>
            )}
          </>
        )}
      </div>
      <form
        className="sticky bottom-[calc(52px+env(safe-area-inset-bottom)+var(--ask-keyboard-inset))] bg-background py-3 md:bottom-0"
        style={
          {
            "--ask-keyboard-inset": `${String(keyboardInset)}px`,
          } as React.CSSProperties
        }
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <FieldGroup>
          <Field data-disabled={busy}>
            <FieldLabel className="sr-only" htmlFor={ASK_INPUT_ID}>
              Ask Eido
            </FieldLabel>
            <InputGroup className="h-auto min-h-14">
              <InputGroupInput
                id={ASK_INPUT_ID}
                ref={inputRef}
                value={input}
                maxLength={2000}
                disabled={busy}
                placeholder="Ask about mail, calendar, files…"
                className="min-h-14 text-base"
                onChange={(event) => onInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                onFocus={(event) =>
                  event.currentTarget.scrollIntoView({ block: "nearest" })
                }
              />
              <InputGroupAddon align="inline-end">
                <Button
                  type="submit"
                  size="icon"
                  className="min-h-11 min-w-11"
                  aria-label="Send question"
                  disabled={busy || input.trim() === ""}
                >
                  <ArrowUp aria-hidden />
                </Button>
              </InputGroupAddon>
            </InputGroup>
          </Field>
        </FieldGroup>
      </form>
    </div>
  )
}

const locationListeners = new Set<() => void>()
function subscribeToLocation(listener: () => void): () => void {
  locationListeners.add(listener)
  window.addEventListener("popstate", listener)
  return () => {
    locationListeners.delete(listener)
    window.removeEventListener("popstate", listener)
  }
}
function notifyLocation(): void {
  for (const listener of locationListeners) listener()
}
function currentSearch(): string {
  return window.location.search
}
function serverSearch(): string {
  return ""
}

/** True when the open conversation was pushed from the results, so Back returns to them. */
function openedFromResults(): boolean {
  const state: unknown = window.history.state
  return (
    typeof state === "object" &&
    state !== null &&
    "eidoAskOpened" in state &&
    state.eidoAskOpened === true
  )
}

export function AskView() {
  const [input, setInput] = React.useState("")
  const [keyboardInset, setKeyboardInset] = React.useState(0)
  const [state, setState] = React.useState<AskState>({ status: "idle" })
  const [proposals, setProposals] = React.useState<
    Record<number, ProposalState>
  >({})
  const lock = React.useRef(false)
  const controllers = React.useRef(new Set<AbortController>())
  const inputRef = React.useRef<HTMLInputElement>(null)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const locationSearch = React.useSyncExternalStore(
    subscribeToLocation,
    currentSearch,
    serverSearch
  )
  const route = React.useMemo(
    () => parseRoute(locationSearch),
    [locationSearch]
  )
  const searching = isSearchRoute(route)
  const wasSearching = React.useRef(false)
  const go = React.useCallback(
    (next: AskRoute, how: "push" | "replace", opened = false) => {
      if (how === "push")
        window.history.pushState(
          opened ? { eidoAskOpened: true } : null,
          "",
          routeUrl(next)
        )
      else window.history.replaceState(window.history.state, "", routeUrl(next))
      notifyLocation()
    },
    []
  )
  const handleRoute = React.useCallback(
    (next: AskRoute, how: "push" | "replace") => go(next, how, how === "push"),
    [go]
  )
  const openSearch = React.useCallback(() => {
    if (isSearchRoute(parseRoute(window.location.search)))
      searchInputRef.current?.focus()
    else go({ search: "", conversation: null, turn: null }, "push")
  }, [go])
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        openSearch()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [openSearch])
  React.useEffect(() => {
    if (searching && !wasSearching.current) searchInputRef.current?.focus()
    if (!searching && wasSearching.current) inputRef.current?.focus()
    wasSearching.current = searching
  }, [searching])
  React.useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () =>
      setKeyboardInset(
        Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      )
    viewport.addEventListener("resize", update)
    viewport.addEventListener("scroll", update)
    update()
    return () => {
      viewport.removeEventListener("resize", update)
      viewport.removeEventListener("scroll", update)
    }
  }, [])
  const busy =
    state.status === "running" ||
    Object.values(proposals).some((p) => p.status === "proposing")
  React.useEffect(() => {
    const pending = controllers.current
    return () => {
      for (const controller of pending) controller.abort()
    }
  }, [])
  React.useEffect(() => {
    if (consumeAskFocus()) inputRef.current?.focus()
  }, [])
  React.useEffect(() => {
    if (state.status === "ready" || state.status === "error")
      inputRef.current?.focus()
  }, [state.status])

  async function submit(question: string) {
    if (lock.current || question.trim() === "") return
    lock.current = true
    const controller = new AbortController()
    controllers.current.add(controller)
    setProposals({})
    setState({ status: "running", question: question.trim() })
    const loaded = await loadAnswer(question, controller.signal)
    controllers.current.delete(controller)
    lock.current = false
    if (controller.signal.aborted) return
    setState(
      loaded.status === "ready"
        ? { status: "ready", question: question.trim(), result: loaded.value }
        : { status: "error", question: question.trim() }
    )
  }
  async function propose(index: number) {
    if (
      lock.current ||
      state.status !== "ready" ||
      proposals[index] !== undefined
    )
      return
    const followUp = actionableFollowUps(state.result)[index]
    if (followUp === undefined) return
    lock.current = true
    const controller = new AbortController()
    controllers.current.add(controller)
    setProposals((previous) => ({
      ...previous,
      [index]: { status: "proposing" },
    }))
    const loaded = await submitFollowUp(followUp.intent, controller.signal)
    controllers.current.delete(controller)
    lock.current = false
    if (controller.signal.aborted) return
    setProposals((previous) => ({ ...previous, [index]: loaded }))
  }
  if (searching)
    return (
      <AskSearchView
        route={route}
        inputRef={searchInputRef}
        onRoute={handleRoute}
        onClose={() => go(ASK_ROUTE, "push")}
        onBackToResults={() => {
          if (openedFromResults()) window.history.back()
          else go({ ...route, conversation: null, turn: null }, "replace")
        }}
        onNewQuestion={() => {
          setInput("")
          go(ASK_ROUTE, "push")
        }}
      />
    )
  return (
    <AskScreen
      state={state}
      input={input}
      proposals={proposals}
      busy={busy}
      inputRef={inputRef}
      keyboardInset={keyboardInset}
      onInput={setInput}
      onSubmit={() => {
        void submit(input)
      }}
      onRetry={() => {
        if (state.status === "error") void submit(state.question)
      }}
      onPropose={(index) => {
        void propose(index)
      }}
      onOpenSearch={openSearch}
    />
  )
}
