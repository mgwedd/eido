export const SIMPLEFIN_CONNECTOR = "simplefin"
export const SIMPLEFIN_HOST = "bridge.simplefin.org"
export const SIMPLEFIN_SOURCE = "simplefin"

export const DEFAULT_DAILY_REQUEST_LIMIT = 24
export const DEFAULT_MAX_DATE_RANGE_DAYS = 90
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export interface SimpleFinConfig {
  bridgeHost: string
  dailyRequestLimit: number
  maxDateRangeDays: number
  requestTimeoutMs: number
  entityConfigFile?: string
  accountEntityAssignments?: Record<string, string>
}

export function resolveSimpleFinConfig(
  input: Partial<SimpleFinConfig> = {}
): SimpleFinConfig {
  const dailyRequestLimit =
    input.dailyRequestLimit ?? DEFAULT_DAILY_REQUEST_LIMIT
  const maxDateRangeDays = input.maxDateRangeDays ?? DEFAULT_MAX_DATE_RANGE_DAYS
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  if (!Number.isSafeInteger(dailyRequestLimit) || dailyRequestLimit < 1) {
    throw new RangeError("dailyRequestLimit must be a positive integer")
  }
  if (!Number.isSafeInteger(maxDateRangeDays) || maxDateRangeDays < 1) {
    throw new RangeError("maxDateRangeDays must be a positive integer")
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new RangeError("requestTimeoutMs must be a positive integer")
  }

  return {
    bridgeHost: input.bridgeHost ?? SIMPLEFIN_HOST,
    dailyRequestLimit,
    maxDateRangeDays,
    requestTimeoutMs,
    ...(input.entityConfigFile !== undefined
      ? { entityConfigFile: input.entityConfigFile }
      : {}),
    ...(input.accountEntityAssignments !== undefined
      ? { accountEntityAssignments: { ...input.accountEntityAssignments } }
      : {}),
  }
}
