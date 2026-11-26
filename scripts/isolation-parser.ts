// The parser half of the live isolation check (#820): targets, reports and outcome classification,
// pure functions only so they are unit-tested without a Mac, users or sudo. It imports nothing but
// Node, because the parse child loads it too. The plan that starts the probe broker is
// `isolation-parser-plan.ts`; `check-isolation-live.ts` runs both.
//
// The probe goes through the production path (#817, #818): a probe parse job is sent over a broker
// socket to a broker running as `_eidoparse` under `parser.sb`, and the broker starts the parse
// child. The child tries to reach one target; its report comes back as the parse result's text.
/** The result of one probe run: reached or refused, or not run at all. */
export type ParserProbeResult =
  { ran: true; reached: boolean; code: string } | { ran: false; code: string }

/** An error code safe to print: an errno-style name, or "error". Never a message or a value. */
export function safeCode(value: unknown): string {
  const code =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "code" in value
        ? value.code
        : undefined
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code)
    ? code
    : "error"
}

/** What a parse child is asked to reach. */
export type ParserTarget =
  | { kind: "tcp"; host: string; port: number; timeoutMs: number }
  | { kind: "unix"; path: string; timeoutMs: number }
  | { kind: "file"; path: string }

/** Every probe that sends its target through the broker. */
export const PARSER_PROBE_NAMES = [
  "parser-loopback",
  "parser-proxy",
  "parser-llama",
  "parser-intent-socket",
  "parser-data-db",
] as const

export type ParserProbeName = (typeof PARSER_PROBE_NAMES)[number]

export function isParserProbeName(value: unknown): value is ParserProbeName {
  return PARSER_PROBE_NAMES.some((name) => name === value)
}

/** The fields of a probe spec that name a target. */
export type ParserTargetFields = {
  host?: string
  port?: number
  path?: string
  timeoutMs: number
}

/** The target one broker probe sends; undefined when the spec lacks what the probe needs. */
export function parserTargetOf(
  name: ParserProbeName,
  fields: ParserTargetFields
): ParserTarget | undefined {
  const { host, port, path, timeoutMs } = fields
  switch (name) {
    case "parser-loopback":
    case "parser-proxy":
    case "parser-llama":
      return host === undefined || port === undefined
        ? undefined
        : { kind: "tcp", host, port, timeoutMs }
    case "parser-intent-socket":
      return path === undefined ? undefined : { kind: "unix", path, timeoutMs }
    case "parser-data-db":
      return path === undefined ? undefined : { kind: "file", path }
  }
}

/**
 * Reads a target from the probe document the child gets; undefined when it is not one. The
 * document is parsed in the parse child, which trusts nothing it is handed.
 */
export function readParserTarget(text: string): ParserTarget | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const field = (name: string): unknown =>
    name in value ? Reflect.get(value, name) : undefined
  const kind = field("kind")
  const timeoutMs = field("timeoutMs")
  const path = field("path")
  if (kind === "file")
    return typeof path === "string" ? { kind, path } : undefined
  if (typeof timeoutMs !== "number") return undefined
  if (kind === "unix")
    return typeof path === "string" ? { kind, path, timeoutMs } : undefined
  const host = field("host")
  const port = field("port")
  return kind === "tcp" && typeof host === "string" && typeof port === "number"
    ? { kind, host, port, timeoutMs }
    : undefined
}

/** The probe document: the bytes the delivery side sends as the one document to parse. */
export function parserProbeDocument(target: ParserTarget): Buffer {
  return Buffer.from(JSON.stringify(target), "utf8")
}

/** The MIME type the probe document is sent as; the probe worker does not sniff it. */
export const PARSER_PROBE_MIME = "text/plain"

// ---- outcomes --------------------------------------------------------------------------------

/** What the parse child reports: the target's kind, and whether it got through. */
export type AttemptReport = {
  kind: ParserTarget["kind"]
  reached: boolean
  code: string
}

/** Reads the report the child wrote; undefined when the text is not one. */
export function readAttemptReport(text: string): AttemptReport | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const kind: unknown = "kind" in value ? value.kind : undefined
  const reached: unknown = "reached" in value ? value.reached : undefined
  const code: unknown = "code" in value ? value.code : undefined
  if (
    (kind !== "tcp" && kind !== "unix" && kind !== "file") ||
    typeof reached !== "boolean" ||
    typeof code !== "string"
  )
    return undefined
  return { kind, reached, code: safeCode(code) }
}

/**
 * Classifies what came back over the broker socket for one probe. The answer is the broker's
 * parse result, untrusted like the child that made it:
 * - the parse did not succeed, or its text is not a report for this target: not run (an error);
 * - the child connected or opened the target: reached, so a blocked probe fails;
 * - the child was refused: blocked, with the errno name the child saw.
 */
export function classifyParserAnswer(
  answer: unknown,
  target: ParserTarget
): ParserProbeResult {
  if (typeof answer !== "object" || answer === null)
    return { ran: false, code: "NO_ANSWER" }
  if (!("ok" in answer)) return { ran: false, code: "NO_ANSWER" }
  if (answer.ok !== true) {
    const reason = "reason" in answer ? answer.reason : undefined
    return {
      ran: false,
      code:
        typeof reason === "string" && /^[a-z_]{1,20}$/.test(reason)
          ? `PARSE_${reason.toUpperCase()}`
          : "PARSE_FAILED",
    }
  }
  const text = "text" in answer ? answer.text : undefined
  if (typeof text !== "string") return { ran: false, code: "NO_REPORT" }
  const report = readAttemptReport(text)
  if (report === undefined) return { ran: false, code: "BAD_REPORT" }
  if (report.kind !== target.kind) return { ran: false, code: "BAD_REPORT" }
  return report.reached
    ? { ran: true, reached: true, code: "OK" }
    : { ran: true, reached: false, code: report.code }
}
