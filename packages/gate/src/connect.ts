import { execFile } from "node:child_process"
import { CONTROL_SOCKET_ENV } from "./enrol-code"
import { BRIDGE_PASSWORD_KEY } from "./internal/bridge/bridge"
import {
  PROTON_CALENDAR_CONNECTOR,
  PROTON_CONNECTOR,
} from "./internal/bridge/config"
import {
  createConnectClient,
  GateRequestError,
  GateUnavailableError,
} from "./internal/client"
import {
  authorizationUrl,
  exchangeCode,
  GMAIL_MODIFY_SCOPE,
  oauthState,
  pkcePair,
  startLoopback,
} from "./internal/connect/oauth"
import type { CallbackResult, ExchangeResult } from "./internal/connect/oauth"
import { promptHidden } from "./internal/connect/prompt"
import { GMAIL_CONNECTOR } from "./internal/gmail-writers"
import type { Vault, VaultKey } from "./internal/vault/vault"
import { createVault, vaultConfig } from "./main"

// `pnpm --filter @eido/gate connect <connector>`: run on the Mac, as the gate user, to connect
// or reconnect a connector (#98). Gmail signs in through Google in the browser (OAuth for native
// apps, RFC 8252: a one-shot loopback listener on 127.0.0.1, PKCE S256 and a state check); the
// Proton connectors take the Bridge password at a no-echo prompt. The credential goes to the
// gate vault and nowhere else: it is never printed, logged, passed in argv or env, or written to
// a file. Then the running gate checks the connector over its control socket, audits the
// connect with hashes only, and this prints the connector's health. The runbook is
// infra/connectors.md.

export const GMAIL_CLIENT_ID_ENV = "EIDO_GMAIL_CLIENT_ID"
const CONNECTORS = [
  GMAIL_CONNECTOR,
  PROTON_CONNECTOR,
  PROTON_CALENDAR_CONNECTOR,
] as const
type Connector = (typeof CONNECTORS)[number]
const USAGE = `usage: pnpm --filter @eido/gate connect <${CONNECTORS.join("|")}>`
/** How long the browser sign-in may take before the listener closes. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

const GMAIL_SECRET_KEY: VaultKey = {
  connector: GMAIL_CONNECTOR,
  kind: "api_key",
  client: "write",
}
const GMAIL_REFRESH_KEY: VaultKey = {
  connector: GMAIL_CONNECTOR,
  kind: "refresh_token",
  client: "write",
}
const GMAIL_ACCESS_KEY: VaultKey = {
  connector: GMAIL_CONNECTOR,
  kind: "access_token",
  client: "write",
}

export type ConnectIo = {
  out: (line: string) => void
  err: (line: string) => void
  /** Asks for a secret without echoing it; undefined when none was given. */
  prompt: (question: string) => Promise<string | undefined>
  openBrowser: (url: string) => void
}

export type ConnectDeps = {
  /** The vault to write; by default the one the environment selects, as the gate does. */
  vault?: Vault
  fetch?: typeof fetch
  signInTimeoutMs?: number
}

const isConnector = (name: string): name is Connector =>
  CONNECTORS.some((connector) => connector === name)

const CALLBACK_MESSAGES = {
  state_mismatch:
    "The sign-in answer did not match this request, so it was refused",
  authorization_denied: "Google did not grant access",
  invalid_callback: "The sign-in answer carried no authorization code",
  timeout: "No sign-in arrived in time",
} as const satisfies Record<
  Extract<CallbackResult, { ok: false }>["reason"],
  string
>

const EXCHANGE_MESSAGES = {
  token_endpoint_unreachable: "Google's token endpoint could not be reached",
  token_endpoint_refused: "Google refused the authorization code",
  no_refresh_token: "Google returned no refresh token",
  scope_not_granted:
    "The Gmail permission was not granted; tick it on the consent screen",
} as const satisfies Record<
  Extract<ExchangeResult, { ok: false }>["reason"],
  string
>

const withCode = (message: string, code: string | undefined) =>
  code === undefined ? `${message}.` : `${message} (${code}).`

type Step = { ok: true } | { ok: false; status: number }

