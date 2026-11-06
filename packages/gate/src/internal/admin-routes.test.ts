import { describe, expect, it } from "vitest"
import type {
  StackDoctorReport,
  StackJobStatus,
  StackModelList,
} from "@eido/schemas"
import { adminRoute, supervisorFailure } from "./admin-routes"
import type { GateRequest, Reply } from "./http"
import {
  SupervisorRequestError,
  SupervisorUnavailableError,
} from "./supervisor-client"
import type { SupervisorClient } from "./supervisor-client"

const JOBS: StackJobStatus = {
  processes: [{ name: "core", state: "running", controllable: true }],
  tasks: [],
}
const MODELS: StackModelList = { active: "small", profiles: [] }
const DOCTOR: StackDoctorReport = { checks: [] }

const REQUEST: GateRequest = {
  method: "POST",
  path: "/admin/stack/start",
  query: new URLSearchParams(),
  headers: {},
  body: () => Promise.resolve({ ok: true, text: "" }),
}

type Call = { method: string; args: unknown[] }

/** A stand-in client: records each call and answers with `answer`, or throws `fail`. */
function fake(fail?: Error): { client: SupervisorClient; calls: Call[] } {
  const calls: Call[] = []
  const answer =
    <T>(method: string, value: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ method, args })
      return fail === undefined ? Promise.resolve(value) : Promise.reject(fail)
    }
  return {
    calls,
    client: {
      doctor: answer("doctor", DOCTOR),
      jobs: answer("jobs", JOBS),
      start: answer("start", JOBS),
      stop: answer("stop", JOBS),
      restart: answer("restart", JOBS),
      models: answer("models", MODELS),
      useModel: answer("useModel", MODELS),
      fetchModel: answer("fetchModel", JOBS),
      settings: answer("settings", { sha256: null, settings: {} }),
      writeSettings: answer("writeSettings", { sha256: null, settings: {} }),
    },
  }
}

const json = (value: unknown) => () =>
  Promise.resolve({ ok: true as const, value })

function codeOf(reply: Reply): unknown {
  return typeof reply.body === "object" &&
    reply.body !== null &&
    "code" in reply.body
    ? reply.body.code
    : undefined
}

describe("supervisorFailure", () => {
  it.each([
    [new SupervisorUnavailableError("x"), 503, "supervisor_unavailable"],
    [new SupervisorRequestError(404, "not_found", "x"), 404, "not_found"],
    [
      new SupervisorRequestError(400, "invalid_body", "x"),
      400,
      "invalid_request",
    ],
    [new SupervisorRequestError(409, "busy", "x"), 503, "busy"],
    [
      new SupervisorRequestError(409, "stack_not_running", "x"),
      409,
      "stack_not_running",
    ],
    [
      new SupervisorRequestError(200, "bad_response", "x"),
      502,
      "supervisor_failed",
    ],
  ])("maps %s to %i %s", (error, status, code) => {
    const reply = supervisorFailure(error)
    expect([reply.status, codeOf(reply)]).toEqual([status, code])
  })

  it("never passes the supervisor's message on", () => {
    const reply = supervisorFailure(
      new SupervisorRequestError(500, "bad_response", "secret-ish detail")
    )
    expect(JSON.stringify(reply.body)).not.toContain("secret-ish detail")
  })

  it("rethrows an error that is not the supervisor's", () => {
    const bug = new TypeError("bug")
    expect(() => supervisorFailure(bug)).toThrow(bug)
  })
})

describe("adminRoute without a supervisor socket", () => {
  it("reports the stack as unavailable", async () => {
    const reply = await adminRoute(
      undefined,
      "/admin/stack",
      "",
      REQUEST,
      json({})
    )
    expect(reply).toEqual({ status: 200, body: { supervisor: "unavailable" } })
  })

  it("answers 503 for every other admin route", async () => {
    const reply = await adminRoute(
      undefined,
      "/admin/doctor",
      "",
      REQUEST,
      json({})
    )
    expect([reply.status, codeOf(reply)]).toEqual([
      503,
      "supervisor_unavailable",
    ])
  })
})

