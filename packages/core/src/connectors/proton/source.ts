import { toProtonError } from "./errors"

/**
 * Where mail comes from. Core owns this type and codes against it; the gate client (#195), the only
 * process holding the Bridge password, satisfies it. Core never opens a socket to Bridge.
 */
export type ProtonMailSource = {
  listFolders(): Promise<string[]>
  folderState(folder: string): Promise<{ uidValidity: string; uidNext: number }>
  /** Raw messages and UIDs skipped for size, from `fromUid` in ascending UID order. */
  fetchRaw(
    folder: string,
    fromUid: number,
    limit: number
  ): Promise<{
    messages: { uid: number; raw: Uint8Array }[]
    skipped: number[]
  }>
}

/** Runs one source call and surfaces its failures as typed connector errors. */
export async function callSource<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw toProtonError(error)
  }
}
