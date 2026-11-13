import { createInterface } from "node:readline/promises"
import { isAbsolute, join } from "node:path"
import { openControlDb } from "./internal/control-db"
import {
  establishControlEpoch,
  inspectControlCheckpoint,
} from "./internal/control-checkpoint"
import type { ControlStore } from "./internal/control-checkpoint"
import { KeychainControlStore } from "./internal/vault/keychain-checkpoint"
import { CONTROL_DB_FILE, CONTROL_LOCK_FILE } from "./main"

// `pnpm --filter @eido/gate control-checkpoint status|recover`: run on the Mac, as the gate user,
// with the gate stopped (ADR 0005, #200). `status` reports whether the control database matches
// the protected checkpoint. `recover` is the only way past a denied checkpoint, an upgrade from
// before it existed, or a lost one: it starts a new epoch from the database as it stands, revokes
// every enrolled passkey and disables every connector, so nothing signed under the old state is
// trusted again. The owner must be at the terminal to type the confirmation; the command refuses
// without one.

export const CONFIRMATION = "RESET CONTROL STATE"

type Output = { out: (line: string) => void; err: (line: string) => void }

export type CheckpointCli = {
  /** Asks the person at the terminal; false without one. */
  confirm: () => Promise<boolean>
  store?: ControlStore
}

/** Runs one command and returns the process exit status. */
export async function controlCheckpointCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: Output,
  cli: CheckpointCli
): Promise<number> {
  const command = args[0]
  if (command !== "status" && command !== "recover") {
    output.err("usage: control-checkpoint status | recover")
    return 2
  }
  const dataDir = env["EIDO_GATE_DATA_DIR"] ?? ""
  const keychainPath = env["EIDO_GATE_KEYCHAIN_PATH"] ?? ""
  if (dataDir === "" || !isAbsolute(dataDir)) {
    output.err("EIDO_GATE_DATA_DIR must be set to an absolute path")
    return 2
  }
  if (
    cli.store === undefined &&
    (keychainPath === "" || !isAbsolute(keychainPath))
  ) {
    output.err("EIDO_GATE_KEYCHAIN_PATH must be set to an absolute path")
    return 2
  }
  const store = cli.store ?? new KeychainControlStore({ path: keychainPath })
  const db = openControlDb(join(dataDir, CONTROL_DB_FILE))
  try {
    if (command === "status") {
      const report = inspectControlCheckpoint(db, store)
      output.out(`Control checkpoint: ${report.state}`)
      if (report.reason !== undefined) output.out(`Reason: ${report.reason}`)
      if (report.installationId !== undefined)
        output.out(
          `Installation ${report.installationId}, epoch ${report.epoch ?? ""}, generation ${String(report.generation ?? "")}, ${String(report.signedChanges ?? 0)} signed changes kept`
        )
      return report.state === "ready" ? 0 : 1
    }
    output.out(
      "This starts a new control epoch. Every enrolled passkey is revoked, every connector is disabled, and no earlier pin or policy counts as signed. Enrol a passkey again with enrol-code, then sign each connector pin and policy change afresh."
    )
    if (!(await cli.confirm())) {
      output.err(
        `Not confirmed: type ${CONFIRMATION} at the terminal to continue`
      )
      return 1
    }
    const result = establishControlEpoch(db, {
      store,
      lockPath: join(dataDir, CONTROL_LOCK_FILE),
    })
    output.out(
      `New epoch ${result.epoch}, generation ${String(result.generation)}: ${String(result.revokedCredentials)} passkeys revoked, ${String(result.disabledConnectors)} connectors disabled.`
    )
    return 0
  } catch (error) {
    output.err(
      `Control checkpoint command failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return 1
  } finally {
    db.close()
  }
}

export type TerminalStreams = {
  input: NodeJS.ReadableStream & { isTTY?: boolean }
  output: NodeJS.WritableStream & { isTTY?: boolean }
}

/** The owner's typed confirmation; refused unless both streams are an interactive terminal. */
export async function confirmAtTerminal(
  streams: TerminalStreams = { input: process.stdin, output: process.stdout }
): Promise<boolean> {
  if (streams.input.isTTY !== true || streams.output.isTTY !== true)
    return false
  const rl = createInterface(streams)
  try {
    return (
      (await rl.question(`Type ${CONFIRMATION} to continue: `)) === CONFIRMATION
    )
  } finally {
    rl.close()
  }
}

if (import.meta.main) {
  process.exitCode = await controlCheckpointCli(
    process.argv.slice(2),
    process.env,
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
    { confirm: () => confirmAtTerminal() }
  )
}
