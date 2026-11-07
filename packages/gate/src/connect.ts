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
import type {
  GateConnectorHealth,
  GateGoogleConnectFlow,
  GateGoogleConnectStarted,
} from "@eido/schemas"
import type { FlowFailure, GoogleTarget } from "./internal/google-connect"
import { promptHidden } from "./internal/connect/prompt"
import { claimSimpleFin } from "./internal/connect/simplefin-claim"
import type { ClaimResult } from "./internal/connect/simplefin-claim"
import { GMAIL_CONNECTOR } from "./internal/gmail-writers"
import type { Vault } from "./internal/vault/vault"
import {
  createVault,
  DRIVE_CONNECTOR,
  SIMPLEFIN_CONNECTOR,
  vaultConfig,
} from "./main"

// `pnpm --filter @eido/gate connect <connector>`: run on the Mac, as the gate user, to connect
// or reconnect a connector (#98). Gmail's compose client, Gmail's read client (`gmail-read`,
// #529) and Drive's read client (#516) sign in through Google in the browser: the running gate
// starts the flow over its control socket and holds the PKCE verifier, and Google redirects to
// the gate's own callback on the tailnet name (#662), the same flow the Admin page uses. The
// command prompts for the client secret only when the gate's vault has none, opens the consent
// page and waits for the gate's outcome. The Proton connectors take the Bridge password at a
// no-echo prompt. SimpleFIN (#51) takes a setup token at a no-echo prompt and claims the access
// URL from bridge.simplefin.org. The credential goes to the gate vault and nowhere else: it is
// never printed, logged, passed in argv or env, or written to a file. Then the gate checks the
// connector, audits the connect with hashes only, and this prints the connector's health. The
// runbook is infra/connectors.md.

/** The command's name for Gmail's read client; the gate checks it as the `gmail` connector. */
const GMAIL_READ_TARGET = "gmail-read"
const TARGETS = [
  GMAIL_CONNECTOR,
  GMAIL_READ_TARGET,
  DRIVE_CONNECTOR,
  PROTON_CONNECTOR,
  PROTON_CALENDAR_CONNECTOR,
  SIMPLEFIN_CONNECTOR,
] as const
type Target = (typeof TARGETS)[number]
const USAGE = `usage: pnpm --filter @eido/gate connect <${TARGETS.join("|")}>`
/** How long the browser sign-in may take before the command stops waiting. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/** One Google OAuth client the command signs in, as the gate names it. */
type GoogleClient = {
  target: GoogleTarget
  connector: string
  /** The product named in messages: "Gmail", "Drive". */
  label: string
  /** What the stored grant is called in the confirmation line. */
  credential: string
}

const GOOGLE_CLIENTS = {
  [GMAIL_CONNECTOR]: {
    target: "gmail",
    connector: GMAIL_CONNECTOR,
    label: "Gmail",
    credential: "Gmail credential",
  },
  [GMAIL_READ_TARGET]: {
    target: "gmail-read",
    connector: GMAIL_CONNECTOR,
    label: "Gmail",
    credential: "Gmail read credential",
  },
  [DRIVE_CONNECTOR]: {
    target: "drive",
    connector: DRIVE_CONNECTOR,
    label: "Drive",
    credential: "Drive credential",
  },
} as const satisfies Record<string, GoogleClient>

const googleClient = (name: Target): GoogleClient | undefined =>
  name === GMAIL_CONNECTOR ||
  name === GMAIL_READ_TARGET ||
  name === DRIVE_CONNECTOR
    ? GOOGLE_CLIENTS[name]
    : undefined

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
  /** How often the command asks the gate whether the sign-in finished; default 1 s. */
  pollMs?: number
}

const isTarget = (name: string): name is Target =>
  TARGETS.some((target) => target === name)

const failureMessage = (reason: FlowFailure, label: string): string =>
  ({
    denied: "Google did not grant access",
    invalid_callback: "The sign-in answer carried no authorization code",
    token_endpoint_unreachable: "Google's token endpoint could not be reached",
    token_endpoint_refused: "Google refused the authorization code",
    no_refresh_token: "Google returned no refresh token",
    scope_not_granted: `The ${label} permission was not granted; tick it on the consent screen`,
  })[reason]

type Step =
  { ok: true; health?: GateConnectorHealth } | { ok: false; status: number }

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

type ConnectClient = ReturnType<typeof createConnectClient>

/** Asks the gate to start the sign-in, giving the client secret only when the gate has none. */
async function startGoogle(
  google: GoogleClient,
  client: ConnectClient,
  io: ConnectIo
): Promise<GateGoogleConnectStarted | undefined> {
  try {
    return await client.googleStart({ target: google.target })
  } catch (error) {
    if (
      !(error instanceof GateRequestError) ||
      error.code !== "client_secret_required"
    )
      throw error
  }
  const clientSecret = await io.prompt(
    "Google OAuth client secret (not shown): "
  )
  if (clientSecret === undefined || clientSecret === "") {
    io.err("No client secret was given. Nothing was stored.")
    return undefined
  }
  return client.googleStart({ target: google.target, clientSecret })
}

