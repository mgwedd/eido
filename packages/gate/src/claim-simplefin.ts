import type { DatabaseSync } from "node:sqlite"
import { selectVault } from "./connect"
import type { Vault, VaultKey } from "./internal/vault/vault"

export const SIMPLEFIN_CONNECTOR = "simplefin"
export const SIMPLEFIN_HOST = "bridge.simplefin.org"

export const SIMPLEFIN_VAULT_KEY: VaultKey = {
  connector: SIMPLEFIN_CONNECTOR,
  kind: "access_token",
  client: "read",
}

export type ClaimIo = {
  out: (line: string) => void
  err: (line: string) => void
}

export type ClaimDeps = {
  vault?: Vault
  fetch?: typeof fetch
  db?: DatabaseSync
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString("utf-8").trim()
}

/**
 * Reads a setup token from stdin, base64-decodes the claim URL, verifies that its host is
 * bridge.simplefin.org, exchanges it for an access URL via POST, and stores the access URL
 * securely in the gate vault.
 *
 * The access URL is NEVER printed, logged, returned, or exposed to stdout or stderr.
 */
export async function claimSimplefin(
  input: string | NodeJS.ReadableStream,
  env: Readonly<Record<string, string | undefined>>,
  io: ClaimIo,
  deps: ClaimDeps = {}
): Promise<number> {
  const token = typeof input === "string" ? input.trim() : await readStream(input)

  if (token === "") {
    io.err("No setup token was given. Paste the setup token from SimpleFIN Bridge.")
    return 1
  }

  let claimUrlString: string
  try {
    claimUrlString = Buffer.from(token, "base64").toString("utf-8").trim()
  } catch {
    io.err("The setup token is not valid base64.")
    return 1
  }

  let claimUrl: URL
  try {
    claimUrl = new URL(claimUrlString)
  } catch {
    io.err("The setup token does not decode to a valid URL.")
    return 1
  }

  if (claimUrl.hostname !== SIMPLEFIN_HOST) {
    io.err(
      `The claim URL host must be ${SIMPLEFIN_HOST}. Host "${claimUrl.hostname}" was refused.`
    )
    return 1
  }

  let response: Response
  try {
    response = await (deps.fetch ?? fetch)(claimUrlString, {
      method: "POST",
      headers: { "Content-Length": "0" },
    })
  } catch {
    io.err("Could not reach the SimpleFIN Bridge claim service.")
    return 1
  }

  if (!response.ok) {
    io.err(`The claim request was refused with status ${response.status}.`)
    return 1
  }

  const accessUrl = (await response.text()).trim()
  if (!accessUrl) {
    io.err("The claim request returned an empty access URL.")
    return 1
  }

  const vault = deps.vault ?? selectVault(env, io)
  if (!vault) return 2

  await vault.set(SIMPLEFIN_VAULT_KEY, accessUrl)

  if (deps.db) {
    deps.db
      .prepare(
        `UPDATE connectors SET enabled = 1, health = 'healthy', last_error = NULL,
           consecutive_failures = 0, next_attempt_at = NULL WHERE name = ?`
      )
      .run(SIMPLEFIN_CONNECTOR)
  }

  io.out("Stored SimpleFIN access credential in the gate vault.")
  return 0
}

if (import.meta.main) {
  process.exitCode = await claimSimplefin(process.stdin, process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
}
