// Read-only host baseline checks (#29): parse what `fdesetup status`, `tailscale status --json`
// and `lsof` print. Nothing here changes a setting; the commands are run by the caller.

export type Finding = { ok: boolean; message: string }

/** `fdesetup status` prints "FileVault is On." once encryption is enabled. */
export function fileVaultFinding(output: string): Finding {
  const line = output.split("\n")[0]?.trim() ?? ""
  if (line.startsWith("FileVault is On"))
    return { ok: true, message: `FileVault: ${line}` }
  return {
    ok: false,
    message: `FileVault is not on: ${JSON.stringify(line || output.trim())}`,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** `tailscale status --json` reports `BackendState: "Running"` when the node is connected. */
export function tailscaleFinding(json: string): Finding {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return { ok: false, message: "tailscale status --json printed no JSON" }
  }
  const state = isRecord(value) ? value["BackendState"] : undefined
  const self = isRecord(value) ? value["Self"] : undefined
  const dnsName = isRecord(self) ? self["DNSName"] : undefined
  if (state === "Running")
    return {
      ok: true,
      message: `Tailscale: Running${typeof dnsName === "string" ? ` as ${dnsName.replace(/\.$/, "")}` : ""}`,
    }
  return {
    ok: false,
    message: `Tailscale is not running: BackendState ${JSON.stringify(state ?? null)}`,
  }
}

export type Listener = { pid: number; command: string; address: string }

/** Parses `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpcn`: `p<pid>`, `c<command>`, `n<addr:port>` lines. */
export function parseListeners(output: string): Listener[] {
  const listeners: Listener[] = []
  let pid = 0
  let command = ""
  for (const line of output.split("\n")) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === "p") pid = Number(value)
    else if (tag === "c") command = value
    else if (tag === "n") {
      const address = value.slice(0, value.lastIndexOf(":"))
      if (!listeners.some((l) => l.pid === pid && l.address === address))
        listeners.push({ pid, command, address })
    }
  }
  return listeners
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "[::1]"])

/** Every listener on the port must be bound to loopback; a wildcard or LAN address fails. */
export function loopbackOnlyFinding(
  port: number,
  listeners: Listener[]
): Finding {
  if (listeners.length === 0)
    return { ok: false, message: `nothing listens on port ${port}` }
  const exposed = listeners.filter((l) => !LOOPBACK_ADDRESSES.has(l.address))
  if (exposed.length > 0)
    return {
      ok: false,
      message: `port ${port} is reachable beyond loopback: ${exposed
        .map((l) => `${l.command} (pid ${l.pid}) on ${l.address}`)
        .join(", ")}`,
    }
  return {
    ok: true,
    message: `port ${port} listens on loopback only: ${listeners
      .map((l) => `${l.command} (pid ${l.pid}) on ${l.address}`)
      .join(", ")}`,
  }
}
