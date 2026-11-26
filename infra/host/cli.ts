// `pnpm --filter @eido/infra host check`: the Mac's baseline, read only. FileVault must be on
// (`fdesetup status`) and Tailscale connected (`tailscale status --json`). Funnel and the serve
// routes are checked by `serve-routes check`. Nothing here changes a setting or needs sudo.
// `host plane` prints the plane split script (#70); see plane-cli.ts. `host keychain` prints the
// gate keychain passphrase scripts (#824); see keychain-passphrase.ts.
import { fileVaultFinding, tailscaleFinding, type Finding } from "./checks.ts"
import { KEYCHAIN_USAGE, keychain } from "./keychain-passphrase.ts"
import { PLANE_USAGE, plane, type PlaneDeps } from "./plane-cli.ts"

export type { RunResult } from "./plane-cli.ts"

export type Deps = PlaneDeps

async function finding(
  deps: Deps,
  command: string,
  args: readonly string[],
  parse: (stdout: string) => Finding
): Promise<Finding> {
  const result = await deps.run(command, args)
  if (result.code !== 0)
    return {
      ok: false,
      message: `${command} ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    }
  return parse(result.stdout)
}

export async function main(
  argv: readonly string[],
  deps: Deps
): Promise<number> {
  if (argv[0] === "plane") return plane(argv.slice(1), deps)
  if (argv[0] === "keychain") return keychain(argv.slice(1), deps)
  if (argv[0] !== "check" || argv.length !== 1) {
    deps.err("usage: host check")
    deps.err(PLANE_USAGE)
    deps.err(KEYCHAIN_USAGE)
    return 2
  }
  const findings = [
    await finding(deps, "fdesetup", ["status"], fileVaultFinding),
    await finding(deps, "tailscale", ["status", "--json"], tailscaleFinding),
  ]
  for (const f of findings) {
    if (f.ok) deps.out(`ok: ${f.message}`)
    else deps.err(`FAIL: ${f.message}`)
  }
  return findings.every((f) => f.ok) ? 0 : 1
}
