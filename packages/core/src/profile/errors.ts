export type ProfileErrorCode =
  | "invalid"
  | "duplicate_name"
  | "duplicate_tag"
  | "not_found"
  | "entity_in_use"
  | "busy"

/** Typed failure of a profile store call. Messages never contain stored values. */
export class ProfileError extends Error {
  readonly code: ProfileErrorCode
  /** What blocked the write: validation issues, or the referencing tables for `entity_in_use`. */
  readonly details: readonly string[]

  constructor(
    code: ProfileErrorCode,
    message: string,
    details: readonly string[] = []
  ) {
    super(message)
    this.name = "ProfileError"
    this.code = code
    this.details = details
  }
}
