import MailComposer from "nodemailer/lib/mail-composer"
import { validateIntent } from "@eido/schemas"
import type { Intent } from "@eido/schemas"
import { BRIDGE_DESTINATIONS, bridgeDestinationFor } from "../executor"
import type {
  UpstreamResult,
  UpstreamWriter,
  WriteRequest,
  WriteTransport,
} from "../executor"
import type {
  Address,
  FoundMessage,
  OutgoingMail,
  ProtonBridge,
} from "./bridge"
import { PROTON_CONNECTOR } from "./config"
import { BridgeError } from "./errors"

// The executor's writers and transport for Proton Bridge (#195). Each approved (or auto-tier)
// intent reaches here only after createExecutor has checked its state, tier, hash, signed
// approval and pinned binding. The request body is the canonical intent itself; the transport
// re-validates it and runs exactly one adapter action:
//   email.draft                              append to Drafts (IMAP APPEND)
//   email.send, email.reply, email.forward   send from the assistant identity (SMTP)
//   email.trash                              move to Trash (IMAP UID MOVE)
// None has an inverse: sends cannot be recalled, and the executor refuses to undo a trash.

type BridgeKind = keyof typeof BRIDGE_DESTINATIONS
type BridgeIntent = Extract<Intent, { kind: BridgeKind }>

const isBridgeKind = (kind: string): kind is BridgeKind =>
  bridgeDestinationFor(kind) !== undefined
const isBridgeIntent = (intent: Intent): intent is BridgeIntent =>
  isBridgeKind(intent.kind)

const KINDS = Object.keys(BRIDGE_DESTINATIONS).filter(isBridgeKind)

function writer(kind: BridgeKind): UpstreamWriter {
  return {
    kind,
    channel: "bridge",
    buildRequest: (intent) => ({
      method: "POST",
      url: BRIDGE_DESTINATIONS[kind],
      body: intent,
    }),
    intentFromRequest: (request) => request.body,
    inverse: () => null,
  }
}

/** One writer per intent kind Bridge runs. */
export const BRIDGE_WRITERS: readonly UpstreamWriter[] = KINDS.map(writer)

function bridgeIntent(request: WriteRequest): BridgeIntent {
  const parsed: unknown = JSON.parse(request.body)
  const checked = validateIntent(parsed)
  if (
    !checked.ok ||
    !isBridgeIntent(checked.value) ||
    checked.value.kind !== request.intentKind ||
    request.connector !== PROTON_CONNECTOR ||
    request.method !== "POST" ||
    BRIDGE_DESTINATIONS[checked.value.kind] !== request.url
  ) {
    throw new BridgeError("bridge_error", "not a Bridge write request")
  }
  return checked.value
}

const lower = (address: string) => address.toLowerCase()

function addresses(list: readonly Address[]): string[] {
  return list
    .map((entry) => entry.address ?? "")
    .filter((address) => address !== "")
}

/** Recipients of a reply: Reply-To (or From), plus To and Cc for reply-all, minus the identity. */
export function replyRecipients(
  original: FoundMessage,
  replyAll: boolean,
  identity: string
): { to: string[]; cc: string[] } {
  const replyTo = addresses(original.replyTo)
  const seen = new Set([lower(identity)])
  const unique = (list: readonly string[]) =>
    list.filter((address) => {
      if (seen.has(lower(address))) return false
      seen.add(lower(address))
      return true
    })
  const to = unique(replyTo.length > 0 ? replyTo : addresses(original.from))
  if (!replyAll) return { to, cc: [] }
  const others = unique([...addresses(original.to), ...addresses(original.cc)])
  return to.length === 0 ? { to: others, cc: [] } : { to, cc: others }
}

/** The subject with `prefix` added once: "Re: x" stays "Re: x". */
export function prefixed(
  prefix: "Re" | "Fwd",
  subject: string | undefined
): string {
  const text = (subject ?? "").trim()
  const already = prefix === "Re" ? /^re:/i : /^(fwd?|fw):/i
  return already.test(text) ? text : `${prefix}: ${text}`.trim()
}

