import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

import { main, type Context } from "./cli.ts"
import type { ResticRun } from "./restic.ts"
import { materializeRestore, tempDir } from "./test-support.ts"
import { buildBackupConfig } from "./config.ts"

describe.skipIf(process.platform === "win32")("backup cli", () => {
  function context(
    env: Record<string, string>,
    run: ResticRun = () =>
      Promise.resolve({ code: 0, stdout: "[]", stderr: "" })
  ) {
    const out: string[] = []
    const err: string[] = []
    const logs: string[] = []
    const home = tempDir()
    const ctx: Context = {
      run,
      now: () => new Date("2026-03-10T00:00:00Z"),
      log: (l) => logs.push(l),
      env,
      home,
      repoRoot: "/repo",
      nodePath: "/node",
      binPath: "/repo/infra/backup/bin.ts",
      io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    }
    return { ctx, out, err, logs, home }
  }

  const repoEnv = () => ({
    EIDO_BACKUP_REPO: join(tempDir(), "drive", "restic"),
  })

  test("an unknown command prints usage and exits 2", async () => {
    const { ctx, err } = context(repoEnv())
    expect(await main(["frobnicate"], ctx)).toBe(2)
    expect(err[0]).toMatch(/^usage: backup run/)
  })

  test("run with the drive absent exits 1 and logs one clear line", async () => {
    const { ctx, logs } = context(repoEnv())
    expect(await main(["run"], ctx)).toBe(1)
    expect(logs.at(-1)).toMatch(
      /^ERROR run: no restic repository at .*drive.restic/
    )
  })

  test("check with the drive absent exits 1", async () => {
    const { ctx, logs } = context(repoEnv())
    expect(await main(["check"], ctx)).toBe(1)
    expect(logs.at(-1)).toMatch(/^ERROR check: no restic repository/)
  })

  test("check exits 0 and says how old the newest snapshot is", async () => {
    const env = repoEnv()
    mkdirSync(env.EIDO_BACKUP_REPO, { recursive: true })
    writeFileSync(join(env.EIDO_BACKUP_REPO, "config"), "")
    const run: ResticRun = () =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify([{ id: "s1", time: "2026-03-09T12:00:00Z" }]),
      })
    const { ctx, out } = context(env, run)
    expect(await main(["check"], ctx)).toBe(0)
    expect(out).toEqual(["ok: newest snapshot s1 is 12 hours old"])
  })

  test("a missing repository setting exits 1 with the reason", async () => {
    const { ctx, logs } = context({})
    expect(await main(["run"], ctx)).toBe(1)
    expect(logs[0]).toMatch(/EIDO_BACKUP_REPO must name/)
  })

  test("an unexpected failure is also written to stderr", async () => {
    const run: ResticRun = () => {
      throw new Error("spawn exploded")
    }
    const env = repoEnv()
    mkdirSync(env.EIDO_BACKUP_REPO, { recursive: true })
    writeFileSync(join(env.EIDO_BACKUP_REPO, "config"), "")
    const { ctx, err } = context(env, run)
    expect(await main(["check"], ctx)).toBe(1)
    expect(err[0]).toBe("Error: spawn exploded")
  })

  test("verify exits 0 on a sound tree and 1 on a damaged one, printing PASS and FAIL lines", async () => {
    const { ctx, out, home } = context(repoEnv())
    const config = buildBackupConfig({ env: ctx.env, home, repoRoot: "/repo" })
    const root = tempDir()
    materializeRestore(config, root)
    expect(await main(["verify", root], ctx)).toBe(0)
    expect(out).toContain("PASS audit chain: 2 rows verified from seq 1")

    writeFileSync(
      join(root, config.databases[0]?.staged ?? ""),
      "garbage ".repeat(600)
    )
    out.length = 0
    expect(await main(["verify", root], ctx)).toBe(1)
    expect(out).toContain(
      "FAIL eido-data.db opens: not a readable SQLite database"
    )
  })

  test("verify and restore reject bad arguments", async () => {
    const { ctx, err } = context(repoEnv())
    expect(await main(["verify"], ctx)).toBe(2)
    expect(await main(["restore"], ctx)).toBe(2)
    expect(await main(["restore", "/x", "--snapshot"], ctx)).toBe(2)
    expect(await main(["restore", "/x", "--bogus", "id"], ctx)).toBe(2)
    expect(err).toHaveLength(4)
  })

  test("restore restores, verifies and prints the snapshot, time and results", async () => {
    const env = repoEnv()
    mkdirSync(env.EIDO_BACKUP_REPO, { recursive: true })
    writeFileSync(join(env.EIDO_BACKUP_REPO, "config"), "")
    const ctxParts = context(env)
    const config = buildBackupConfig({
      env,
      home: ctxParts.home,
      repoRoot: "/repo",
    })
    const run: ResticRun = (args) => {
      if (args[0] === "snapshots")
        return Promise.resolve({
          code: 0,
          stderr: "",
          stdout: JSON.stringify([{ id: "s1", time: "2026-03-09T12:00:00Z" }]),
        })
      materializeRestore(config, args[3] ?? "")
      return Promise.resolve({ code: 0, stdout: "", stderr: "" })
    }
    const target = join(tempDir(), "scratch")
    expect(
      await main(["restore", target, "--snapshot", "s1"], {
        ...ctxParts.ctx,
        run,
      })
    ).toBe(0)
    expect(ctxParts.out[0]).toMatch(
      /^snapshot s1 \(2026-03-09T12:00:00.000Z\) restored to .*scratch in 0\.0s$/
    )
    expect(ctxParts.out.filter((l) => l.startsWith("PASS"))).toHaveLength(4)
  })

  test("plist prints the LaunchAgent for the configured paths", async () => {
    const { ctx, out } = context(repoEnv())
    expect(await main(["plist"], ctx)).toBe(0)
    expect(out[0]).toContain("<key>Label</key>")
    expect(out[0]).toContain(ctx.env["EIDO_BACKUP_REPO"])
  })

  test("plain plist refuses on a split host: its databases are not the owner's to back up", async () => {
    const { ctx, logs } = context({ ...repoEnv(), EIDO_BACKUP_PLANE: "split" })
    expect(await main(["plist"], ctx)).toBe(1)
    expect(logs.at(-1)).toContain("run `backup plane`")
  })

  test("plane prints the script for the plane's data dirs, with the plane's own node and restic by default", async () => {
    const { ctx, out } = context(repoEnv())
    expect(await main(["plane"], ctx)).toBe(0)
    expect(out[0]).toMatch(/^#!\/bin\/sh\n/)
    expect(out[0]).toContain("/Library/Application Support/Eido/gate")
    expect(out[0]).toContain(
      "<string>/Library/Application Support/Eido/bin/node</string>"
    )
    expect(out[0]).toMatch(
      /<key>EIDO_RESTIC_BIN<\/key>\s*<string>\/Library\/Application Support\/Eido\/bin\/restic<\/string>/
    )
    expect(out[0]).toContain(ctx.env["EIDO_BACKUP_REPO"])
  })

  test("plane --node and --restic use the binaries they are given", async () => {
    const { ctx, out } = context(repoEnv())
    const argv = [
      "plane",
      "--restic",
      "/usr/local/libexec/restic",
      "--node",
      "/usr/local/bin/node",
    ]
    expect(await main(argv, ctx)).toBe(0)
    expect(out[0]).toContain("<string>/usr/local/bin/node</string>")
    expect(out[0]).toContain("<string>/usr/local/libexec/restic</string>")
  })

  test("plane refuses a binary inside a home", async () => {
    const { ctx, logs } = context(repoEnv())
    expect(await main(["plane", "--node", "/Users/me/bin/node"], ctx)).toBe(1)
    expect(logs.at(-1)).toContain("inside a home")
  })

  test.each([
    ["a misspelt flag", ["plane", "--nod", "/x"]],
    ["a flag with no value", ["plane", "--restic"]],
    ["a repeated flag", ["plane", "--node", "/a", "--node", "/b"]],
    ["a stray argument", ["plane", "--node", "/a", "extra"]],
  ])("plane with %s prints usage and exits 2", async (_name, argv) => {
    const { ctx, err } = context(repoEnv())
    expect(await main(argv, ctx)).toBe(2)
    expect(err[0]).toMatch(/^usage: backup run/)
  })
})
