/** A failure the job reports as one log line; anything else is a bug and is printed in full. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BackupError"
  }
}
