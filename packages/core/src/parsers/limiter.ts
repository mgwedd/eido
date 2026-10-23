/** Runs at most `max` tasks at once; the rest wait in arrival order. */
export function createLimiter(
  max: number
): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: Array<() => void> = []
  return async (task) => {
    if (running < max) {
      running += 1
    } else {
      // A finishing task hands its slot straight to the next waiter, so `running` never dips.
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next === undefined) running -= 1
      else next()
    }
  }
}
