import type { ConnectorManifest, ConnectorOperation } from "@eido/schemas"
import {
  resolveSimpleFinConfig,
  SIMPLEFIN_CONNECTOR,
  SIMPLEFIN_HOST,
  SIMPLEFIN_SOURCE,
  SIMPLEFIN_SYNC_INTERVAL_MS,
} from "./config"
import type { SimpleFinConfig } from "./config"

export const SIMPLEFIN_PATH_PREFIX = "/simplefin"
export const SIMPLEFIN_ACCOUNTS_PATH = "/simplefin/accounts"

type Route = NonNullable<ConnectorOperation["routes"]>[number]

const get = (pathPattern: string): Route => ({
  host: SIMPLEFIN_HOST,
  method: "GET",
  pathPattern,
})

const read = (name: string, routes: Route[]): ConnectorOperation => ({
  name,
  effect: "read",
  reversibility: "reversible",
  defaultTier: "auto",
  sensitivity: "high",
  untrustedOutput: true,
  authScopes: [],
  routes,
})

export const OPERATIONS: readonly ConnectorOperation[] = [
  read("listAccounts", [get(SIMPLEFIN_ACCOUNTS_PATH)]),
  read("listTransactions", [get(SIMPLEFIN_ACCOUNTS_PATH)]),
]

/** The SimpleFIN manifest: reads only, no write, transfer or payment operation exists. */
export function simplefinManifest(
  config?: Partial<SimpleFinConfig>
): ConnectorManifest {
  const { dailyRequestLimit } = resolveSimpleFinConfig(config)

  return {
    name: SIMPLEFIN_CONNECTOR,
    version: 1,
    description:
      "SimpleFIN Bridge bank connector (read-only): accounts and transaction history.",
    auth: {
      type: "basic-url",
      scopes: [],
    },
    egress: {
      hosts: [
        {
          host: SIMPLEFIN_HOST,
          methods: ["GET"],
          pathPrefixes: [SIMPLEFIN_PATH_PREFIX],
        },
      ],
    },
    operations: [...OPERATIONS],
    triggers: [
      {
        kind: "poll",
        stream: "transactions",
        intervalSeconds: SIMPLEFIN_SYNC_INTERVAL_MS / 1000,
      },
    ],
    ledgerMapping: {
      source: SIMPLEFIN_SOURCE,
      refField: "id",
    },
    health: {
      backoff: {
        baseMs: 1000,
        maxMs: 300_000,
        jitter: true,
      },
      breaker: {
        failureThreshold: 3,
        halfOpenProbeAfterMs: 60_000,
      },
      rateLimit: { requestsPerDay: dailyRequestLimit },
    },
  }
}
