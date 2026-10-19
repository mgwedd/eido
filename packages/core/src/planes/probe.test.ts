import { GateRequestError, GateUnavailableError } from "@eido/gate"
import type { IntentClient } from "@eido/gate"
import { describe, expect, it } from "vitest"
import { runProbe } from "./probe"

// The probe's own logic, in process, against a stand-in client; planes.test.ts runs it as a
// data-plane process against a real gate.

const STATUS = {
  id: "i-1",
  kind: "email.send",
  tier: "approval",
  state: "pending",
  edited_from: null,
} as const

function client(overrides: Partial<IntentClient> = {}): IntentClient {
  const unavailable = () =>
    Promise.reject(new GateUnavailableError("the gate is not reachable"))
  return {
    propose: unavailable,
    status: unavailable,
    history: unavailable,
    listPending: unavailable,
    ...overrides,
  }
}

const ENV = { EIDO_DATA_DIR: "/d", EIDO_GATE_SOCKET: "/s/gate.sock" }

describe("runProbe", () => {
  it("reports the variable names and the config, never the values", async () => {
    expect(await runProbe(client(), ["env"], ENV)).toEqual({
      env: ["EIDO_DATA_DIR", "EIDO_GATE_SOCKET"],
      config: {
        dataDir: "/d",
        dbPath: "/d/eido-data.db",
        logPath: "/d/data-plane.log",
        gateSocket: "/s/gate.sock",
        api: {
          host: "127.0.0.1",
          port: 8787,
          basePath: "",
          allowedHosts: [],
        },
      },
    })
  })

  it("passes a parsed proposal to the client and settles its answer", async () => {
    const seen: unknown[] = []
    const result = await runProbe(
      client({
        propose: (proposal) => {
          seen.push(proposal)
          return Promise.resolve({
            id: "i-1",
            tier: "approval",
            state: "pending",
          })
        },
      }),
      [
        "propose",
        JSON.stringify({ intent: { kind: "email.draft" }, origin: "reactive" }),
      ],
      ENV
    )
    expect(seen).toEqual([
      { intent: { kind: "email.draft" }, origin: "reactive" },
    ])
    expect(result).toMatchObject({
      ok: true,
      value: { id: "i-1", tier: "approval", state: "pending" },
    })
  })

  it("refuses a body that is not an intent proposal before calling the gate", async () => {
    await expect(
      runProbe(client(), ["propose", JSON.stringify({ intent: {} })], ENV)
    ).rejects.toThrow("not an intent proposal")
  })

  it("describes a gate refusal by status, code and field errors", async () => {
    const result = await runProbe(
      client({
        status: () =>
          Promise.reject(
            new GateRequestError(422, "invalid_payload", "no", [
              "/args/to: required",
            ])
          ),
      }),
      ["status", "i-1"],
      ENV
    )
    expect(result).toMatchObject({
      ok: false,
      error: {
        name: "GateRequestError",
        status: 422,
        code: "invalid_payload",
        errors: ["/args/to: required"],
      },
    })
  })

  it("names an unexpected error without its message", async () => {
    const result = await runProbe(
      client({
        listPending: () => Promise.reject(new TypeError("secret detail")),
      }),
      ["pending"],
      ENV
    )
    expect(result).toMatchObject({ ok: false, error: { name: "TypeError" } })
    expect(JSON.stringify(result)).not.toContain("secret detail")
  })

  it("reads status and history through the client", async () => {
    const reads = client({
      status: (id) => Promise.resolve({ ...STATUS, id }),
      history: () =>
        Promise.resolve([
          {
            at: "2026-10-19T00:00:00Z",
            from: null,
            to: "proposed",
            actor: "data-plane",
          },
        ]),
    })
    expect(await runProbe(reads, ["status", "i-9"], ENV)).toMatchObject({
      ok: true,
      value: { id: "i-9" },
    })
    expect(await runProbe(reads, ["history", "i-9"], ENV)).toMatchObject({
      ok: true,
      value: [{ to: "proposed" }],
    })
  })

  it("tries all four calls for a stopped gate", async () => {
    const result = await runProbe(client(), ["offline", "i-1"], ENV)
    const unavailable = { ok: false, error: { name: "GateUnavailableError" } }
    expect(result).toMatchObject({
      propose: unavailable,
      status: unavailable,
      history: unavailable,
      listPending: unavailable,
    })
  })

  it("rejects an unknown command", async () => {
    await expect(runProbe(client(), ["delete"], ENV)).rejects.toThrow(
      "unknown probe command delete"
    )
  })
})
