import type { GatePasskeyList } from "@eido/schemas"
import { CONTROL_SOCKET_ENV } from "./enrol-code"
import { createPasskeyAdminClient } from "./internal/client"

// `pnpm --filter @eido/gate passkeys [revoke <fingerprint>]`: run on the Mac, as the gate user,
// to list the enrolled passkeys or revoke one (#419). It talks to the running gate over its
// control socket. Revoking signs that phone out; enrol a new phone with `enrol-code`.

type Output = { out: (line: string) => void; err: (line: string) => void }

const USAGE = "usage: passkeys [revoke <fingerprint>]"
// The short form Settings shows is 8 hex characters; a prefix at least that long is accepted.
const SHORT = 8
const PREFIX = /^[0-9a-f]{8,64}$/

type Passkey = GatePasskeyList["passkeys"][number]

function describe(passkey: Passkey): string {
  const state =
    passkey.revokedAt === null ? "active" : `revoked ${passkey.revokedAt}`
  return `${passkey.fingerprint.slice(0, SHORT)}  enrolled ${passkey.createdAt}  ${state}`
}

function print(list: GatePasskeyList, output: Output): void {
  if (list.passkeys.length === 0) {
    output.out("No passkeys are enrolled.")
    return
  }
  for (const passkey of list.passkeys) output.out(describe(passkey))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Lists passkeys, or revokes the one a fingerprint prefix names. Returns the exit status. */
export async function passkeys(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: Output
): Promise<number> {
  const revoking = args[0] === "revoke"
  const prefix = args[1]?.toLowerCase()
  const valid =
    args.length === 0 ||
    (revoking &&
      args.length === 2 &&
      prefix !== undefined &&
      PREFIX.test(prefix))
  if (!valid) {
    output.err(USAGE)
    output.err(`The fingerprint is at least ${SHORT} hex characters.`)
    return 2
  }
  const socketPath = env[CONTROL_SOCKET_ENV]
  if (socketPath === undefined || socketPath === "") {
    output.err(`${CONTROL_SOCKET_ENV} is not set`)
    return 2
  }
  const client = createPasskeyAdminClient({ socketPath })
  try {
    const list = await client.list()
    if (prefix === undefined) {
      print(list, output)
      return 0
    }
    const matches = list.passkeys.filter((p) =>
      p.fingerprint.startsWith(prefix)
    )
    const match = matches[0]
    if (match === undefined || matches.length > 1) {
      output.err(
        matches.length === 0
          ? `No passkey has a fingerprint starting ${prefix}.`
          : `${matches.length} passkeys start ${prefix}; give more of the fingerprint.`
      )
      return 1
    }
    const updated = await client.revoke(match.fingerprint)
    output.out(`Revoked ${prefix}. That phone is signed out.`)
    print(updated, output)
    return 0
  } catch (error) {
    output.err(`Could not reach the passkeys: ${message(error)}`)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await passkeys(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
}
