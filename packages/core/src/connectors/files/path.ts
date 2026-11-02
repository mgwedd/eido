export class FileError extends Error {
  constructor(
    readonly code: "path_not_allowed" | "invalid_payload" | "proposal_refused"
  ) {
    super(code)
    this.name = "FileError"
  }
}

/** Portable proposal syntax only. The gate's native helper enforces actual confinement. */
export function checkRelativeFilePath(path: string): void {
  const parts = path.split("/")
  if (
    /[\\:\x00-\x1f\x7f]/.test(path) ||
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  )
    throw new FileError("path_not_allowed")
}
