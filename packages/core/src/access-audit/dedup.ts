export class BoundedDeduplicator {
  private readonly entries = new Map<string, number>()
  private readonly windowMs: number
  private readonly clock: () => number
  private readonly maxEntries: number

  constructor(
    windowMs: number = 5 * 60 * 1000,
    clock: () => number = () => Date.now(),
    maxEntries = 1000
  ) {
    this.windowMs = windowMs
    this.clock = clock
    this.maxEntries = maxEntries
  }

  /**
   * Returns true if the key should be emitted (first time or window expired).
   * Returns false if within the deduplication window (suppressed).
   */
  shouldEmit(key: string): boolean {
    const now = this.clock()
    const last = this.entries.get(key)
    if (last !== undefined && now - last < this.windowMs && now >= last) {
      return false
    }
    this.prune(now)
    this.entries.set(key, now)
    return true
  }

  private prune(now: number): void {
    if (this.entries.size >= this.maxEntries) {
      for (const [key, ts] of this.entries) {
        if (now - ts >= this.windowMs || now < ts) {
          this.entries.delete(key)
        }
      }
      if (this.entries.size >= this.maxEntries) {
        const excess = this.entries.size - this.maxEntries + 1
        let removed = 0
        for (const key of this.entries.keys()) {
          this.entries.delete(key)
          removed++
          if (removed >= excess) break
        }
      }
    }
  }

  clear(): void {
    this.entries.clear()
  }
}
