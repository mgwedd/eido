import { afterEach, describe, expect, test, vi } from "vitest"
import {
  canFetch,
  canUse,
  diskLine,
  fetchFailure,
  formatSize,
  loadModels,
  progressLabel,
  progressPercent,
  taskFor,
} from "../lib/admin/models"
import {
  fetchFailed,
  fetchRunning,
  fetchSucceeded,
  gemma,
  gptOss,
  modelList,
  qwen,
  stackWith,
} from "./fixtures/admin-model"

afterEach(() => vi.unstubAllGlobals())

describe("formatSize", () => {
  test("one decimal in gigabytes, whole megabytes below that", () => {
    expect(formatSize(15_600_000_000)).toBe("15.6 GB")
    expect(formatSize(999_000_000)).toBe("999 MB")
  })
})

describe("progress", () => {
  test("label puts both numbers in the unit of the total", () => {
    expect(progressLabel(fetchRunning)).toBe("6.2 of 12.1 GB")
    expect(
      progressLabel({
        ...fetchRunning,
        receivedBytes: 120e6,
        totalBytes: 480e6,
      })
    ).toBe("120 of 480 MB")
  })

  test("label shows only what arrived while the total is unknown", () => {
    expect(
      progressLabel({
        ...fetchRunning,
        receivedBytes: 2_500_000_000,
        totalBytes: 0,
      })
    ).toBe("2.5 GB")
  })

  test("percent rounds, caps at 100 and is unknown without a total", () => {
    expect(progressPercent(fetchRunning)).toBe(51)
    expect(progressPercent({ ...fetchRunning, receivedBytes: 13e9 })).toBe(100)
    expect(progressPercent({ ...fetchRunning, totalBytes: 0 })).toBeUndefined()
  })
})

describe("taskFor", () => {
  test("takes the newest task of the profile, not another profile's", () => {
    const newer = { ...fetchSucceeded, id: "task-2" }
    const other = { ...fetchRunning, id: "task-3", profile: qwen.id }
    expect(taskFor([fetchFailed, newer, other], gptOss.id)?.id).toBe("task-2")
    expect(taskFor([fetchFailed], gemma.id)).toBeUndefined()
  })
})

describe("profile rules", () => {
  test("disk line names each disk state", () => {
    expect(diskLine(gemma)).toBe("On disk · verified")
    expect(diskLine({ ...gemma, verified: false })).toBe(
      "On disk · not verified"
    )
    expect(diskLine(gptOss)).toBe("Not on disk")
    expect(diskLine({ ...gptOss, disk: "wrong_size" })).toBe(
      "On disk · wrong size"
    )
  })

  test("Use needs a present, verified profile that is not active", () => {
    expect(canUse(qwen, gemma.id)).toBe(true)
    expect(canUse(gemma, gemma.id)).toBe(false)
    expect(canUse({ ...qwen, verified: false }, gemma.id)).toBe(false)
    expect(canUse({ ...qwen, disk: "wrong_size" }, gemma.id)).toBe(false)
    expect(canUse(gptOss, gemma.id)).toBe(false)
  })

  test("Fetch is for a missing or wrong-size file only", () => {
    expect(canFetch(gptOss)).toBe(true)
    expect(canFetch({ ...gptOss, disk: "wrong_size" })).toBe(true)
    expect(canFetch(gemma)).toBe(false)
  })

  test("a failed fetch is reported while the file is not on disk", () => {
    expect(fetchFailure(gptOss, fetchFailed)).toBe(
      "Fetch failed: the download stopped at 3.4 GB. Nothing was kept."
    )
    expect(fetchFailure(gptOss, { ...fetchFailed, receivedBytes: 0 })).toBe(
      "Fetch failed. Nothing was kept."
    )
  })

  test("no failure is reported for a running or finished task, or once the file is there", () => {
    expect(fetchFailure(gptOss, fetchRunning)).toBeUndefined()
    expect(fetchFailure(gptOss, undefined)).toBeUndefined()
    expect(
      fetchFailure({ ...gptOss, disk: "present", verified: true }, fetchFailed)
    ).toBeUndefined()
  })
})

describe("loadModels", () => {
  const answer = (routes: Record<string, () => Response | Promise<Response>>) =>
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const route =
          routes[
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url
          ]
        return route
          ? Promise.resolve(route())
          : Promise.reject(new TypeError("no route"))
      })
    )
  const signal = () => new AbortController().signal

  test("reads the profiles and the running tasks", async () => {
    answer({
      "/api/gate/admin/models": () => Response.json(modelList),
      "/api/gate/admin/stack": () => Response.json(stackWith([fetchRunning])),
    })
    expect(await loadModels(signal())).toEqual({
      status: "ready",
      list: modelList,
      tasks: [fetchRunning],
    })
  })

  test("still lists the profiles when the stack read fails", async () => {
    answer({
      "/api/gate/admin/models": () => Response.json(modelList),
      "/api/gate/admin/stack": () =>
        Response.json({ code: "unavailable", message: "x" }, { status: 500 }),
    })
    expect(await loadModels(signal())).toEqual({
      status: "ready",
      list: modelList,
      tasks: [],
    })
  })

  test("has no tasks when the supervisor does not answer the stack read", async () => {
    answer({
      "/api/gate/admin/models": () => Response.json(modelList),
      "/api/gate/admin/stack": () =>
        Response.json({ supervisor: "unavailable" }),
    })
    const load = await loadModels(signal())
    expect(load).toMatchObject({ status: "ready", tasks: [] })
  })

  test("supervisor_unavailable is the supervisor-down state", async () => {
    answer({
      "/api/gate/admin/models": () =>
        Response.json(
          { code: "supervisor_unavailable", message: "x" },
          { status: 503 }
        ),
      "/api/gate/admin/stack": () =>
        Response.json({ supervisor: "unavailable" }),
    })
    expect(await loadModels(signal())).toEqual({ status: "supervisor-down" })
  })

  test("a 401 is expired, a network failure is unreachable", async () => {
    answer({
      "/api/gate/admin/models": () => new Response(null, { status: 401 }),
      "/api/gate/admin/stack": () => new Response(null, { status: 401 }),
    })
    expect(await loadModels(signal())).toEqual({ status: "expired" })
    answer({})
    expect(await loadModels(signal())).toEqual({ status: "unreachable" })
  })

  test("another refusal or an answer outside the schema is an error", async () => {
    answer({
      "/api/gate/admin/models": () =>
        Response.json(
          { code: "supervisor_failed", message: "x" },
          { status: 502 }
        ),
      "/api/gate/admin/stack": () => Response.json(stackWith([])),
    })
    expect(await loadModels(signal())).toEqual({ status: "error" })
    answer({
      "/api/gate/admin/models": () => Response.json({ nope: true }),
      "/api/gate/admin/stack": () => Response.json(stackWith([])),
    })
    expect(await loadModels(signal())).toEqual({ status: "error" })
  })
})
