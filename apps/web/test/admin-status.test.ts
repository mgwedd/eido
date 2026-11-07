import { afterEach, describe, expect, test, vi } from "vitest"
import {
  actingMessage,
  checksSummary,
  jobRefusal,
  loadProcesses,
  loadStatus,
  requestJob,
  runningSummary,
  setLoginItem,
  splitChecks,
  transitMessage,
} from "../lib/admin/status"
import {
  doctorMixed,
  llamaOnly,
  running,
  stackAvailable,
  stackUnavailable,
  starting,
  stopped,
  stopping,
} from "./fixtures/admin-status"

afterEach(() => vi.unstubAllGlobals())

const urlOf = (input: Parameters<typeof fetch>[0]) =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url

const apiError = (status: number, code: string) =>
  Response.json({ code, message: code }, { status })

/** A fetch stub answering by path; a path it does not know answers 404. */
function route(table: Record<string, () => Response>) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const path = urlOf(input).replace("/api/gate", "")
    const make = table[path]
    return Promise.resolve(make ? make() : apiError(404, "not_found"))
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("loadStatus", () => {
  test("reads the stack, the checks and the login item", async () => {
    route({
      "/admin/stack": () => Response.json(stackAvailable(running)),
      "/admin/doctor": () => Response.json(doctorMixed),
      "/admin/login-item": () => Response.json({ enabled: true }),
    })
    expect(await loadStatus()).toEqual({
      status: "ready",
      processes: running,
      checks: { kind: "ready", checks: doctorMixed.checks },
      loginItem: { kind: "ready", enabled: true },
    })
  })

  test("a supervisor that is down on the stack route is down, without reading the rest", async () => {
    const fetchMock = route({
      "/admin/stack": () => Response.json(stackUnavailable),
    })
    expect(await loadStatus()).toEqual({ status: "down" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("a supervisor that goes down between the reads is down", async () => {
    route({
      "/admin/stack": () => Response.json(stackAvailable(running)),
      "/admin/doctor": () => apiError(503, "supervisor_unavailable"),
      "/admin/login-item": () => apiError(503, "supervisor_unavailable"),
    })
    expect(await loadStatus()).toEqual({ status: "down" })
  })

  test("a platform without a login item reads as unsupported, checks still shown", async () => {
    route({
      "/admin/stack": () => Response.json(stackAvailable(running)),
      "/admin/doctor": () => Response.json(doctorMixed),
      "/admin/login-item": () => apiError(501, "unsupported_platform"),
    })
    const result = await loadStatus()
    expect(result).toMatchObject({
      status: "ready",
      loginItem: { kind: "unsupported" },
      checks: { kind: "ready" },
    })
  })

  test("a failed doctor or login read is shown as failed in its own card", async () => {
    route({
      "/admin/stack": () => Response.json(stackAvailable(running)),
      "/admin/doctor": () => apiError(502, "supervisor_failed"),
      "/admin/login-item": () => apiError(502, "supervisor_failed"),
    })
    expect(await loadStatus()).toMatchObject({
      status: "ready",
      checks: { kind: "failed" },
      loginItem: { kind: "failed" },
    })
  })

  test("a gate that does not answer is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network")))
    )
    expect(await loadStatus()).toEqual({ status: "unreachable" })
  })

  test("a 401 is expired, from the stack read and from a later read", async () => {
    route({ "/admin/stack": () => apiError(401, "unauthenticated") })
    expect(await loadStatus()).toEqual({ status: "expired" })
    route({
      "/admin/stack": () => Response.json(stackAvailable(running)),
      "/admin/doctor": () => apiError(401, "unauthenticated"),
      "/admin/login-item": () => Response.json({ enabled: false }),
    })
    expect(await loadStatus()).toEqual({ status: "expired" })
  })

  test("an error or a malformed stack answer is an error", async () => {
    route({ "/admin/stack": () => apiError(500, "internal") })
    expect(await loadStatus()).toEqual({ status: "error" })
    route({ "/admin/stack": () => Response.json({ supervisor: "maybe" }) })
    expect(await loadStatus()).toEqual({ status: "error" })
  })
})

