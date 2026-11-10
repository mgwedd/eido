/** One fixed window of attempts for a key. */
export type RateWindow = { start: number; count: number }

/** Per-key windows; the caller owns the map, so the limiter itself holds no state. */
export type RateState = Map<string, RateWindow>

/**
 * A fixed-window attempt limiter. Counts this attempt for `key` at `nowMs` and answers whether it
 * is allowed: at most `limit` attempts in each `windowMs` window. Windows that have ended are
 * dropped on the way, so the map stays as small as the number of live keys.
 */
export function allowAttempt(
  state: RateState,
  key: string,
  nowMs: number,
  limit: number,
  windowMs: number
): boolean {
  for (const [other, window] of state) {
    if (nowMs - window.start >= windowMs) state.delete(other)
  }
  const window = state.get(key)
  if (window === undefined) {
    state.set(key, { start: nowMs, count: 1 })
    return true
  }
  window.count += 1
  return window.count <= limit
}
