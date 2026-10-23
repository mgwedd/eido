// The hourly proposal cap. In memory: a restart starts a fresh window.

const HOUR_MS = 60 * 60 * 1000

export interface ProposalLimiter {
  /** Takes one slot in the current hour, or returns false when the cap is reached. */
  tryAcquire(): boolean
}

export interface ProposalLimiterOptions {
  /** From configuration: an integer of at least 1. */
  maxProposalsPerHour: number
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: () => number
}

/** A sliding one-hour window holding at most `maxProposalsPerHour` proposals. */
export function createProposalLimiter(
  options: ProposalLimiterOptions
): ProposalLimiter {
  const max = options.maxProposalsPerHour
  if (!Number.isInteger(max) || max < 1)
    throw new RangeError("maxProposalsPerHour must be an integer of at least 1")
  const now = options.now ?? Date.now
  let taken: number[] = []
  return {
    tryAcquire() {
      const at = now()
      taken = taken.filter((t) => t > at - HOUR_MS)
      if (taken.length >= max) return false
      taken.push(at)
      return true
    },
  }
}
