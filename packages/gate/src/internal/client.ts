import type {
  GateFileRoots,
  GateLocalFileRequest,
  GateFileHelperResponse,
} from "@eido/schemas"
import { request as httpRequest } from "node:http"
import {
  validateGateApiError,
  validateGateFileRoots,
  validateGateFileHelperResponse,
  validateGateAuditRecordResult,
  validateGateConnectorHealth,
  validateGateEnrolmentCode,
  validateGateIntentHistory,
  validateGateIntentStatus,
  validateGateMailFolderList,
  validateGateMailFolderState,
  validateGateMailMessagePage,
  validateGatePasskeyList,
  validateGatePendingIntentList,
  validateGateProposeRefusal,
  validateGateProposeResult,
  validateGateThingsAreaList,
  validateGateThingsProjectItem,
  validateGateThingsProjectList,
  validateGateThingsTagList,
  validateGateThingsTodoItem,
  validateGateThingsTodoList,
} from "@eido/schemas"
import type {
  GateAuditRecordRequest,
  GateAuditRecordResult,
  GateConnectorHealth,
  GateEnrolmentCode,
  GateIntentHistory,
  GateIntentProposal,
  GateIntentStatus,
  GateMailFolderState,
  GatePasskeyList,
  GatePendingIntentList,
  GateProposeResult,
  GateThingsAreaItem,
  GateThingsProjectItem,
  GateThingsTodoItem,
  ValidationResult,
} from "@eido/schemas"

// The data plane's only way into the gate: HTTP over the gate's data-plane socket. Every
// response is parsed with its schema; nothing is cast. When the gate cannot be reached the
// call rejects with GateUnavailableError: nothing is queued and nothing silently succeeds.

/** The gate could not be reached (socket missing, refused, or no answer in time). */
export class GateUnavailableError extends Error {
  override readonly name = "GateUnavailableError"
}

/** The gate answered and refused the request, or answered with a body outside the contract. */
export class GateRequestError extends Error {
  override readonly name = "GateRequestError"
  readonly status: number
  readonly code: string
  /** Field paths and reasons for a 422 invalid_payload; never payload values. */
  readonly errors: readonly string[]
  // Plain fields, not parameter properties: Node runs this file with type stripping only.
  constructor(
    status: number,
    code: string,
    message: string,
    errors: readonly string[] = []
  ) {
    super(message)
    this.status = status
    this.code = code
    this.errors = errors
  }
}

export type IntentClientOptions = {
  socketPath: string
  /** Per-call limit; default 2 s. */
  timeoutMs?: number
}

/**
 * A GateIntentProposal whose intent may be a typed Intent or unchecked model output; the gate
 * validates it either way.
 */
export type IntentProposal = Omit<GateIntentProposal, "intent"> & {
  intent: object
}

export type IntentClient = {
  /** Resolves for a stored intent, including one policy refused (state rejected). */
  propose: (proposal: IntentProposal) => Promise<GateProposeResult>
  /** Creates a fresh approval-tier restore proposal from an executed Gmail trash receipt. */
  restoreTrash: (trashIntentId: string) => Promise<GateProposeResult>
  status: (id: string) => Promise<GateIntentStatus>
  history: (id: string) => Promise<GateIntentHistory["entries"]>
  listPending: () => Promise<GatePendingIntentList["intents"]>
  /** Health projection from the gate's control database; contains no manifests or secrets. */
  getConnectorHealth: () => Promise<GateConnectorHealth["connectors"]>
}

export type AuditClient = {
  /**
   * Appends one hash-only audit.profile.* (#181), audit.ledger.* (#104) or audit.access.* (#322) row to the gate's
   * audit log. Resolves once the row is written; rejects with GateRequestError when the gate refuses the entry and with
   * GateUnavailableError when the gate cannot be reached, so the caller can roll back.
   */
  record: (entry: GateAuditRecordRequest) => Promise<GateAuditRecordResult>
}

