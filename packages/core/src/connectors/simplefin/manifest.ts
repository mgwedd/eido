import type { ConnectorManifest, ConnectorOperation } from "@eido/schemas"
import {
  DEFAULT_DAILY_REQUEST_LIMIT,
  SIMPLEFIN_CONNECTOR,
  SIMPLEFIN_HOST,
  SIMPLEFIN_SOURCE,
  type SimpleFinConfig,
} from "./config"

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

export function simplefinManifest(
  config?: Partial<SimpleFinConfig>
): ConnectorManifest {
  const dailyLimit = config?.dailyRequestLimit ?? DEFAULT_DAILY_REQUEST_LIMIT

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
        intervalSeconds: 86400,
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
      rateLimit: {
        requestsPerWindow: dailyLimit,
        windowSeconds: 86400,
      },
    },
  }
}
