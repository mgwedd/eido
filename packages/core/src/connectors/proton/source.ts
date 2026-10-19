import { toProtonError } from "./errors"

/**
 * Where mail comes from. Core owns this type and codes against it; the gate client (#195), the only
 * process holding the Bridge password, satisfies it. Core never opens a socket to Bridge.
 */
export type ProtonMailSource = {
  listFolders(): Promise<string[]>
  folderState(folder: string): Promise<{ uidValidity: string; uidNext: number }>
  /** Raw RFC 5322 bytes per message, UID ascending, at most `limit` messages from `fromUid`. */
  fetchRaw(
    folder: string,
    fromUid: number,
    limit: number
  ): Promise<{ uid: number; raw: Uint8Array }[]>
}

/** Runs one source call and surfaces its failures as typed connector errors. */
export async function callSource<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw toProtonError(error)
  }
}
