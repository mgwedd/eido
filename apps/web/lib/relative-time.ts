const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** "Waiting 22 h": how long ago `createdAt` was, in the largest whole unit (min, h, d). */
export function formatWaiting(createdAt: string, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - new Date(createdAt).getTime())
  if (elapsed < MINUTE_MS) return "Waiting less than a minute"
  if (elapsed < HOUR_MS) return `Waiting ${Math.floor(elapsed / MINUTE_MS)} min`
  if (elapsed < DAY_MS) return `Waiting ${Math.floor(elapsed / HOUR_MS)} h`
  return `Waiting ${Math.floor(elapsed / DAY_MS)} d`
}
