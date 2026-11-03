import { domainToASCII, domainToUnicode } from "node:url"
import { isTag, isText, type ChildNode } from "domhandler"
import { parseDocument } from "htmlparser2"
import type { MailSignal } from "../../index/mail-signals"
import { trustedAuthResults } from "./auth-results"
import { stripInvisible } from "./html-text"
import type { Mailbox } from "./parse"

// Pure checks on one parsed message: does it lie about who sent it or where a link goes. Every
// check reads untrusted input and only ever raises a signal; none blocks or rewrites the message.

export interface SignalInput {
  from: Mailbox[]
  replyTo: Mailbox[]
  /** Every Authentication-Results header, in message order, top first. */
  authenticationResults: string[]
  html?: string
}

export interface SignalOptions {
  /** Domains the owner has corresponded with; a sender domain close to one of them is flagged. */
  knownDomains?: ReadonlySet<string>
  trustedAuthservIds?: readonly string[]
}

const MAX_DETAIL = 200
const MAX_LINK_SIGNALS = 5

const domainOf = (address: string): string =>
  address
    .slice(address.lastIndexOf("@") + 1)
    .toLowerCase()
    .replace(/\.$/, "")

/** Equal, or one is a subdomain of the other: `mail.example.com` and `example.com` are one site. */
const sameSite = (a: string, b: string): boolean =>
  a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)

const ADDRESS_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi

function displayNameSignals(from: Mailbox): MailSignal[] {
  const shown = from.name?.match(ADDRESS_IN_TEXT) ?? []
  const actual = from.address.toLowerCase()
  const other = shown.find((a) => a.toLowerCase() !== actual)
  return other === undefined
    ? []
    : [{ kind: "display_name_address", detail: other.slice(0, MAX_DETAIL) }]
}

function replyToSignals(from: Mailbox, replyTo: Mailbox[]): MailSignal[] {
  const fromDomain = domainOf(from.address)
  const other = replyTo.find((r) => !sameSite(domainOf(r.address), fromDomain))
  return other === undefined
    ? []
    : [
        {
          kind: "reply_to_domain",
          detail: domainOf(other.address).slice(0, MAX_DETAIL),
        },
      ]
}

const SCRIPTS: readonly RegExp[] = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Thai}/u,
  /\p{Script=Devanagari}/u,
  // Japanese and Korean text legitimately mixes these.
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
]

const mixesScripts = (label: string): boolean =>
  SCRIPTS.filter((script) => script.test(label)).length > 1

const unicodeDomain = (domain: string): string =>
  domainToUnicode(domain) || domain

// Characters that read as another letter. Both domains go through it, so two domains that map to
// the same text are lookalikes of each other.
const CONFUSABLE: Readonly<Record<string, string>> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  і: "i",
  ѕ: "s",
  ј: "j",
  ԁ: "d",
  α: "a",
  ο: "o",
  ν: "v",
  ı: "i",
  "0": "o",
  "1": "l",
}

const skeleton = (domain: string): string =>
  [...domain]
    .map((c) => CONFUSABLE[c] ?? c)
    .join("")
    .replaceAll("rn", "m")
    .replaceAll("vv", "w")

/** One substitution, insertion, deletion or swap of neighbouring characters apart. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    const diff = [...a].flatMap((c, i) => (c === b[i] ? [] : [i]))
    if (diff.length <= 1) return true
    const [i = 0, j = 0] = diff
    return diff.length === 2 && j === i + 1 && a[i] === b[j] && a[j] === b[i]
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a]
  let i = 0
  while (i < short.length && long[i] === short[i]) i++
  return long.slice(i + 1) === short.slice(i)
}

// Short domains differ from many others by one character; a match there says nothing.
const MIN_LOOKALIKE_LENGTH = 8

function lookalikeOf(
  domain: string,
  known: ReadonlySet<string>
): string | undefined {
  if (known.has(domain)) return undefined
  const shown = unicodeDomain(domain)
  const shownSkeleton = skeleton(shown)
  for (const candidate of known) {
    if (candidate.length < MIN_LOOKALIKE_LENGTH) continue
    if (
      skeleton(candidate) === shownSkeleton ||
      withinOneEdit(shown, candidate)
    )
      return candidate
  }
  return undefined
}

function senderDomainSignals(
  domain: string,
  known: ReadonlySet<string>
): MailSignal[] {
  const signals: MailSignal[] = []
  const ascii = domainToASCII(domain) || domain
  if (ascii.split(".").some((label) => label.startsWith("xn--")))
    signals.push({ kind: "punycode_domain", detail: domain })
  if (unicodeDomain(domain).split(".").some(mixesScripts))
    signals.push({ kind: "mixed_script_domain", detail: domain })
  const lookalike = lookalikeOf(domain, known)
  if (lookalike !== undefined)
    signals.push({
      kind: "lookalike_domain",
      detail: `${domain} ~ ${lookalike}`.slice(0, MAX_DETAIL),
    })
  return signals
}

function authSignals(
  headers: string[],
  trusted: readonly string[] | undefined
): MailSignal[] {
  const results = trustedAuthResults(headers, trusted)
  if (results === undefined) return []
  const signals: MailSignal[] = []
  if (results.spf === "fail") signals.push({ kind: "spf_fail", detail: "fail" })
  if (results.dkim === "fail")
    signals.push({ kind: "dkim_fail", detail: "fail" })
  if (results.dmarc === "fail")
    signals.push({ kind: "dmarc_fail", detail: "fail" })
  return signals
}

// Text that is a URL or a bare domain, so a reader takes it for where the link goes.
const URL_TEXT =
  /^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d+)?(?:[/?#]\S*)?$/i

function hostOf(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.hostname.replace(/\.$/, "").replace(/^www\./, "")
      : undefined
  } catch {
    return undefined
  }
}

function textOf(nodes: ChildNode[]): string {
  return nodes
    .map((node) =>
      isText(node) ? node.data : isTag(node) ? textOf(node.children) : ""
    )
    .join("")
}

function anchors(nodes: ChildNode[]): { text: string; href: string }[] {
  return nodes.flatMap((node) => {
    if (!isTag(node)) return []
    const href = node.attribs["href"]
    const own =
      node.name === "a" && href !== undefined
        ? [{ text: textOf(node.children), href }]
        : []
    return [...own, ...anchors(node.children)]
  })
}

function linkSignals(html: string): MailSignal[] {
  const found = new Set<string>()
  for (const { text, href } of anchors(parseDocument(html).children)) {
    const shown = URL_TEXT.exec(stripInvisible(text).trim())?.[1]
    const target = hostOf(href.trim())
    if (shown === undefined || target === undefined) continue
    const shownHost = hostOf(`http://${shown}`)
    if (shownHost !== undefined && !sameSite(shownHost, target))
      found.add(`${shownHost} -> ${target}`.slice(0, MAX_DETAIL))
  }
  return [...found]
    .slice(0, MAX_LINK_SIGNALS)
    .map((detail): MailSignal => ({ kind: "link_mismatch", detail }))
}

export function computeMailSignals(
  message: SignalInput,
  options: SignalOptions = {}
): MailSignal[] {
  const from = message.from[0]
  return [
    ...authSignals(message.authenticationResults, options.trustedAuthservIds),
    ...(from === undefined
      ? []
      : [
          ...displayNameSignals(from),
          ...replyToSignals(from, message.replyTo),
          ...senderDomainSignals(
            domainOf(from.address),
            options.knownDomains ?? new Set()
          ),
        ]),
    ...(message.html === undefined ? [] : linkSignals(message.html)),
  ]
}
