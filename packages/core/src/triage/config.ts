import { localParts } from "../brief/local-time"

/** What decides where an event goes. Every number here is configuration, not a constant of the logic. */
export type TriageConfig = {
  cardBudget: {
    /**
     * Most proactive cards created per local day, confirm-field cards included. 5 is an early
     * guess, to be tuned from dogfood data.
     */
    perDay: number
  }
  /** An event scoring below this is recorded in the ledger and shown nowhere. */
  ledgerOnlyBelow: number
  /** IANA timezone whose midnight ends the budget day. */
  timezone: string
  scan: {
    /** New obligations and unconfirmed extractions are looked at when ingested this recently. */
    lookbackDays: number
    /** An open obligation due within this many days (or overdue) raises a due event. */
    dueSoonDays: number
    /** An unconfirmed extraction field scoring below this raises a confirm-field event. */
    confirmThreshold: number
  }
}

/**
 * Starting values. `perDay: 5` is an early guess, to be tuned from dogfood data; the owner can
 * override it (and the rest) through `EIDO_TRIAGE_CONFIG`.
 */
export const DEFAULT_TRIAGE_CONFIG: Omit<TriageConfig, "timezone"> = {
  cardBudget: { perDay: 5 },
  ledgerOnlyBelow: 0.3,
  scan: { lookbackDays: 3, dueSoonDays: 7, confirmThreshold: 0.8 },
}

export function validateTriageConfig(cfg: TriageConfig): void {
  if (!Number.isInteger(cfg.cardBudget.perDay) || cfg.cardBudget.perDay < 0)
    throw new RangeError("cardBudget.perDay must be a nonnegative integer")
  if (!(cfg.ledgerOnlyBelow >= 0 && cfg.ledgerOnlyBelow <= 1))
    throw new RangeError("ledgerOnlyBelow must be between 0 and 1")
  localParts(new Date(0), cfg.timezone)
  const { lookbackDays, dueSoonDays, confirmThreshold } = cfg.scan
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1)
    throw new RangeError("scan.lookbackDays must be a positive integer")
  if (!Number.isInteger(dueSoonDays) || dueSoonDays < 0)
    throw new RangeError("scan.dueSoonDays must be a nonnegative integer")
  if (!(confirmThreshold >= 0 && confirmThreshold <= 1))
    throw new RangeError("scan.confirmThreshold must be between 0 and 1")
}

/** The values an owner can set; everything else keeps its default. */
export type TriageOverrides = {
  perDay?: number
  ledgerOnlyBelow?: number
}

/** Parses `EIDO_TRIAGE_CONFIG`, a JSON object with optional `perDay` and `ledgerOnlyBelow`. */
export function parseTriageOverrides(raw: string): TriageOverrides {
  const invalid = new Error(
    "EIDO_TRIAGE_CONFIG must be a JSON object with optional perDay (a nonnegative integer) and ledgerOnlyBelow (0 to 1)"
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw invalid
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw invalid
  const perDay: unknown = Reflect.get(parsed, "perDay")
  const ledgerOnlyBelow: unknown = Reflect.get(parsed, "ledgerOnlyBelow")
  const known = Object.keys(parsed).every(
    (key) => key === "perDay" || key === "ledgerOnlyBelow"
  )
  if (
    !known ||
    (perDay !== undefined &&
      !(
        typeof perDay === "number" &&
        Number.isInteger(perDay) &&
        perDay >= 0
      )) ||
    (ledgerOnlyBelow !== undefined &&
      !(
        typeof ledgerOnlyBelow === "number" &&
        ledgerOnlyBelow >= 0 &&
        ledgerOnlyBelow <= 1
      ))
  )
    throw invalid
  return {
    ...(typeof perDay === "number" ? { perDay } : {}),
    ...(typeof ledgerOnlyBelow === "number" ? { ledgerOnlyBelow } : {}),
  }
}

/** The defaults, the owner's overrides and the profile's timezone, as one config. */
export function triageConfigFrom(
  overrides: TriageOverrides,
  timezone: string
): TriageConfig {
  return {
    ...DEFAULT_TRIAGE_CONFIG,
    cardBudget: {
      perDay: overrides.perDay ?? DEFAULT_TRIAGE_CONFIG.cardBudget.perDay,
    },
    ledgerOnlyBelow:
      overrides.ledgerOnlyBelow ?? DEFAULT_TRIAGE_CONFIG.ledgerOnlyBelow,
    timezone,
  }
}