/**
 * Google sign-in through the gate (#662): the gate holds the PKCE verifier and receives Google's
 * redirect on its own callback, so this only opens the consent page and waits for the outcome.
 */
async function connectGoogle(
  google: GoogleClient,
  client: ConnectClient,
  io: ConnectIo,
  deps: ConnectDeps
): Promise<Step> {
  let started: GateGoogleConnectStarted | undefined
  try {
    started = await startGoogle(google, client, io)
  } catch (error) {
    io.err(
      `The gate could not start the ${google.label} sign-in: ${error instanceof Error ? error.message : String(error)}`
    )
    return { ok: false, status: 1 }
  }
  if (started === undefined) return { ok: false, status: 1 }
  io.out("Sign in to Google at this address (opening it in the browser):")
  io.out(started.authorizationUrl)
  io.openBrowser(started.authorizationUrl)
  const deadline = Date.now() + (deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS)
  for (;;) {
    let outcome: GateGoogleConnectFlow
    try {
      outcome = await client.googleFlow(started.flow)
    } catch (error) {
      io.err(
        error instanceof GateRequestError && error.status === 404
          ? "The sign-in expired before it finished. Nothing was stored."
          : `The gate did not answer about the sign-in: ${error instanceof Error ? error.message : String(error)}`
      )
      return { ok: false, status: 1 }
    }
    if (outcome.status === "connected") {
      io.out(`Stored the ${google.credential} in the gate vault.`)
      return {
        ok: true,
        ...(outcome.health === undefined ? {} : { health: outcome.health }),
      }
    }
    if (outcome.status === "failed") {
      io.err(
        `${failureMessage(outcome.reason ?? "token_endpoint_refused", google.label)}. Nothing was stored.`
      )
      return { ok: false, status: 1 }
    }
    if (Date.now() >= deadline) {
      io.err("No sign-in arrived in time. Nothing was stored.")
      return { ok: false, status: 1 }
    }
    await wait(deps.pollMs ?? 1000)
  }
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

const CLAIM_MESSAGES = {
  invalid_token: "That is not a SimpleFIN setup token",
  host_refused:
    "The setup token points somewhere other than bridge.simplefin.org, so it was refused",
  claim_unreachable: "SimpleFIN Bridge could not be reached",
  claim_refused:
    "SimpleFIN Bridge refused the setup token; it may have been claimed already",
  invalid_access_url: "SimpleFIN Bridge did not answer with an access URL",
} as const satisfies Record<
  Extract<ClaimResult, { ok: false }>["reason"],
  string
>

async function connectSimpleFin(
  vault: Vault,
  io: ConnectIo,
  deps: ConnectDeps
): Promise<Step> {
  const token = await io.prompt("SimpleFIN setup token (not shown): ")
  if (token === undefined || token.trim() === "") {
    io.err("No setup token was given. Nothing was stored.")
    return { ok: false, status: 1 }
  }
  const claimed = await claimSimpleFin(token, deps.fetch ?? fetch)
  if (!claimed.ok) {
    io.err(`${CLAIM_MESSAGES[claimed.reason]}. Nothing was stored.`)
    return { ok: false, status: 1 }
  }
  await vault.set(
    { connector: SIMPLEFIN_CONNECTOR, kind: "api_key", client: "read" },
    claimed.accessUrl
  )
  io.out("Stored the SimpleFIN access credential in the gate vault.")
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
  const [target, ...rest] = args
  if (target === undefined || rest.length > 0 || !isTarget(target)) {
    io.err(USAGE)
    return 2
  }
  const socketPath = env[CONTROL_SOCKET_ENV] ?? ""
  if (socketPath === "") {
    io.err(`${CONTROL_SOCKET_ENV} is not set`)
    return 2
  }
  const google = googleClient(target)
  // The connector the gate pins and checks: both Gmail clients are the `gmail` connector.
  const name = google?.connector ?? target
  // Google credentials go to the vault through the gate; the others are sealed here.
  const vault =
    google === undefined ? (deps.vault ?? selectVault(env, io)) : undefined
  if (google === undefined && vault === undefined) return 2
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
    google !== undefined
      ? await connectGoogle(google, client, io, deps)
      : vault === undefined
        ? { ok: false as const, status: 2 }
        : target === SIMPLEFIN_CONNECTOR
          ? await connectSimpleFin(vault, io, deps)
          : await connectBridge(vault, io)
  if (!stored.ok) return stored.status
  try {
    // The gate checks a Google connector itself once the grant is stored.
    const checked = stored.health ?? (await client.connected(name))
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
