import { join } from "node:path"
import { loopbackBaseUrl } from "../../inference/client"

export const SIMPLEFIN_CONNECTOR = "simplefin"
export const SIMPLEFIN_HOST = "bridge.simplefin.org"
export const SIMPLEFIN_SOURCE = "simplefin"

// Defaults from the SimpleFIN limits recorded on #51: Bridge allows 24 requests a day per access
// token and a 90-day range per request. Both are configuration; these are the starting values.
export const DEFAULT_DAILY_REQUEST_LIMIT = 24
export const DEFAULT_MAX_DATE_RANGE_DAYS = 90
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Four syncs a day: well inside the daily budget, which also covers retries and probes. */
export const SIMPLEFIN_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
/**
 * How often the data plane checks whether a sync is due. A run younger than the sync interval is
 * skipped without a request, so this only bounds how late a due sync or a retry starts.
 */
export const SIMPLEFIN_TICK_INTERVAL_MS = 15 * 60 * 1000

export interface SimpleFinConfig {
  dailyRequestLimit: number
  maxDateRangeDays: number
  requestTimeoutMs: number
}

function positive(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer from 1 to ${String(max)}`)
  }
  return value
}

/** The SimpleFIN limits with defaults filled in. Out-of-range values are refused. */
export function resolveSimpleFinConfig(
  input: Partial<SimpleFinConfig> = {}
): SimpleFinConfig {
  return {
    // The manifest schema caps requestsPerDay at 100000.
    dailyRequestLimit: positive(
      input.dailyRequestLimit ?? DEFAULT_DAILY_REQUEST_LIMIT,
      "dailyRequestLimit",
      100_000
    ),
    maxDateRangeDays: positive(
      input.maxDateRangeDays ?? DEFAULT_MAX_DATE_RANGE_DAYS,
      "maxDateRangeDays",
      3650
    ),
    requestTimeoutMs: positive(
      input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
      600_000
    ),
  }
}

/** Where the owner's account-to-entity file lives when `EIDO_SIMPLEFIN_ACCOUNTS_FILE` is unset. */
export const SIMPLEFIN_ACCOUNTS_FILE = "simplefin-accounts.json"

export interface SimpleFinPlaneConfig {
  /** The gate's loopback egress proxy, which holds the access URL. */
  proxyUrl: string
  accountsFile: string
  config: Partial<SimpleFinConfig>
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * The data plane's SimpleFIN settings, or undefined when `EIDO_SIMPLEFIN_PROXY_URL` is unset and
 * SimpleFIN sync is off. None of these is a credential: the access URL stays in the gate.
 */
export function simplefinPlaneConfig(
  env: Env,
  dataDir: string
): SimpleFinPlaneConfig | undefined {
  const proxy = env["EIDO_SIMPLEFIN_PROXY_URL"] ?? ""
  if (proxy === "") return undefined
  let proxyUrl: string
  try {
    proxyUrl = loopbackBaseUrl(proxy)
  } catch {
    throw new Error("EIDO_SIMPLEFIN_PROXY_URL must be a loopback HTTP URL")
  }
  const range = env["EIDO_SIMPLEFIN_MAX_RANGE_DAYS"] ?? ""
  const config: Partial<SimpleFinConfig> =
    range === ""
      ? {}
      : { maxDateRangeDays: /^\d+$/.test(range) ? Number(range) : Number.NaN }
  try {
    resolveSimpleFinConfig(config)
  } catch {
    throw new Error(
      "EIDO_SIMPLEFIN_MAX_RANGE_DAYS must be an integer from 1 to 3650"
    )
  }
  return {
    proxyUrl,
    accountsFile:
      env["EIDO_SIMPLEFIN_ACCOUNTS_FILE"] ||
      join(dataDir, SIMPLEFIN_ACCOUNTS_FILE),
    config,
  }
}

/** The daily request budget the manifest declares (`EIDO_SIMPLEFIN_REQUESTS_PER_DAY`). */
export function simplefinManifestConfig(
  env: Env
): Partial<SimpleFinConfig> | string {
  const value = env["EIDO_SIMPLEFIN_REQUESTS_PER_DAY"] ?? ""
  if (value === "") return {}
  const limit = /^\d+$/.test(value) ? Number(value) : Number.NaN
  try {
    resolveSimpleFinConfig({ dailyRequestLimit: limit })
  } catch {
    return "EIDO_SIMPLEFIN_REQUESTS_PER_DAY must be an integer from 1 to 100000"
  }
  return { dailyRequestLimit: limit }
}
