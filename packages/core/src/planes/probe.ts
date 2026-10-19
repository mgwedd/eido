import { GateRequestError, GateUnavailableError } from "@eido/gate"
import type { IntentClient } from "@eido/gate"
import { validateGateIntentProposal } from "@eido/schemas"
import { dataPlaneConfig, runDataPlane } from "../main"

// Test support for the two-process tests: a short-lived data-plane process. It starts the same
// runtime as main.ts (eido-data.db and the intent client, from the same allowlisted
// environment), runs one command against the gate through the client, prints the result as one
// JSON line and exits. spawnPlanes runs it by path; the data plane gets an API of its own in
// #153, and then the tests can drive that instead.

export type Settled =
  | { ok: true; value: unknown; ms: number }
  | {
      ok: false
      error: { name: string; status?: number; code?: string; errors?: string[] }
      ms: number
    }

function describeError(
  error: unknown
): Extract<Settled, { ok: false }>["error"] {
  if (error instanceof GateRequestError) {
    return {
      name: error.name,
      status: error.status,
      code: error.code,
      errors: [...error.errors],
    }
  }
  if (error instanceof GateUnavailableError) return { name: error.name }
  return { name: error instanceof Error ? error.name : "unknown" }
}

async function settle(call: () => Promise<unknown>): Promise<Settled> {
  const started = performance.now()
  try {
    const value = await call()
    return { ok: true, value, ms: performance.now() - started }
  } catch (error) {
    return {
      ok: false,
      error: describeError(error),
      ms: performance.now() - started,
    }
  }
}

function parseProposal(text: string) {
  const parsed: unknown = JSON.parse(text)
  const checked = validateGateIntentProposal(parsed)
  if (!checked.ok) {
    throw new Error(`not an intent proposal: ${checked.errors.join("; ")}`)
  }
  return checked.value
}

/**
 * `env`, `propose <proposal json>`, `status <id>`, `history <id>`, `pending`, or `offline <id>`
 * (all four calls, for a stopped gate).
 */
export async function runProbe(
  gate: IntentClient,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): Promise<unknown> {
  const [command, arg = ""] = args
  switch (command) {
    case "env":
      return { env: Object.keys(env).sort(), config: dataPlaneConfig(env) }
    case "propose": {
      const proposal = parseProposal(arg)
      return settle(() => gate.propose(proposal))
    }
    case "status":
      return settle(() => gate.status(arg))
    case "history":
      return settle(() => gate.history(arg))
    case "pending":
      return settle(() => gate.listPending())
    case "offline":
      return {
        propose: await settle(() =>
          gate.propose({ intent: { kind: "email.draft" }, origin: "reactive" })
        ),
        status: await settle(() => gate.status(arg)),
        history: await settle(() => gate.history(arg)),
        listPending: await settle(() => gate.listPending()),
      }
    default:
      throw new Error(`unknown probe command ${String(command)}`)
  }
}

if (import.meta.main) {
  const plane = runDataPlane(dataPlaneConfig(process.env), process.env)
  try {
    const result = await runProbe(
      plane.gate,
      process.argv.slice(2),
      process.env
    )
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    plane.close()
  }
}
