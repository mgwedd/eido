// Non-secret Gmail connector settings. OAuth clients and tokens live in the gate; core has no field
// for either.

export type GmailConfig = {
  /** Gmail label ids mirrored into the local index. Each one is a sync stream with its own cursor. */
  labels: readonly string[]
  /** Most messages fetched in one committed batch. */
  batchSize: number
  /** Most messages read by an initial sync, or by the resync after an expired history id. */
  fullSyncLimit: number
}

export const GMAIL_DEFAULTS = {
  labels: ["INBOX"],
  batchSize: 50,
  fullSyncLimit: 500,
} as const satisfies GmailConfig

const positiveInteger = (value: number): boolean =>
  Number.isInteger(value) && value >= 1

export function resolveGmailConfig(
  input: Partial<GmailConfig> = {}
): GmailConfig {
  const config: GmailConfig = {
    labels: [...GMAIL_DEFAULTS.labels],
    batchSize: GMAIL_DEFAULTS.batchSize,
    fullSyncLimit: GMAIL_DEFAULTS.fullSyncLimit,
    ...input,
  }
  // Gmail's list and history endpoints return at most 500 entries per page.
  if (!positiveInteger(config.batchSize) || config.batchSize > 500)
    throw new RangeError("batchSize must be an integer from 1 to 500")
  if (!positiveInteger(config.fullSyncLimit))
    throw new RangeError("fullSyncLimit must be a positive integer")
  if (config.labels.length === 0)
    throw new RangeError("labels must name at least one label")
  return config
}
