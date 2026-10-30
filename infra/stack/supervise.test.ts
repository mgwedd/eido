import { describe, expect, it } from "vitest"

import type { ProcessSpec } from "./config.ts"
import {
  answers,
  lineWriter,
  parsePidRecord,
  POLL_MS,
  startInOrder,
  STOP_GRACE_MS,
  stopRecord,
  waitReady,
  type Clock,
  type Launched,
  type PidRecord,
  type StopDeps,
} from "./supervise.ts"

/** A clock whose sleep advances time at once. */
function fakeClock(): Clock & { slept: number[] } {
  let now = 0
  const slept: number[] = []
  return {
    slept,
    now: () => now,
    sleep: (ms) => {
      slept.push(ms)
      now += ms
      return Promise.resolve()
    },
  }
}

const spec = (
  name: "gate" | "core" | "web",
  readyTimeoutMs = 1_000
): ProcessSpec => ({
  name,
  cwd: "/repo",
  command: "/bin/node",
  args: [],
  env: {},
  port: 1,
  healthUrl: `http://127.0.0.1/${name}`,
  marker: "src/main.ts",
  readyTimeoutMs,
})

const running = (pid = 100): Launched => ({
  pid,
  exited: new Promise(() => undefined),
})

describe("answers", () => {
  it("counts any status below 500", () => {
    expect([200, 204, 404, 499].map(answers)).toEqual([true, true, true, true])
    expect([500, 503, undefined].map(answers)).toEqual([false, false, false])
  })
})

describe("waitReady", () => {
  it("polls until the health check answers", async () => {
    const clock = fakeClock()
    const statuses = [undefined, 503, 200]
    const result = await waitReady(spec("core"), running(), {
      probe: () => Promise.resolve(statuses.shift()),
      clock,
    })
    expect(result).toBeUndefined()
    expect(clock.slept).toEqual([POLL_MS, POLL_MS])
  })

  it("also waits for alsoReady", async () => {
    let checks = 0
    const result = await waitReady(spec("gate"), running(), {
      probe: () => Promise.resolve(200),
      clock: fakeClock(),
      alsoReady: () => ++checks >= 3,
    })
    expect(result).toBeUndefined()
    expect(checks).toBe(3)
  })

  it("fails once the timeout passes", async () => {
    const result = await waitReady(spec("web", 1_000), running(), {
      probe: () => Promise.resolve(undefined),
      clock: fakeClock(),
    })
    expect(result).toBe("web did not answer http://127.0.0.1/web within 1 s")
  })

  it("reports a process that exits before it answers", async () => {
    const result = await waitReady(
      spec("gate"),
      { pid: 1, exited: Promise.resolve(3) },
      { probe: () => Promise.resolve(undefined), clock: fakeClock() }
    )
    expect(result).toBe("gate exited with code 3 before it answered")
  })
})

describe("startInOrder", () => {
  it("starts each process only once the one before answers", async () => {
    const events: string[] = []
    const result = await startInOrder(
      [spec("gate"), spec("core"), spec("web")],
      {
        launch: (s) => {
          events.push(`launch ${s.name}`)
          return running()
        },
        ready: (s) => {
          events.push(`ready ${s.name}`)
          return Promise.resolve(undefined)
        },
      }
    )
    expect(events).toEqual([
      "launch gate",
      "ready gate",
      "launch core",
      "ready core",
      "launch web",
      "ready web",
    ])
    expect(result.failure).toBeUndefined()
    expect(result.started.map((s) => s.spec.name)).toEqual([
      "gate",
      "core",
      "web",
    ])
  })

  it("stops at the first failure and returns what started", async () => {
    const launched: string[] = []
    const result = await startInOrder(
      [spec("gate"), spec("core"), spec("web")],
      {
        launch: (s) => {
          launched.push(s.name)
          return running()
        },
        ready: (s) =>
          Promise.resolve(s.name === "core" ? "core broke" : undefined),
      }
    )
    expect(launched).toEqual(["gate", "core"])
    expect(result).toMatchObject({ failure: "core broke" })
    expect(result.started.map((s) => s.spec.name)).toEqual(["gate", "core"])
  })
})

describe("parsePidRecord", () => {
  const good: PidRecord = {
    name: "core",
    pid: 1234,
    marker: "src/main.ts",
    mode: "dev",
  }

  it("reads a record it wrote", () => {
    expect(parsePidRecord(JSON.stringify(good))).toEqual(good)
  })

  it.each([
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...good, name: "other" }),
    JSON.stringify({ ...good, pid: 1 }),
    JSON.stringify({ ...good, pid: 1.5 }),
    JSON.stringify({ ...good, pid: "1234" }),
    JSON.stringify({ ...good, marker: "" }),
    JSON.stringify({ ...good, mode: "test" }),
  ])("refuses %s", (text) => {
    expect(parsePidRecord(text)).toBeUndefined()
  })
})

describe("stopRecord", () => {
  const record: PidRecord = {
    name: "gate",
    pid: 500,
    marker: "src/main.ts",
    mode: "dev",
  }

  function world(options: {
    args?: string
    aliveFor?: number
    leaderGone?: boolean
  }) {
    const signals: string[] = []
    const clock = fakeClock()
    let alive = true
    const deps: StopDeps = {
      argsOf: () => Promise.resolve(options.args),
      signalGroup: (pid, signal) => {
        signals.push(`${signal} -${pid}`)
        if (signal === "SIGKILL") alive = false
      },
      groupAlive: () => {
        if (!alive) return false
        if (signals.length === 0) return options.leaderGone !== true
        if (options.aliveFor !== undefined && clock.now() >= options.aliveFor)
          alive = false
        return alive
      },
      clock,
    }
    return { deps, signals, clock }
  }

  it("sends SIGTERM to the group and waits for it to go", async () => {
    const w = world({ args: "node ./src/main.ts", aliveFor: 1_000 })
    expect(await stopRecord(record, w.deps)).toBe("stopped")
    expect(w.signals).toEqual(["SIGTERM -500"])
  })

  it("kills a group that outlives the grace period", async () => {
    const w = world({ args: "node ./src/main.ts" })
    expect(await stopRecord(record, w.deps)).toBe("killed")
    expect(w.signals).toEqual(["SIGTERM -500", "SIGKILL -500"])
    expect(w.clock.now()).toBeGreaterThanOrEqual(STOP_GRACE_MS)
  })

  it("leaves alone a pid that now runs something else", async () => {
    const w = world({ args: "/usr/bin/vim" })
    expect(await stopRecord(record, w.deps)).toBe("not ours")
    expect(w.signals).toEqual([])
  })

  it("reports a group that is gone", async () => {
    const w = world({ leaderGone: true })
    expect(await stopRecord(record, w.deps)).toBe("not running")
    expect(w.signals).toEqual([])
  })

  it("still stops the children when the leader is gone", async () => {
    const w = world({ aliveFor: 500 })
    expect(await stopRecord(record, w.deps)).toBe("stopped")
    expect(w.signals).toEqual(["SIGTERM -500"])
  })
})

describe("lineWriter", () => {
  it("prefixes whole lines and holds a partial one until flushed", () => {
    const lines: string[] = []
    const writer = lineWriter("web  | ", (l) => lines.push(l))
    writer.push("one\ntw")
    writer.push("o\nthree")
    expect(lines).toEqual(["web  | one", "web  | two"])
    writer.flush()
    writer.flush()
    expect(lines).toEqual(["web  | one", "web  | two", "web  | three"])
  })
})