async function connectGmail(
  env: Readonly<Record<string, string | undefined>>,
  vault: Vault,
  io: ConnectIo,
  deps: ConnectDeps
): Promise<Step> {
  const clientId = env[GMAIL_CLIENT_ID_ENV] ?? ""
  let secret = await vault.get(GMAIL_SECRET_KEY)
  const newSecret = secret === undefined
  if (secret === undefined) {
    secret = await io.prompt("Google OAuth client secret (not shown): ")
    if (secret === undefined || secret === "") {
      io.err("No client secret was given. Nothing was stored.")
      return { ok: false, status: 1 }
    }
  }
  const pkce = pkcePair()
  const state = oauthState()
  const loopback = await startLoopback({
    state,
    timeoutMs: deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS,
  })
  const url = authorizationUrl({
    clientId,
    redirectUri: loopback.redirectUri,
    scope: GMAIL_MODIFY_SCOPE,
    state,
    challenge: pkce.challenge,
  })
  io.out("Sign in to Google at this address (opening it in the browser):")
  io.out(url)
  io.openBrowser(url)
  const callback = await loopback.result
  if (!callback.ok) {
    io.err(
      `${withCode(CALLBACK_MESSAGES[callback.reason], callback.error)} Nothing was stored.`
    )
    return { ok: false, status: 1 }
  }
  const exchanged = await exchangeCode({
    fetch: deps.fetch ?? fetch,
    clientId,
    clientSecret: secret,
    code: callback.code,
    verifier: pkce.verifier,
    redirectUri: loopback.redirectUri,
    scope: GMAIL_MODIFY_SCOPE,
  })
  if (!exchanged.ok) {
    io.err(
      `${withCode(EXCHANGE_MESSAGES[exchanged.reason], exchanged.error)} Nothing was stored.`
    )
    return { ok: false, status: 1 }
  }
  await vault.set(GMAIL_REFRESH_KEY, exchanged.refreshToken)
  if (newSecret) await vault.set(GMAIL_SECRET_KEY, secret)
  // A cached access token belongs to the old grant; the gate's next call refreshes from the new one.
  await vault.delete(GMAIL_ACCESS_KEY)
  io.out("Stored the Gmail credential in the gate vault.")
  return { ok: true }
}

async function connectBridge(vault: Vault, io: ConnectIo): Promise<Step> {
  const password = await io.prompt(
    "Bridge password, from the Bridge app (not shown): "
  )
  if (password === undefined || password === "") {
    io.err("No password was given. Nothing was stored.")
    return { ok: false, status: 1 }
  }
  await vault.set(BRIDGE_PASSWORD_KEY, password)
  io.out("Stored the Bridge password in the gate vault.")
  return { ok: true }
}

function selectVault(
  env: Readonly<Record<string, string | undefined>>,
  io: ConnectIo
): Vault | undefined {
  try {
    const config = vaultConfig(env)
    if (config !== undefined) return createVault(config)
    io.err(
      "connect needs EIDO_GATE_KEYCHAIN_PATH, or EIDO_DEV_VAULT=1 with EIDO_GATE_VAULT_FILE, as the gate has"
    )
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
  }
  return undefined
}

/** Connects one connector. Returns the process exit status: 0 only when it ends healthy. */
export async function connect(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: ConnectIo,
  deps: ConnectDeps = {}
): Promise<number> {
  const [name, ...rest] = args
  if (name === undefined || rest.length > 0 || !isConnector(name)) {
    io.err(USAGE)
    return 2
  }
  const socketPath = env[CONTROL_SOCKET_ENV] ?? ""
  if (socketPath === "") {
    io.err(`${CONTROL_SOCKET_ENV} is not set`)
    return 2
  }
  if (name === GMAIL_CONNECTOR && (env[GMAIL_CLIENT_ID_ENV] ?? "") === "") {
    io.err(`${GMAIL_CLIENT_ID_ENV} is not set; use the gate's Gmail client id`)
    return 2
  }
  const vault = deps.vault ?? selectVault(env, io)
  if (vault === undefined) return 2
  const client = createConnectClient({ socketPath })
  // Check the gate before asking for any secret: the connector must be pinned, and the gate
  // must be running to check it afterwards.
  try {
    const health = await client.health()
    if (!health.connectors.some((connector) => connector.name === name)) {
      io.err(
        `${name} is not pinned in the gate. Pin its reviewed manifest first.`
      )
      return 1
    }
  } catch (error) {
    io.err(
      error instanceof GateUnavailableError
        ? `The gate is not reachable at ${socketPath}. Start it first.`
        : `The gate could not read connector health: ${error instanceof Error ? error.message : String(error)}`
    )
    return 1
  }
  const stored =
    name === GMAIL_CONNECTOR
      ? await connectGmail(env, vault, io, deps)
      : await connectBridge(vault, io)
  if (!stored.ok) return stored.status
  try {
    const checked = await client.connected(name)
    const row = checked.connectors.find((connector) => connector.name === name)
    if (row?.health === "healthy") {
      io.out(`${name}: healthy`)
      return 0
    }
    io.out(
      `${name}: ${row?.health ?? "unknown"}${row?.lastError === undefined ? "" : ` (${row.lastError})`}`
    )
    if (row?.lastError === "auth_failed")
      io.out("The credential was refused. Run connect again.")
    return 1
  } catch (error) {
    io.err(
      error instanceof GateRequestError
        ? `The credential is stored, but the gate could not check ${name}: ${error.message}`
        : `The credential is stored, but the gate did not answer the check of ${name}.`
    )
    return 1
  }
}

type Run = (file: string, args: readonly string[], done: () => void) => void

/**
 * Opens the URL in the Mac's default browser with `open`; elsewhere, or when it fails, the
 * printed URL is the way in. The URL carries the request's state and PKCE challenge, no secret.
 */
export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  run: Run = (file, args, done) => {
    execFile(file, args, done)
  }
): void {
  if (platform === "darwin") run("open", [url], () => undefined)
}

if (import.meta.main) {
  process.exitCode = await connect(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    prompt: (question) => promptHidden(process.stdin, process.stderr, question),
    openBrowser: openInBrowser,
  })
}
