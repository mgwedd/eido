// `pnpm --filter @eido/infra serve-routes <command> [--port N] [--web-port N] [--core-port N] [--gate-port N]`
//   plan     print the tailscale commands apply would run; changes nothing
//   check    read `tailscale serve status --json` and `tailscale funnel status --json`; exit 1 on any problem
//   apply    refuse if Eido's port holds a route it does not own or funnel is on, run the three
//            `tailscale serve --bg` commands, then check
//   measure  with the routes applied and Next, core and the gate stopped, start echo servers on the
//            targets and report the path, Host and Tailscale-User-Login each backend receives
// Only Eido's port (default 8443) is ever read for problems or written.
import { probe, report, startEchoServers, type Fetch } from "./measure.ts"
import {
  applyCommands,
  blockingProblems,
  checkServeConfig,
  parseDnsName,
  parseEdgeConfig,
  parseServeConfig,
  routesFor,
  type CheckResult,
  type EdgeConfig,
} from "./serve-routes.ts"

export type RunResult = { code: number; stdout: string; stderr: string }

export type Deps = {
  tailscale: (args: readonly string[]) => Promise<RunResult>
  fetch: Fetch
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE =
  "usage: serve-routes plan|check|apply|measure [--port N] [--web-port N] [--core-port N] [--gate-port N]"

async function tailscaleJson(
  deps: Deps,
  args: readonly string[]
): Promise<string> {
  const run = await deps.tailscale(args)
  if (run.code !== 0)
    throw new Error(
      `tailscale ${args.join(" ")} failed: ${run.stderr.trim() || `exit ${run.code}`}`
    )
  return run.stdout
}

async function readCheck(deps: Deps, config: EdgeConfig): Promise<CheckResult> {
  const serve = parseServeConfig(
    await tailscaleJson(deps, ["serve", "status", "--json"])
  )
  const funnel = parseServeConfig(
    await tailscaleJson(deps, ["funnel", "status", "--json"])
  )
  const result = checkServeConfig(
    { ...serve, AllowFunnel: { ...serve.AllowFunnel, ...funnel.AllowFunnel } },
    config
  )
  return result
}

function printResult(
  deps: Deps,
  result: CheckResult,
  config: EdgeConfig
): number {
  for (const warning of result.warnings) deps.out(`warning: ${warning}`)
  if (result.problems.length > 0) {
    for (const problem of result.problems) deps.err(`FAIL: ${problem.message}`)
    return 1
  }
  for (const route of routesFor(config))
    deps.out(`ok: :${config.port}${route.path} -> ${route.target}`)
  deps.out(
    `ok: exactly the three Eido routes on port ${config.port}; funnel is off for it`
  )
  return 0
}

async function apply(deps: Deps, config: EdgeConfig): Promise<number> {
  const blocking = blockingProblems(await readCheck(deps, config))
  if (blocking.length > 0) {
    for (const problem of blocking) deps.err(`FAIL: ${problem.message}`)
    deps.err(
      `Nothing was changed. Remove what is listed on port ${config.port} by hand, then run apply again.`
    )
    return 1
  }
  for (const args of applyCommands(config)) {
    deps.out(`$ tailscale ${args.join(" ")}`)
    const run = await deps.tailscale(args)
    if (run.code !== 0) {
      deps.err(
        `FAIL: tailscale ${args.join(" ")}: ${run.stderr.trim() || `exit ${run.code}`}`
      )
      return 1
    }
  }
  return printResult(deps, await readCheck(deps, config), config)
}

async function measure(deps: Deps, config: EdgeConfig): Promise<number> {
  const result = await readCheck(deps, config)
  if (printResult(deps, result, config) !== 0) {
    deps.err("Apply the routes before measuring.")
    return 1
  }
  const dnsName = parseDnsName(await tailscaleJson(deps, ["status", "--json"]))
  const echo = await startEchoServers(routesFor(config))
  try {
    const results = await probe(`https://${dnsName}:${config.port}`, deps.fetch)
    for (const line of report(results, dnsName, config.port)) deps.out(line)
    return results.every((seen) => typeof seen !== "string") ? 0 : 1
  } finally {
    await echo.close()
  }
}

export async function main(
  argv: readonly string[],
  deps: Deps
): Promise<number> {
  const [command, ...rest] = argv
  let config: EdgeConfig
  try {
    config = parseEdgeConfig(rest)
  } catch (error) {
    deps.err(`${(error as Error).message}\n${USAGE}`)
    return 2
  }
  try {
    switch (command) {
      case "plan":
        for (const args of applyCommands(config))
          deps.out(`tailscale ${args.join(" ")}`)
        return 0
      case "check":
        return printResult(deps, await readCheck(deps, config), config)
      case "apply":
        return await apply(deps, config)
      case "measure":
        return await measure(deps, config)
      default:
        deps.err(USAGE)
        return 2
    }
  } catch (error) {
    deps.err(`FAIL: ${(error as Error).message}`)
    return 1
  }
}
