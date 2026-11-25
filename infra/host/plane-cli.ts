// `node infra/host/bin.ts plane plan|remove`: prints, as a /bin/sh script, every command
// that creates (or takes down) the plane split (#70). It reads the host (dscl, stack.env,
// tailscale) as the owner and changes nothing; the owner reviews the script and runs it with
// `sudo sh`. See infra/plane-split.md.
import { parseArgs } from "node:util"

import {
  applyStackSettings,
  readStackSettings,
  stackSettingsPath,
  type FileStat,
} from "../stack/settings.ts"
import { parseDnsName, parsePort } from "../tailscale/serve-routes.ts"
import type { RunResult } from "./cli.ts"
import {
  DEFAULT_FIRST_ID,
  accountProblems,
  applySteps,
  parseDsclIds,
  parseDsclValue,
  planeLayout,
  removeNotes,
  removeSteps,
  renderScript,
} from "./plane.ts"

export type PlaneDeps = {
  run: (command: string, args: readonly string[]) => Promise<RunResult>
  env: Readonly<Record<string, string | undefined>>
  files: {
    read: (path: string) => string | undefined
    stat: (path: string) => FileStat | undefined
  }
  /** The checkout this script runs from: what the plan copies into the plane. */
  repoRoot: string
  /** The node binary running this script: the services' node unless --node says otherwise. */
  execPath: string
  out: (text: string) => void
  err: (line: string) => void
}

export const PLANE_USAGE =
  "usage: host plane <plan|remove> [--owner <user>] [--node <path>] [--checkout <dir>] [--first-id <n>] [--egress-port <port>]"

async function read(
  deps: PlaneDeps,
  command: string,
  args: readonly string[]
): Promise<string> {
  const result = await deps.run(command, args)
  if (result.code !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`
    )
  return result.stdout
}

export async function plane(
  argv: readonly string[],
  deps: PlaneDeps
): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        owner: { type: "string" },
        node: { type: "string" },
        checkout: { type: "string" },
        "first-id": { type: "string" },
        "egress-port": { type: "string" },
      },
    })
  } catch (error) {
    deps.err((error as Error).message)
    deps.err(PLANE_USAGE)
    return 2
  }
  const [action, ...extra] = parsed.positionals
  if ((action !== "plan" && action !== "remove") || extra.length > 0) {
    deps.err(PLANE_USAGE)
    return 2
  }
  const { values } = parsed
  try {
    const owner =
      values.owner ?? deps.env["SUDO_USER"] ?? deps.env["USER"] ?? ""
    const firstId =
      values["first-id"] === undefined
        ? DEFAULT_FIRST_ID
        : Number(values["first-id"])
    const ownerHome = parseDsclValue(
      await read(deps, "/usr/bin/dscl", [
        ".",
        "-read",
        `/Users/${owner}`,
        "NFSHomeDirectory",
      ]),
      "NFSHomeDirectory"
    )
    const layout = planeLayout({ owner, ownerHome, firstId, env: deps.env })
    const accounts = {
      users: parseDsclIds(
        await read(deps, "/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"])
      ),
      groups: parseDsclIds(
        await read(deps, "/usr/bin/dscl", [
          ".",
          "-list",
          "/Groups",
          "PrimaryGroupID",
        ])
      ),
    }
    if (action === "remove") {
      deps.out(
        renderScript(
          removeSteps(layout, accounts),
          removeNotes(layout)
        ).trimEnd()
      )
      return 0
    }
    const problems = accountProblems(layout, accounts)
    if (problems.length > 0) {
      for (const problem of problems) deps.err(problem)
      return 1
    }
    const settings = applyStackSettings(
      deps.env,
      readStackSettings(
        deps.files,
        stackSettingsPath(deps.env, ownerHome, "darwin"),
        "darwin"
      )
    )
    const given = settings["EIDO_TAILNET_HOST"]
    const tailnetHost =
      given === undefined || given === ""
        ? parseDnsName(await read(deps, "tailscale", ["status", "--json"]))
        : given
    const egress = values["egress-port"]
    const steps = applySteps({
      layout,
      checkout: values.checkout ?? deps.repoRoot,
      node: values.node ?? deps.execPath,
      tailnetHost,
      settings,
      ...(egress === undefined
        ? {}
        : { egressPort: parsePort(egress, "--egress-port") }),
    })
    deps.out(renderScript(steps).trimEnd())
    return 0
  } catch (error) {
    deps.err((error as Error).message)
    return 1
  }
}
