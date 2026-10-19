// Non-secret connector settings. Host, ports and TLS belong to the gate side (#195), which also
// holds the Bridge password; core has no field for either.

export type ProtonConfig = {
  /** The Bridge account, which is also the sending identity (the assistant address). */
  username: string
  /** Folders mirrored into the local index. */
  folders: readonly string[]
  /** Most messages fetched from the source in one batch. */
  batchSize: number
}

export const DEFAULTS = {
  folders: ["INBOX"],
  batchSize: 50,
} as const satisfies Partial<ProtonConfig>

export function resolveConfig(
  input: Partial<ProtonConfig> & Pick<ProtonConfig, "username">
): ProtonConfig {
  const config: ProtonConfig = {
    folders: [...DEFAULTS.folders],
    batchSize: DEFAULTS.batchSize,
    ...input,
  }
  if (config.batchSize < 1 || !Number.isInteger(config.batchSize))
    throw new RangeError("batchSize must be a positive integer")
  if (!config.username.includes("@"))
    throw new RangeError("username must be an address")
  if (config.folders.length === 0)
    throw new RangeError("folders must name at least one folder")
  return config
}