describe("loadProcesses", () => {
  test("returns the processes while the supervisor answers", async () => {
    route({ "/admin/stack": () => Response.json(stackAvailable(starting)) })
    expect(await loadProcesses()).toEqual(starting)
  })

  test("returns nothing when the supervisor is down or the read fails", async () => {
    route({ "/admin/stack": () => Response.json(stackUnavailable) })
    expect(await loadProcesses()).toBeUndefined()
    route({ "/admin/stack": () => apiError(500, "internal") })
    expect(await loadProcesses()).toBeUndefined()
  })
})

describe("requests", () => {
  test("a job posts both controllable names to its verb's path", async () => {
    const fetchMock = route({
      "/admin/stack/restart": () =>
        Response.json({ processes: starting, tasks: [] }, { status: 202 }),
    })
    const outcome = await requestJob("restart")
    expect(outcome).toMatchObject({ kind: "ok", status: 202 })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("/api/gate/admin/stack/restart")
    expect(init?.method).toBe("POST")
    expect(init?.body).toBe(JSON.stringify({ names: ["core", "llama"] }))
  })

  test("the login item posts the wanted state", async () => {
    const fetchMock = route({
      "/admin/login-item": () => Response.json({ enabled: false }),
    })
    expect(await setLoginItem(false)).toMatchObject({
      kind: "ok",
      value: { enabled: false },
    })
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ enabled: false })
    )
  })
})

describe("messages", () => {
  test("acting names the verb and both processes", () => {
    expect(actingMessage("start")).toBe("Starting core and llama…")
    expect(actingMessage("stop")).toBe("Stopping core and llama…")
    expect(actingMessage("restart")).toBe("Restarting core and llama…")
  })

  test("transit names only the processes on their way", () => {
    expect(transitMessage(starting)).toBe("Starting core and llama…")
    expect(transitMessage(stopping)).toBe("Stopping core and llama…")
    expect(transitMessage(running)).toBeUndefined()
    expect(transitMessage(stopped)).toBeUndefined()
    expect(
      transitMessage([
        { name: "core", state: "starting", controllable: true },
        { name: "llama", state: "stopping", controllable: true },
      ])
    ).toBe("Starting core… Stopping llama…")
  })

  test("the running summary states each process, so a partial stack is not called running", () => {
    expect(runningSummary(running)).toBe("core running, llama running.")
    expect(runningSummary(llamaOnly)).toBe("core running, llama unavailable.")
  })

  test("refusals have their own words, others fall back to the verb", () => {
    expect(jobRefusal("stop", "busy")).toBe("Another stack job is running.")
    expect(jobRefusal("stop", "stack_not_running")).toBe(
      "Core and llama are not running."
    )
    expect(jobRefusal("start", "supervisor_unavailable")).toBe(
      "The stack supervisor is not answering."
    )
    expect(jobRefusal("restart", "supervisor_failed")).toBe(
      "Could not restart core and llama."
    )
  })
})

describe("checks", () => {
  test("the summary counts each status and leaves out zeros", () => {
    expect(checksSummary(doctorMixed.checks)).toBe(
      "3 OK · 2 warnings · 1 failed"
    )
    expect(
      checksSummary(doctorMixed.checks.filter((c) => c.status === "warn"))
    ).toBe("2 warnings")
    expect(
      checksSummary(doctorMixed.checks.filter((c) => c.id === "keychain"))
    ).toBe("1 warning")
    expect(checksSummary([])).toBe("No checks")
  })

  test("failures come before warnings, each keeping its order, and OK checks are apart", () => {
    const { issues, ok } = splitChecks(doctorMixed.checks)
    expect(issues.map((c) => c.id)).toEqual([
      "llama-health",
      "keychain",
      "tailscale",
    ])
    expect(ok.map((c) => c.id)).toEqual(["node", "vault", "ports"])
  })
})
