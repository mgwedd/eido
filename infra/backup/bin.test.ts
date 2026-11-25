import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

import { tempDir } from "./test-support.ts"

// The LaunchAgent, the plane's LaunchDaemon and `pnpm backup` all start the entry point with plain
// node, which resolves no workspace package. Vitest does resolve them, so only a real node
// process shows that infra/backup does not import one (the #782 review found it did, through
// infra/host/plane.ts and @eido/schemas).
describe.skipIf(process.platform === "win32")(
  "backup entry point under plain node",
  () => {
    test("`plane` runs and prints the script", () => {
      const result = spawnSync(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          join(import.meta.dirname, "bin.ts"),
          "plane",
        ],
        {
          encoding: "utf8",
          cwd: join(import.meta.dirname, "..", ".."),
          env: {
            EIDO_BACKUP_REPO: join(tempDir(), "restic"),
          },
        }
      )
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("com.eido.plane.backup")
    })
  }
)
