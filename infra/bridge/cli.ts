// `pnpm --filter @eido/infra bridge <command> [--bridge PATH]`
//   plan       print the plist and the launchctl commands install would run; changes nothing
//   install    write the plist, then `launchctl bootstrap gui/<uid>` it
//   uninstall  `launchctl bootout` the job and remove the plist
//   status     launchd's view of the job (state, pid, runs, last exit)
//   health     read the IMAP and SMTP greetings at EIDO_BRIDGE_HOST and the two ports; exit 1 on failure
// Only the job com.eido.proton-bridge is touched. Effects are passed in, so tests never run launchctl.
import {
  bootoutArgs,
  bootstrapArgs,
  parsePrint,
  printArgs,
  target,
} from "./launchctl.ts"
import { endpointFromEnv, probe, type ReadGreeting } from "./health.ts"
import { buildPlist, DEFAULT_BRIDGE_PATH, layout } from "./plist.ts"

export type RunResult = { code: number; stdout: string; stderr: string }

export type Deps = {
  launchctl: (args: readonly string[]) => Promise<RunResult>
  readGreeting: ReadGreeting
  fs: {
    exists: (path: string) => boolean
    mkdir: (path: string) => void
    writeFile: (path: string, text: string) => void
    remove: (path: string) => void
  }
  env: Readonly<Record<string, string | undefined>>
  home: string
  uid: number
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE =
  "usage: bridge plan|install|uninstall|status|health [--bridge PATH]"

function bridgePathFrom(args: readonly string[]): string | Error {
  const at = args.indexOf("--bridge")
  if (at === -1) return DEFAULT_BRIDGE_PATH
  const value = args[at + 1]
  if (value === undefined || value.startsWith("--"))
    return new Error("--bridge needs a path")
  return value
}

async function install(deps: Deps, bridgePath: string): Promise<number> {
  if (!deps.fs.exists(bridgePath)) {
    deps.err(
      `FAIL: no Bridge at ${bridgePath}; install Proton's release or pass --bridge PATH`
    )
    return 1
  }
  const paths = layout(deps.home)
  // Re-installing replaces the loaded job: bootstrap refuses a label that is already loaded.
  const loaded = await deps.launchctl(printArgs(deps.uid))
  if (loaded.code === 0) await deps.launchctl(bootoutArgs(deps.uid))
  deps.fs.mkdir(paths.logDir)
  deps.fs.writeFile(
    paths.plistPath,
    buildPlist({ bridgePath, home: deps.home })
  )
  const run = await deps.launchctl(bootstrapArgs(deps.uid, paths.plistPath))
  if (run.code !== 0) {
    deps.err(`FAIL: launchctl bootstrap: ${run.stderr.trim() || run.code}`)
    return 1
  }
  deps.out(`ok: ${target(deps.uid)} loaded from ${paths.plistPath}`)
  deps.out("run `health` once Bridge has logged in and its ports are set")
  return 0
}

async function uninstall(deps: Deps): Promise<number> {
  const paths = layout(deps.home)
  const loaded = await deps.launchctl(printArgs(deps.uid))
  if (loaded.code === 0) {
    const run = await deps.launchctl(bootoutArgs(deps.uid))
    if (run.code !== 0) {
      deps.err(`FAIL: launchctl bootout: ${run.stderr.trim() || run.code}`)
      return 1
    }
  }
  if (deps.fs.exists(paths.plistPath)) deps.fs.remove(paths.plistPath)
  deps.out(`ok: ${target(deps.uid)} is not loaded and its plist is gone`)
  return 0
}

async function status(deps: Deps): Promise<number> {
  const run = await deps.launchctl(printArgs(deps.uid))
  if (run.code !== 0) {
    deps.err(`FAIL: ${target(deps.uid)} is not loaded`)
    return 1
  }
  const job = parsePrint(run.stdout)
  deps.out(`state: ${job.state ?? "unknown"}`)
  deps.out(`pid: ${job.pid ?? "none"}`)
  deps.out(`runs: ${job.runs ?? "unknown"}`)
  deps.out(`last exit: ${job.lastExitStatus ?? "none"}`)
  return job.state === "running" ? 0 : 1
}

async function health(deps: Deps): Promise<number> {
  let endpoint
  try {
    endpoint = endpointFromEnv(deps.env)
  } catch (error) {
    deps.err(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const results = await probe(endpoint, deps.readGreeting)
  let code = 0
  for (const result of results) {
    const where = `${result.protocol} ${endpoint.host}:${result.port}`
    if (result.error === undefined) deps.out(`ok: ${where} greeted`)
    else {
      deps.err(`FAIL: ${where}: ${result.error}`)
      code = 1
    }
  }
  return code
}

export async function main(
  argv: readonly string[],
  deps: Deps
): Promise<number> {
  const [command, ...rest] = argv
  const bridgePath = bridgePathFrom(rest)
  if (bridgePath instanceof Error) {
    deps.err(bridgePath.message)
    return 2
  }
  switch (command) {
    case "plan": {
      const paths = layout(deps.home)
      deps.out(`# ${paths.plistPath}`)
      deps.out(buildPlist({ bridgePath, home: deps.home }))
      deps.out(
        `launchctl ${bootstrapArgs(deps.uid, paths.plistPath).join(" ")}`
      )
      return 0
    }
    case "install":
      return install(deps, bridgePath)
    case "uninstall":
      return uninstall(deps)
    case "status":
      return status(deps)
    case "health":
      return health(deps)
    default:
      deps.err(USAGE)
      return 2
  }
}