type Answer = { status: number; body: unknown }

const DEFAULT_TIMEOUT_MS = 2000

function call(
  options: Required<IntentClientOptions>,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Answer> {
  const text = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const unavailable = () =>
      reject(new GateUnavailableError("the gate is not reachable"))
    const request = httpRequest(
      {
        socketPath: options.socketPath,
        path,
        method,
        signal: AbortSignal.timeout(options.timeoutMs),
        headers:
          text === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(text),
              },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("error", unavailable)
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8")
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = undefined
          }
          resolve({ status: response.statusCode ?? 0, body: parsed })
        })
      }
    )
    request.on("error", unavailable)
    request.end(text)
  })
}

function badResponse(status: number, what: string): GateRequestError {
  return new GateRequestError(
    status,
    "bad_response",
    `the gate's response is not a ${what}`
  )
}

function refusal(answer: Answer): GateRequestError {
  const error = validateGateApiError(answer.body)
  return error.ok
    ? new GateRequestError(answer.status, error.value.code, error.value.message)
    : badResponse(answer.status, "GateApiError")
}

function expect<T>(
  answer: Answer,
  statuses: readonly number[],
  validate: (value: unknown) => ValidationResult<T>,
  what: string
): T {
  if (!statuses.includes(answer.status)) throw refusal(answer)
  const result = validate(answer.body)
  if (!result.ok) throw badResponse(answer.status, what)
  return result.value
}

const intentPath = (id: string) => `/intents/${encodeURIComponent(id)}`

/** A client for the gate's data-plane listener at `socketPath`. */
export function createIntentClient(options: IntentClientOptions): IntentClient {
  const resolved = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  return {
    propose: async (proposal) => {
      const answer = await call(resolved, "POST", "/intents", proposal)
      if (answer.status === 422) {
        const refused = validateGateProposeRefusal(answer.body)
        if (!refused.ok) throw badResponse(422, "GateProposeRefusal")
        throw new GateRequestError(
          422,
          refused.value.code,
          "the intent does not match its schema",
          refused.value.errors
        )
      }
      return expect(
        answer,
        [201, 403],
        validateGateProposeResult,
        "GateProposeResult"
      )
    },
    restoreTrash: async (trashIntentId) =>
      expect(
        await call(
          resolved,
          "POST",
          `${intentPath(trashIntentId)}/restore`,
          {}
        ),
        [201],
        validateGateProposeResult,
        "GateProposeResult"
      ),
    status: async (id) =>
      expect(
        await call(resolved, "GET", intentPath(id)),
        [200],
        validateGateIntentStatus,
        "GateIntentStatus"
      ),
    history: async (id) =>
      expect(
        await call(resolved, "GET", `${intentPath(id)}/history`),
        [200],
        validateGateIntentHistory,
        "GateIntentHistory"
      ).entries,
    listPending: async () =>
      expect(
        await call(resolved, "GET", "/intents?state=pending"),
        [200],
        validateGatePendingIntentList,
        "GatePendingIntentList"
      ).intents,
    getConnectorHealth: async () =>
      expect(
        await call(resolved, "GET", "/connector-health"),
        [200],
        validateGateConnectorHealth,
        "GateConnectorHealth"
      ).connectors,
  }
}

/** A client for POST /audit on the gate's data-plane listener at `socketPath`. */
export function createAuditClient(options: IntentClientOptions): AuditClient {
  const resolved = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  return {
    record: async (entry) =>
      expect(
        await call(resolved, "POST", "/audit", entry),
        [201],
        validateGateAuditRecordResult,
        "GateAuditRecordResult"
      ),
  }
}

/**
 * Core's view of Proton mail through the gate (#195): it matches core's ProtonMailSource. A call
 * rejects with GateRequestError whose `code` is handshake_failed or auth_failed when Bridge
 * refused the connection or the password, with GateRequestError status 503 and code
 * `unavailable` when the gate is already reading mail (wait before asking again; the gate sends
 * Retry-After), and with GateUnavailableError when the gate cannot be reached.
 */
