// The plan that starts the probe broker (#820), pure so it is unit-tested without sudo. The probe
// broker is the production broker (`packages/core/src/parsers/broker.ts`, #817) running as
// `_eidoparse` (#818) under the installed `parser.sb` with its socket swapped for a probe socket
// in the same private dir. It differs from the LaunchDaemon in the socket path and in its parse
// child's entry (`isolation-parser-child.ts`, which tries to reach a target instead of parsing a
// document); the sandbox, the user, the pf rules, the process tree and the socket's owner and
// group are the daemon's. Nothing here wraps a parse child in `parser.sb` by itself.
import { PARSER_NAME } from "../infra/host/parser-plane.ts"
import { sbplString } from "../infra/host/plane-base.ts"

// ---- the plan --------------------------------------------------------------------------------

/** Where the probe broker runs and how it is started. */
export type ParserPlanInput = {
  /** The installed `parser.sb` text: the probe broker runs under it, with its socket swapped. */
  daemonProfile: string
  /** The production broker's socket, as the installed profile names it. */
  daemonSocket: string
  /** The node binary, the core hooks, the no-network preload and the two probe entries. */
  node: string
  coreHooks: string
  noNetwork: string
  brokerEntry: string
  workerEntry: string
  /** 16 lowercase hex characters, random per run: the probe socket's name. */
  id: string
}

export type ParserPlan = {
  /** The one user the broker and its parse children run as. */
  user: string
  /** The probe broker's socket, next to the production socket in the same private dir. */
  socket: string
  /**
   * The `sudo` arguments that start the probe broker. `sandbox-exec` wraps the broker alone, as
   * the LaunchDaemon does; the parse children are the broker's, not wrapped here.
   */
  brokerSudoArgs: string[]
}

/** Where the probe socket goes: beside the production socket, so the dir's owner and group apply. */
export function probeSocketPath(daemonSocket: string, id: string): string {
  const slash = daemonSocket.lastIndexOf("/")
  return `${daemonSocket.slice(0, slash)}/probe-${id}.sock`
}

/** A unix socket path must fit `sockaddr_un` (104 bytes on macOS, with the terminator). */
const MAX_SOCKET_PATH_BYTES = 103

/**
 * The installed profile with the daemon's socket swapped for the probe's. The probe broker keeps
 * every other rule of the daemon's profile, so what it proves holds for the daemon. Fails when the
 * profile does not allow exactly the daemon's socket once, or does not deny the network.
 */
export function probeProfile(
  daemonProfile: string,
  daemonSocket: string,
  probeSocket: string
): { ok: true; profile: string } | { ok: false; error: string } {
  const from = sbplString(daemonSocket)
  const parts = daemonProfile.split(from)
  if (parts.length !== 2)
    return {
      ok: false,
      error: `the parser profile does not name ${daemonSocket} exactly once`,
    }
  if (!daemonProfile.includes("(deny network*)"))
    return {
      ok: false,
      error: "the parser profile does not deny the network",
    }
  return { ok: true, profile: parts.join(sbplString(probeSocket)) }
}

export function buildParserPlan(
  input: ParserPlanInput
): { ok: true; plan: ParserPlan } | { ok: false; error: string } {
  if (!/^[0-9a-f]{16}$/.test(input.id))
    return { ok: false, error: "the probe id must be 16 hex characters" }
  const socket = probeSocketPath(input.daemonSocket, input.id)
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES)
    return { ok: false, error: `the probe socket path is too long: ${socket}` }
  const profile = probeProfile(input.daemonProfile, input.daemonSocket, socket)
  if (!profile.ok) return profile
  return {
    ok: true,
    plan: {
      user: PARSER_NAME,
      socket,
      brokerSudoArgs: [
        "-n",
        "-u",
        PARSER_NAME,
        "--",
        "/usr/bin/sandbox-exec",
        "-p",
        profile.profile,
        input.node,
        "--disable-warning=ExperimentalWarning",
        "--import",
        input.coreHooks,
        "--import",
        input.noNetwork,
        input.brokerEntry,
        "--socket",
        socket,
        "--worker",
        input.workerEntry,
      ],
    },
  }
}
