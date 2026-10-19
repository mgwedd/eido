import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { fileLog } from "./log"

it("appends one JSON line per event to a file only its owner can read", () => {
  const dir = mkdtempSync(join(tmpdir(), "eido-log-"))
  try {
    const path = join(dir, "gate.log")
    const log = fileLog(path, () => new Date("2030-01-02T09:00:00.000Z"))
    log("started", { socket: "/s" })
    log("stopped")
    expect(readFileSync(path, "utf8")).toBe(
      '{"at":"2030-01-02T09:00:00.000Z","event":"started","socket":"/s"}\n' +
        '{"at":"2030-01-02T09:00:00.000Z","event":"stopped"}\n'
    )
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
