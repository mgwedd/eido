"use client"

import * as React from "react"
import { TriangleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@eido/ui/components/alert"
import { Badge } from "@eido/ui/components/badge"
import { Button } from "@eido/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@eido/ui/components/tooltip"
import {
  MAIL_SIGNAL_LABELS,
  MAIL_SIGNALS_BANNER_TITLE,
  MAIL_SIGNALS_FAILED,
  MAIL_SIGNALS_LOADING,
  loadMailSignals,
  phishingChipAriaLabel,
  phishingChipLabel,
  type MailSignalsLoad,
} from "@/lib/mail-signals"

const WARN = "border-status-warn/40 bg-status-warn/10 text-status-warn"

export type MailSignalsState = { status: "loading" } | MailSignalsLoad

const LOADING: MailSignalsState = { status: "loading" }

function useMailSignals(sha256: string): [MailSignalsState, () => void] {
  const [attempt, setAttempt] = React.useState(0)
  const [result, setResult] = React.useState<{
    key: string
    load: MailSignalsLoad
  } | null>(null)
  const key = `${sha256}:${String(attempt)}`
  React.useEffect(() => {
    const controller = new AbortController()
    loadMailSignals(sha256, controller.signal).then(
      (load) => setResult({ key, load }),
      () => {
        // Only an abort rejects: the card unmounted or the message changed.
      }
    )
    return () => controller.abort()
  }, [sha256, key])
  // A result for another message or an earlier attempt reads as loading.
  return [
    result?.key === key ? result.load : LOADING,
    () => setAttempt((n) => n + 1),
  ]
}

export interface MailSignalsProps {
  /** The mail message's sha256 in core. */
  sha256: string
  /** Detail cards open the banner; list rows show the chip only. */
  defaultExpanded?: boolean
}

/** The "Possible phishing · N" chip and the banner it discloses, one row per signal core stored. */
export function MailSignals({ sha256, defaultExpanded }: MailSignalsProps) {
  const [state, retry] = useMailSignals(sha256)
  return (
    <MailSignalsBody
      state={state}
      onRetry={retry}
      defaultExpanded={defaultExpanded}
    />
  )
}

export function MailSignalsBody({
  state,
  onRetry,
  defaultExpanded = false,
}: {
  state: MailSignalsState
  onRetry: () => void
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = React.useState(defaultExpanded)
  const bannerId = React.useId()

  if (state.status === "loading") {
    return (
      <p role="status" className="sr-only">
        {MAIL_SIGNALS_LOADING}
      </p>
    )
  }
  if (state.status === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-muted-foreground">
          {MAIL_SIGNALS_FAILED}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    )
  }
  if (state.status === "gone" || state.signals.length === 0) {
    return <span role="status" className="sr-only" />
  }

  const { signals } = state
  return (
    <div data-slot="mail-signals" className="flex flex-col gap-2">
      <span role="status" className="inline-flex">
        <Badge
          variant="outline"
          className={WARN}
          render={
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bannerId}
              aria-label={phishingChipAriaLabel(signals.length)}
              onClick={() => setExpanded((open) => !open)}
            />
          }
        >
          {phishingChipLabel(signals.length)}
        </Badge>
      </span>
      <Alert
        id={bannerId}
        role="status"
        hidden={!expanded}
        className={`${WARN} bg-transparent`}
      >
        <TriangleAlert aria-hidden />
        <AlertTitle>{MAIL_SIGNALS_BANNER_TITLE}</AlertTitle>
        <AlertDescription className="text-foreground">
          <ul className="flex flex-col divide-y divide-border">
            {signals.map((signal, index) => (
              <li
                key={`${signal.kind}-${String(index)}`}
                className="flex flex-col gap-0.5 py-1.5"
              >
                <span>{MAIL_SIGNAL_LABELS[signal.kind]}</span>
                {signal.detail === undefined ? null : (
                  // Message text: rendered as escaped text, never linked.
                  <code className="self-start rounded-md border bg-muted px-1.5 font-mono text-xs break-all text-status-warn">
                    {signal.detail}
                  </code>
                )}
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  )
}

const NO_COUNTS: ReadonlyMap<string, number> = new Map()

/**
 * Signal counts for the cited documents that are mail messages with signals. A document core
 * does not hold as mail (404), a clean message and a failed read all leave no entry: the
 * citation then shows no mark.
 */
export function useMailSignalCounts(
  documentIds: readonly string[]
): ReadonlyMap<string, number> {
  const [result, setResult] = React.useState<{
    key: string
    counts: ReadonlyMap<string, number>
  } | null>(null)
  const key = [...new Set(documentIds)].sort().join(",")
  React.useEffect(() => {
    const ids = key === "" ? [] : key.split(",")
    const controller = new AbortController()
    void Promise.all(
      ids.map(async (id) => {
        const load = await loadMailSignals(id, controller.signal)
        return [id, load.status === "ready" ? load.signals.length : 0] as const
      })
    ).then(
      (entries) =>
        setResult({
          key,
          counts: new Map(entries.filter(([, count]) => count > 0)),
        }),
      () => {
        // Only an abort rejects: the answer changed or the view unmounted.
      }
    )
    return () => controller.abort()
  }, [key])
  // Counts for an earlier answer never mark this one's citations.
  return result?.key === key ? result.counts : NO_COUNTS
}

/** The warn mark on a citation whose message has signals; its tooltip names the count. */
export function CitationSignalMark({ count }: { count: number }) {
  const label = phishingChipLabel(count)
  const [open, setOpen] = React.useState(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center rounded-sm px-0.5 align-[1px] text-status-warn outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TriangleAlert aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