describe("adminRoute", () => {
  it("wraps the supervisor's jobs in the stack status", async () => {
    const { client } = fake()
    expect(
      await adminRoute(client, "/admin/stack", "", REQUEST, json({}))
    ).toEqual({ status: 200, body: { supervisor: "available", jobs: JOBS } })
  })

  it("reports the stack as unavailable when the supervisor does not answer", async () => {
    const { client } = fake(new SupervisorUnavailableError("down"))
    expect(
      await adminRoute(client, "/admin/stack", "", REQUEST, json({}))
    ).toEqual({ status: 200, body: { supervisor: "unavailable" } })
  })

  it("maps a supervisor refusal on the stack status", async () => {
    const { client } = fake(
      new SupervisorRequestError(200, "bad_response", "x")
    )
    const reply = await adminRoute(
      client,
      "/admin/stack",
      "",
      REQUEST,
      json({})
    )
    expect([reply.status, codeOf(reply)]).toEqual([502, "supervisor_failed"])
  })

  it("relays the doctor report and the model list", async () => {
    const { client } = fake()
    expect(
      await adminRoute(client, "/admin/doctor", "", REQUEST, json({}))
    ).toEqual({ status: 200, body: DOCTOR })
    expect(
      await adminRoute(client, "/admin/models", "", REQUEST, json({}))
    ).toEqual({ status: 200, body: MODELS })
  })

  it("uses a model with 200 and fetches one with 202", async () => {
    const { client, calls } = fake()
    expect(
      await adminRoute(
        client,
        "/admin/models/:id/use",
        "small",
        REQUEST,
        json({})
      )
    ).toEqual({ status: 200, body: MODELS })
    expect(
      await adminRoute(
        client,
        "/admin/models/:id/fetch",
        "large",
        REQUEST,
        json({})
      )
    ).toEqual({ status: 202, body: JOBS })
    expect(calls).toEqual([
      { method: "useModel", args: ["small"] },
      { method: "fetchModel", args: ["large"] },
    ])
  })

  it("refuses a model id that is not a profile id, without calling the supervisor", async () => {
    const { client, calls } = fake()
    const reply = await adminRoute(
      client,
      "/admin/models/:id/use",
      "../etc",
      REQUEST,
      json({})
    )
    expect([reply.status, codeOf(reply)]).toEqual([400, "invalid_request"])
    expect(calls).toEqual([])
  })

  it.each([
    ["/admin/stack/start", "start"],
    ["/admin/stack/stop", "stop"],
    ["/admin/stack/restart", "restart"],
  ] as const)("relays %s as %s with 202", async (path, method) => {
    const { client, calls } = fake()
    expect(
      await adminRoute(client, path, "", REQUEST, json({ names: ["llama"] }))
    ).toEqual({ status: 202, body: JOBS })
    expect(calls).toEqual([{ method, args: [["llama"]] }])
  })

  it.each([[{ names: ["gate"] }], [{ names: ["web"] }], [{}]])(
    "refuses the job body %j",
    async (body) => {
      const { client, calls } = fake()
      const reply = await adminRoute(
        client,
        "/admin/stack/stop",
        "",
        REQUEST,
        json(body)
      )
      expect([reply.status, codeOf(reply)]).toEqual([400, "invalid_request"])
      expect(calls).toEqual([])
    }
  )

  it("returns the body reader's refusal as it is", async () => {
    const { client } = fake()
    const refusal: Reply = { status: 415, body: { code: "unsupported" } }
    const reply = await adminRoute(
      client,
      "/admin/stack/start",
      "",
      REQUEST,
      () => Promise.resolve({ ok: false, reply: refusal })
    )
    expect(reply).toBe(refusal)
  })

  it("maps a busy supervisor on a job to 503 busy", async () => {
    const { client } = fake(new SupervisorRequestError(409, "busy", "x"))
    const reply = await adminRoute(
      client,
      "/admin/stack/restart",
      "",
      REQUEST,
      json({ names: ["core"] })
    )
    expect([reply.status, codeOf(reply)]).toEqual([503, "busy"])
  })
})