/** In-Reply-To and References that keep a reply in the original's thread. */
function threading(
  original: FoundMessage
): Pick<OutgoingMail, "inReplyTo" | "references"> {
  if (original.messageId === undefined) return {}
  return {
    inReplyTo: original.messageId,
    references: [original.references, original.messageId]
      .filter((part) => part !== undefined)
      .join(" "),
  }
}

async function original(
  bridge: ProtonBridge,
  messageId: string
): Promise<FoundMessage> {
  const found = await bridge.find(messageId)
  if (found === undefined)
    throw new BridgeError("not_found", "no such message in Bridge")
  return found
}

/** Cc and Bcc, each only when the intent has it. */
function copies(args: {
  cc?: string[]
  bcc?: string[]
}): Pick<OutgoingMail, "cc" | "bcc"> {
  return {
    ...(args.cc === undefined ? {} : { cc: args.cc }),
    ...(args.bcc === undefined ? {} : { bcc: args.bcc }),
  }
}

async function draft(
  bridge: ProtonBridge,
  intent: Extract<BridgeIntent, { kind: "email.draft" }>
): Promise<UpstreamResult> {
  const args = intent.args
  const thread =
    args.inReplyToMessageId === undefined
      ? {}
      : threading(await original(bridge, args.inReplyToMessageId))
  const node = new MailComposer({
    from: bridge.identity,
    to: args.to,
    ...copies(args),
    subject: args.subject,
    text: args.body,
    ...thread,
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile()
  // A draft keeps its Bcc header, so the person editing it sees every recipient.
  node.keepBcc = true
  const messageId = node.messageId()
  const saved = await bridge.appendDraft(await node.build())
  return {
    upstreamRef: messageId,
    result: { folder: saved.folder, uid: saved.uid },
  }
}

async function sent(
  bridge: ProtonBridge,
  mail: OutgoingMail
): Promise<UpstreamResult> {
  const { messageId } = await bridge.send(mail)
  return { upstreamRef: messageId, result: { messageId } }
}

async function run(
  bridge: ProtonBridge,
  intent: BridgeIntent
): Promise<UpstreamResult> {
  switch (intent.kind) {
    case "email.draft":
      return draft(bridge, intent)
    case "email.send": {
      const args = intent.args
      return sent(bridge, {
        to: args.to,
        ...copies(args),
        subject: args.subject,
        text: args.body,
      })
    }
    case "email.reply": {
      const found = await original(bridge, intent.args.messageId)
      const { to, cc } = replyRecipients(
        found,
        intent.args.replyAll,
        bridge.identity
      )
      if (to.length === 0)
        throw new BridgeError("bridge_error", "the reply has no recipient")
      return sent(bridge, {
        to,
        ...(cc.length === 0 ? {} : { cc }),
        subject: prefixed("Re", found.subject),
        text: intent.args.body,
        ...threading(found),
      })
    }
    case "email.forward": {
      const found = await original(bridge, intent.args.messageId)
      return sent(bridge, {
        to: intent.args.to,
        subject: prefixed("Fwd", found.subject),
        text: intent.args.note ?? "",
        // The original goes as it is, unparsed: the gate never reads message bodies.
        attachments: [
          {
            filename: "forwarded.eml",
            content: found.raw,
            contentType: "message/rfc822",
          },
        ],
      })
    }
    case "email.trash": {
      // Every message is found first, so a missing one moves nothing.
      const refs = []
      for (const id of intent.args.messageIds) {
        const ref = await bridge.locate(id)
        if (ref === undefined)
          throw new BridgeError("not_found", "no such message in Bridge")
        refs.push(ref)
      }
      const { moved } = await bridge.moveToTrash(refs)
      return { upstreamRef: null, result: { moved } }
    }
  }
}

/** The executor transport for Bridge writes: one adapter action per request. */
export function bridgeTransport(bridge: ProtonBridge): WriteTransport {
  return async (request) => run(bridge, bridgeIntent(request))
}