export type ProtonMailClient = {
  listFolders: () => Promise<string[]>
  folderState: (folder: string) => Promise<GateMailFolderState>
  /** Raw messages and UIDs skipped for size; the gate caps `limit` at 100. */
  fetchRaw: (
    folder: string,
    fromUid: number,
    limit: number
  ) => Promise<{
    messages: { uid: number; raw: Uint8Array }[]
    skipped: number[]
  }>
}

// A page can carry 32 MiB that Bridge has to read first; the other calls answer quickly.
const FETCH_TIMEOUT_MS = 60_000

const folderPath = (folder: string) =>
  `/mail/proton/folders/${encodeURIComponent(folder)}`

/** A client for the Proton mail read routes on the gate's data-plane listener at `socketPath`. */
export function createProtonMailClient(
  options: IntentClientOptions
): ProtonMailClient {
  const quick = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const slow = {
    socketPath: options.socketPath,
    timeoutMs: Math.max(quick.timeoutMs, FETCH_TIMEOUT_MS),
  }
  return {
    listFolders: async () =>
      expect(
        await call(quick, "GET", "/mail/proton/folders"),
        [200],
        validateGateMailFolderList,
        "GateMailFolderList"
      ).folders,
    folderState: async (folder) =>
      expect(
        await call(quick, "GET", `${folderPath(folder)}/state`),
        [200],
        validateGateMailFolderState,
        "GateMailFolderState"
      ),
    fetchRaw: async (folder, fromUid, limit) => {
      const query = new URLSearchParams({
        fromUid: String(fromUid),
        limit: String(limit),
      })
      const page = expect(
        await call(
          slow,
          "GET",
          `${folderPath(folder)}/messages?${query.toString()}`
        ),
        [200],
        validateGateMailMessagePage,
        "GateMailMessagePage"
      )
      return {
        messages: page.messages.map((message) => ({
          uid: message.uid,
          raw: new Uint8Array(Buffer.from(message.raw, "base64")),
        })),
        skipped: page.skipped,
      }
    },
  }
}

export interface ThingsClient {
  listTodos: (listName: string) => Promise<GateThingsTodoItem[]>
  listByDeadline: (daysAhead: number) => Promise<GateThingsTodoItem[]>
  getItem: (id: string) => Promise<GateThingsTodoItem | GateThingsProjectItem>
  listProjects: (area?: string) => Promise<GateThingsProjectItem[]>
  listAreas: () => Promise<GateThingsAreaItem[]>
  listTags: () => Promise<string[]>
}

/** A client for the Things read routes on the gate's data-plane listener at `socketPath`. */
export function createThingsClient(options: IntentClientOptions): ThingsClient {
  const quick = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  return {
    listTodos: async (listName: string) =>
      expect(
        await call(
          quick,
          "GET",
          `/things/lists/${encodeURIComponent(listName)}`
        ),
        [200],
        validateGateThingsTodoList,
        "GateThingsTodoList"
      ).items,
    listByDeadline: async (daysAhead: number) =>
      expect(
        await call(
          quick,
          "GET",
          `/things/lists/deadline?daysAhead=${encodeURIComponent(String(daysAhead))}`
        ),
        [200],
        validateGateThingsTodoList,
        "GateThingsTodoList"
      ).items,
    getItem: async (id: string) =>
      expect(
        await call(quick, "GET", `/things/items/${encodeURIComponent(id)}`),
        [200],
        (val): ValidationResult<GateThingsTodoItem | GateThingsProjectItem> => {
          const todoCheck = validateGateThingsTodoItem(val)
          if (todoCheck.ok) return todoCheck
          const projCheck = validateGateThingsProjectItem(val)
          if (projCheck.ok) return projCheck
          return {
            ok: false,
            errors: [...todoCheck.errors, ...projCheck.errors],
          }
        },
        "GateThingsTodoItem | GateThingsProjectItem"
      ),
    listProjects: async (area?: string) =>
      expect(
        await call(
          quick,
          "GET",
          `/things/projects${area ? `?area=${encodeURIComponent(area)}` : ""}`
        ),
        [200],
        validateGateThingsProjectList,
        "GateThingsProjectList"
      ).projects,
    listAreas: async () =>
      expect(
        await call(quick, "GET", "/things/areas"),
        [200],
        validateGateThingsAreaList,
        "GateThingsAreaList"
      ).areas,
    listTags: async () =>
      expect(
        await call(quick, "GET", "/things/tags"),
        [200],
        validateGateThingsTagList,
        "GateThingsTagList"
      ).tags,
  }
}

