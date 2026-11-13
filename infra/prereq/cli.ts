// `node infra/prereq/bin.ts`: the first step of a first run (#710), before `pnpm stack:bootstrap`.
// It needs only Node, so it can run on a machine with no pnpm. It checks Node against the repo's
// `engines`, and makes pnpm resolvable by enabling corepack when it is missing. It cannot install
// Node, so a missing or old Node ends with the one thing to do. Tailscale is not checked here: the
// Admin Tailscale check covers it (#646).

export type RunResult = { code: number; stdout: string; stderr: string }

export type Deps = {
  run: (command: string, args: readonly string[]) => Promise<RunResult>
  /** The running Node's version, such as "24.1.0". */
  nodeVersion: string
  /** The repo's package.json text, for `engines.node` and `packageManager`. */
  readPackageJson: () => string
  out: (line: string) => void
  err: (line: string) => void
}

/** The major version in an `engines.node` range such as ">=24"; undefined for anything else. */
export function minNodeMajor(range: string): number | undefined {
  const match = /^>=\s*(\d+)(?:\.\d+){0,2}$/.exec(range.trim())
  return match === null ? undefined : Number(match[1])
}

type Pins = { nodeRange: string; pnpmVersion: string }

function readPins(text: string): Pins | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const engines: unknown = Reflect.get(parsed, "engines")
  const nodeRange: unknown =
    typeof engines === "object" && engines !== null
      ? Reflect.get(engines, "node")
      : undefined
  const manager: unknown = Reflect.get(parsed, "packageManager")
  const pnpm =
    typeof manager === "string" ? /^pnpm@(\d+\.\d+\.\d+)$/.exec(manager) : null
  if (typeof nodeRange !== "string" || pnpm === null) return undefined
  return { nodeRange, pnpmVersion: pnpm[1] ?? "" }
}

export async function main(
  argv: readonly string[],
  deps: Deps
): Promise<number> {
  if (argv.length !== 0) {
    deps.err("usage: node infra/prereq/bin.ts")
    return 2
  }
  const pins = readPins(deps.readPackageJson())
  const min = pins === undefined ? undefined : minNodeMajor(pins.nodeRange)
  if (pins === undefined || min === undefined) {
    deps.err(
      'FAIL: package.json has no readable "engines.node" (>=N) and "packageManager" (pnpm@X.Y.Z); run this from the repository root'
    )
    return 1
  }

  const major = Number(deps.nodeVersion.split(".")[0])
  if (!(major >= min)) {
    deps.err(
      `FAIL: Node ${deps.nodeVersion} is older than the required ${pins.nodeRange}. Install Node ${min} or newer from https://nodejs.org, then run this command again.`
    )
    return 1
  }
  deps.out(`ok: Node ${deps.nodeVersion} (needs ${pins.nodeRange})`)

  const found = await deps.run("pnpm", ["--version"])
  if (found.code === 0) {
    deps.out(`ok: pnpm ${found.stdout.trim()}`)
    deps.out("Next: pnpm stack:bootstrap")
    return 0
  }

  deps.out("pnpm not found: running corepack enable")
  const enabled = await deps.run("corepack", ["enable"])
  const after =
    enabled.code === 0 ? await deps.run("pnpm", ["--version"]) : enabled
  if (after.code !== 0) {
    deps.err(
      `FAIL: could not make pnpm available through corepack (${after.stderr.trim() || `exit ${after.code}`}). Run: npm install --global pnpm@${pins.pnpmVersion}, then run this command again.`
    )
    return 1
  }
  deps.out(`ok: pnpm ${after.stdout.trim()}`)
  deps.out("Next: pnpm stack:bootstrap")
  return 0
}
