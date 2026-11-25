// The gate user's outbound allowlist (#471): the hosts the reviewed connector manifests name, plus
// the few the gate contacts outside them, as a pf anchor and a host list. The anchor has no host
// names in it, so it always loads, even before the network is up, and its block rules close egress
// from the start. A root job then adds each host's addresses to the anchor's table with
// `pfctl -T add <host>`, which resolves the name itself, every five minutes. Addresses only
// accumulate until the anchor is next loaded (a reboot or a new plan), which covers the rotating
// address pools behind Google's API hosts. Pure functions; plane.ts writes the files and the job.
import {
  WEB_PUSH_HOSTS,
  validateConnectorManifest,
  type ConnectorManifest,
} from "@eido/schemas"

import { shellQuote } from "./shell.ts"

/** A sibling of the plane anchor under `com.apple/*`, which the stock /etc/pf.conf evaluates. */
export const EGRESS_ANCHOR = "com.apple/eido.egress"
export const EGRESS_TABLE = "eido_egress"
/** How often launchd reruns the job that adds the hosts' addresses. */
export const EGRESS_REFRESH_SECONDS = 300

/**
 * Hosts the gate contacts that no manifest names. Each is fixed in the gate's source; the reason
 * says where.
 */
export const BASE_HOSTS: ReadonlyArray<{ host: string; reason: string }> = [
  {
    host: "oauth2.googleapis.com",
    reason:
      "Google token exchange and refresh (packages/gate/src/internal/oauth-refresh.ts, connect/oauth.ts)",
  },
  // The gate refuses a subscription on any other push host, from the same list (#789).
  ...WEB_PUSH_HOSTS.map((host) => ({
    host,
    reason:
      "Web Push to Safari and the iPhone home-screen app (packages/gate/src/internal/push-notify.ts)",
  })),
  {
    host: "bridge.simplefin.org",
    reason:
      "SimpleFIN setup-token claim (packages/gate/src/internal/connect/simplefin-claim.ts)",
  },
]

/** The only loopback addresses the gate dials (the Proton Bridge hosts, gate bridge/config.ts). */
const LOOPBACK = new Set(["127.0.0.1", "::1"])

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A fully qualified DNS name with at least two labels: no wildcard, no IP literal, no port. */
export function isHostName(host: string): boolean {
  const labels = host.split(".")
  return (
    host.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    !/^[0-9]+$/.test(labels[labels.length - 1] ?? "")
  )
}

export type LocalEndpoint = { host: string; port: number }

export type EgressTargets = {
  /** Sorted, unique remote hosts, reached on TCP 443. */
  hosts: string[]
  /** Sorted, unique loopback endpoints from the manifests' `egress.local`. */
  local: LocalEndpoint[]
}

/**
 * The remote hosts and loopback endpoints the gate may reach. `manifests` is connector name to
 * unchecked JSON (`REVIEWED_MANIFESTS`); each is validated, and anything wrong stops the plan
 * rather than leaving a host out silently.
 */
export function egressTargets(
  manifests: Readonly<Record<string, unknown>>,
  base: ReadonlyArray<{ host: string }> = BASE_HOSTS
): EgressTargets {
  const hosts = new Set<string>()
  const local = new Map<string, LocalEndpoint>()
  const problems: string[] = []
  const addHost = (host: string, from: string) => {
    const name = host.toLowerCase().replace(/\.$/, "")
    if (isHostName(name)) hosts.add(name)
    else problems.push(`${from}: ${JSON.stringify(host)} is not a host name`)
  }
  for (const { host } of base) addHost(host, "the base list")
  const checked: ConnectorManifest[] = []
  for (const [name, value] of Object.entries(manifests)) {
    const result = validateConnectorManifest(value)
    if (result.ok) checked.push(result.value)
    else problems.push(`the ${name} manifest is not a valid connector manifest`)
  }
  for (const manifest of checked) {
    for (const { host } of manifest.egress.hosts) addHost(host, manifest.name)
    for (const { host, port } of manifest.egress.local ?? []) {
      if (LOOPBACK.has(host))
        local.set(`${host} ${String(port)}`, { host, port })
      else
        problems.push(
          `${manifest.name}: local endpoint ${host}:${String(port)} is not 127.0.0.1 or ::1`
        )
    }
  }
  if (problems.length > 0) throw new Error(problems.join("; "))
  return {
    hosts: [...hosts].sort(),
    local: [...local.values()].sort(
      (a, b) => a.host.localeCompare(b.host) || a.port - b.port
    ),
  }
}

/**
 * The anchor: the gate user may open TCP to the table's addresses on 443 and to the manifests'
 * loopback endpoints, and nothing else; it may send no UDP (names resolve through mDNSResponder,
 * which runs as root). The table starts empty, so the anchor loads without DNS and egress is closed
 * until the job adds addresses. As in the plane anchor, only a connection's first packet is
 * matched, so replies on connections others open to the gate (web, core's egress proxy) pass.
 */
export function egressRules(input: {
  uid: number
  local: readonly LocalEndpoint[]
}): string {
  const uid = String(input.uid)
  const byHost = new Map<string, number[]>()
  for (const { host, port } of input.local)
    byHost.set(host, [...(byHost.get(host) ?? []), port])
  const loopback = [...byHost].map(
    ([host, ports]) =>
      `pass out quick on lo0 proto tcp from any to ${host} port { ${ports.join(", ")} } user ${uid} flags S/SA keep state`
  )
  return [
    `# Eido gate egress allowlist (#471), anchor ${EGRESS_ANCHOR}: generated by \`host plane\`.`,
    `# uid ${uid} is the gate user. The egress job fills <${EGRESS_TABLE}> from the host list.`,
    `table <${EGRESS_TABLE}> persist`,
    `pass out quick proto tcp from any to <${EGRESS_TABLE}> port 443 user ${uid} flags S/SA keep state`,
    ...loopback,
    `block return out quick proto tcp from any to any user ${uid} flags S/SA`,
    `block return out quick proto udp from any to any user ${uid}`,
    "",
  ].join("\n")
}

/** The host list the job reads: one name per line. */
export function egressHostList(hosts: readonly string[]): string {
  return hosts.map((host) => `${host}\n`).join("")
}

/**
 * The job's /bin/sh command. It loads the anchor when the anchor is empty (after a reboot, or if
 * something flushed it), then adds every listed host's current addresses to the table. A host
 * that does not resolve is reported and the others still go in.
 */
export function egressJob(paths: {
  rules: string
  hosts: string
  pfctl?: string
}): string {
  const pfctl = paths.pfctl ?? "/sbin/pfctl"
  const anchor = `${pfctl} -q -a ${EGRESS_ANCHOR}`
  return [
    `${anchor} -sr | /usr/bin/grep -q . || ${anchor} -f ${shellQuote(paths.rules)} || exit 1`,
    `while read -r host; do ${anchor} -t ${EGRESS_TABLE} -T add "$host" || echo "egress: $host was not added" >&2; done < ${shellQuote(paths.hosts)}`,
  ].join("\n")
}
