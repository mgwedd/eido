// `node infra/host/bin.ts plane plan|remove`: prints, as a /bin/sh script, every command
// that creates (or takes down) the plane split (#70). It reads the host (dscl, stack.env,
// tailscale) as the owner and changes nothing; the owner reviews the script and runs it with
// `sudo sh`. The gate's egress allowlist comes from the reviewed manifests it is given (#471).
// See infra/plane-split.md.
import { parseArgs } from "node:util"

import {
  applyStackSettings,
  readStackSettings,
  stackSettingsPath,
  type FileStat,
} from "../stack/settings.ts"
import { parseDnsName, parsePort } from "../tailscale/serve-routes.ts"
import { egressTargets } from "./egress.ts"
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
import type { BridgeInput } from "./session-bridge.ts"

export type RunResult = { code: number; stdout: string; stderr: string }

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
  /** Connector name to unchecked manifest JSON: `REVIEWED_MANIFESTS` from @eido/schemas. */
  manifests: Readonly<Record<string, unknown>>
  out: (text: string) => void
  err: (line: string) => void
}

export const PLANE_USAGE =
  "usage: host plane <plan|remove> [--owner <user>] [--node <path>] [--checkout <dir>] [--first-id <n>] [--egress-port <port>] [--bridge-helper <path> --bridge-file-helper <path> --bridge-file-helper-sha256 <hex> --bridge-file-roots <path>]"

const BRIDGE_FLAGS = [
  "bridge-helper",
  "bridge-file-helper",
  "bridge-file-helper-sha256",
  "bridge-file-roots",
] as const

/**
 * The session bridge's settings (#827): none of the four flags, or all of them. Each file must
 * exist; the helper binaries and the owner's list of file roots must not be writable by group or
 * others, since the root-owned copy of the one and the owner's own use of the other trust them.
 */
function bridgeInput(
  values: Partial<Record<(typeof BRIDGE_FLAGS)[number], string>>,
  ownerUid: number | undefined,
  files: PlaneDeps["files"]
): BridgeInput | undefined {
  const given = BRIDGE_FLAGS.filter((flag) => values[flag] !== undefined)
  if (given.length === 0) return undefined
  const missing = BRIDGE_FLAGS.filter((flag) => values[flag] === undefined)
  if (missing.length > 0)
    throw new Error(
      `the session bridge needs all four --bridge-* flags; missing ${missing.map((flag) => `--${flag}`).join(", ")}`
    )
  if (ownerUid === undefined)
    throw new Error("the owner has no user id in the account list")
  const helper = values["bridge-helper"] ?? ""
  const fileHelper = values["bridge-file-helper"] ?? ""
  const fileRoots = values["bridge-file-roots"] ?? ""
  for (const [flag, path] of [
    ["--bridge-helper", helper],
    ["--bridge-file-helper", fileHelper],
    ["--bridge-file-roots", fileRoots],
  ] as const) {
    if (!path.startsWith("/"))
      throw new Error(
        `${flag} must be an absolute path, not ${JSON.stringify(path)}`
      )
    const stat = files.stat(path)
    if (stat === undefined || !stat.isFile)
      throw new Error(`${flag} ${path} is not a file`)
    if ((stat.mode & 0o022) !== 0)
      throw new Error(
        `${flag} ${path} has mode ${(stat.mode & 0o777).toString(8).padStart(4, "0")}; remove write access for group and others`
      )
  }
  return {
    ownerUid,
    helper,
    fileHelper,
    fileHelperSha256: values["bridge-file-helper-sha256"] ?? "",
    fileRoots,
  }
}

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
        "bridge-helper": { type: "string" },
        "bridge-file-helper": { type: "string" },
        "bridge-file-helper-sha256": { type: "string" },
        "bridge-file-roots": { type: "string" },
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
    const bridge = bridgeInput(values, accounts.users.get(owner), deps.files)
    const steps = applySteps({
      layout,
      checkout: values.checkout ?? deps.repoRoot,
      node: values.node ?? deps.execPath,
      tailnetHost,
      settings,
      allowlist: egressTargets(deps.manifests),
      ...(bridge === undefined ? {} : { bridge }),
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
