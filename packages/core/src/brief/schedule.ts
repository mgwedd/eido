import type { DatabaseSync } from "node:sqlite"
import { generateBrief } from "./generate"
import { localParts, parseTime } from "./local-time"
import { getBrief } from "./store"
import type { BriefConfig } from "./types"

export const BRIEF_TICK_MS = 60_000

export type BriefSchedulerDeps = {
  now?: () => Date
  /** Defaults to `setInterval`; a test passes a clock it drives itself. */
  setTicker?: (tick: () => void, ms: number) => () => void
  onError?: (error: unknown) => void
}

export type BriefScheduler = {
  stop(): void
  /** Resolves once the tick in flight, if any, has settled. */
  whenIdle(): Promise<void>
}

function defaultTicker(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * Generates today's brief once the local clock has passed the configured time. A tick runs at
 * startup, so a brief missed while the process was down is made as soon as it starts (when it is
 * past the time), and again every minute. A brief already stored for the date is left alone.
 */
export function scheduleBrief(
  db: DatabaseSync,
  getConfig: () => Promise<BriefConfig> | BriefConfig,
  deps: BriefSchedulerDeps = {}
): BriefScheduler {
  const now = deps.now ?? ((): Date => new Date())
  let inFlight: Promise<void> | undefined
  const tick = async (): Promise<void> => {
    try {
      const cfg = await getConfig()
      const at = now()
      const local = localParts(at, cfg.timezone)
      if (local.minutes < parseTime(cfg.time)) return
      if (getBrief(db, local.date) !== undefined) return
      await generateBrief(db, at, cfg)
    } catch (error) {
      deps.onError?.(error)
    }
  }
  const run = (): void => {
    if (inFlight !== undefined) return
    const started = tick()
    inFlight = started
    void started.then(() => {
      if (inFlight === started) inFlight = undefined
    })
  }
  const stopTicker = (deps.setTicker ?? defaultTicker)(run, BRIEF_TICK_MS)
  run()
  return {
    stop: stopTicker,
    whenIdle: async () => {
      await inFlight
    },
  }
}
