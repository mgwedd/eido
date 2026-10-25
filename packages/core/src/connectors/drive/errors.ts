export class DriveError extends Error {
  constructor(
    readonly code:
      | "invalid_pdf"
      | "invalid_response"
      | "read_failed"
      | "unsupported_type"
      | "cursor_expired"
      | "gate_unavailable"
  ) {
    super(code)
    this.name = "DriveError"
  }
}
