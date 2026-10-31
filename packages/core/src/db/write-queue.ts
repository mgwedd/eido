import type { DatabaseSync } from "node:sqlite"

/**
 * Serialises every write transaction on one `node:sqlite` connection. The connection has a single
 * transaction state, and the audited stores await the gate inside theirs, so a write that started
 * meanwhile would run inside that open transaction and commit or roll back with it. Work passed
 * to `run` starts only after all earlier work has settled.
 */
export type WriteQueue = {
  /** Runs `work` after every earlier call has settled, whether it resolved or rejected. */
  run<T>(work: () => T | Promise<T>): Promise<T>
  /** Resolves once everything queued so far has settled. */
  drain(): Promise<void>
}

export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run(work) {
      const result = tail.then(work)
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
    async drain() {
      await tail
    },
  }
}

const queues = new WeakMap<DatabaseSync, WriteQueue>()

/**
 * The one write queue of `db`, created on first use. Keying it on the connection means the stores
 * and sync paths of one connection can never end up on different queues.
 */
export function writeQueueFor(db: DatabaseSync): WriteQueue {
  let queue = queues.get(db)
  if (queue === undefined) {
    queue = createWriteQueue()
    queues.set(db, queue)
  }
  return queue
}