/**
 * The owner's client for the gate's control socket (#78), used by the Mac-side `enrol-code`
 * command. The control socket is readable by the gate user only; core never gets this client.
 */
export function createEnrolmentClient(options: IntentClientOptions): {
  issueCode: () => Promise<GateEnrolmentCode>
} {
  const resolved = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  return {
    issueCode: async () =>
      expect(
        await call(resolved, "POST", "/enrolment-codes"),
        [201],
        validateGateEnrolmentCode,
        "GateEnrolmentCode"
      ),
  }
}

/**
 * The owner's passkey client for the control socket (#419), used by the Mac-side `passkeys`
 * command. Revoking a passkey signs its phone out; the phone listener has no revoke route.
 */
export function createPasskeyAdminClient(options: IntentClientOptions): {
  list: () => Promise<GatePasskeyList>
  revoke: (fingerprint: string) => Promise<GatePasskeyList>
} {
  const resolved = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  return {
    list: async () =>
      expect(
        await call(resolved, "GET", "/passkeys"),
        [200],
        validateGatePasskeyList,
        "GatePasskeyList"
      ),
    revoke: async (fingerprint) =>
      expect(
        await call(resolved, "POST", "/passkeys/revoke", { fingerprint }),
        [200],
        validateGatePasskeyList,
        "GatePasskeyList"
      ),
  }
}

/** How long the gate may take to check a connector after a connect: a refresh and one read. */
const CONNECT_CHECK_TIMEOUT_MS = 60_000

/**
 * The `connect` command's client for the control socket (#98): connector health, and the check
 * the gate runs once a new credential is in the vault.
 */
export function createConnectClient(options: IntentClientOptions): {
  health: () => Promise<GateConnectorHealth>
  connected: (connector: string) => Promise<GateConnectorHealth>
} {
  const quick = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const slow = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? CONNECT_CHECK_TIMEOUT_MS,
  }
  return {
    health: async () =>
      expect(
        await call(quick, "GET", "/connector-health"),
        [200],
        validateGateConnectorHealth,
        "GateConnectorHealth"
      ),
    connected: async (connector) =>
      expect(
        await call(
          slow,
          "POST",
          `/connectors/${encodeURIComponent(connector)}/connected`
        ),
        [200],
        validateGateConnectorHealth,
        "GateConnectorHealth"
      ),
  }
}

export type FileClient = {
  roots(): Promise<GateFileRoots>
  perform(request: GateLocalFileRequest): Promise<GateFileHelperResponse>
}

export function createFileClient(options: IntentClientOptions): FileClient {
  const resolved = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? 30_000,
  }
  return {
    roots: async () =>
      expect(
        await call(resolved, "GET", "/file-roots"),
        [200],
        validateGateFileRoots,
        "GateFileRoots"
      ),
    perform: async (request) =>
      expect(
        await call(resolved, "POST", "/files", request),
        [200],
        validateGateFileHelperResponse,
        "GateFileHelperResponse"
      ),
  }
}
