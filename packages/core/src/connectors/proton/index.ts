export { BRIDGE_DEFAULTS, resolveConfig } from "./config"
export type { ProtonConfig, TlsMode } from "./config"
export { endpointFor, openSocket } from "./connection"
export type {
  AuthSession,
  Connection,
  ConnectionFactory,
  Endpoint,
  Reply,
  Socket,
} from "./connection"
export { AuthFailedError, HandshakeFailedError, ProtonError } from "./errors"
export type { ProtonErrorCode } from "./errors"
export { ImapClient, connectImap } from "./imap-client"
export type { FetchedMessage, FolderState } from "./imap-client"
export { createProtonFacade } from "./facade"
export type {
  AttachmentTextResult,
  IntentReceipt,
  MailDocument,
  ProtonFacade,
  ProtonFacadeDeps,
} from "./facade"
export {
  CONNECTOR_NAME,
  observedToolNames,
  policyFor,
  protonManifest,
} from "./manifest"
export { buildMessage, parseMessage } from "./mime"
export { sendMail } from "./smtp-client"
export type { SendRequest, SendResult } from "./smtp-client"
export { CONNECTOR, syncFolder } from "./sync"
export type { FolderSyncResult } from "./sync"
