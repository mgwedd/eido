// Gmail connector: read client, sync, facade and manifest. Writes are performed by the gate's
// executor (packages/gate/src/internal/gmail-writers.ts), never from here.

export { createGmailClient } from "./client"
export type {
  GmailClient,
  HistoryPage as GmailHistoryPage,
  MessagePage as GmailMessagePage,
  MessageRef as GmailMessageRef,
  Profile as GmailProfile,
  RawMessage as GmailRawMessage,
  Thread as GmailThread,
} from "./client"
export { GMAIL_DEFAULTS, resolveGmailConfig } from "./config"
export type { GmailConfig } from "./config"
export { GmailError } from "./errors"
export type { GmailErrorCode } from "./errors"
export { createGmailFacade } from "./facade"
export type {
  GmailAttachmentText,
  GmailFacade,
  GmailFacadeDeps,
  GmailForwardRequest,
  GmailReplyRequest,
  GmailIntentReceipt,
  GmailMessage,
  Untrusted as GmailUntrusted,
} from "./facade"
export {
  gmailManifest,
  gmailObservedToolNames,
  gmailPolicyFor,
} from "./manifest"
export { GMAIL_CONNECTOR, GMAIL_HOST } from "./routes"
export { syncGmail, syncGmailLabel } from "./sync"
export type { LabelSyncResult as GmailLabelSyncResult } from "./sync"
export { createEgressTransport as createGmailEgressTransport } from "./transport"
export type {
  EgressTransportOptions as GmailEgressTransportOptions,
  GmailRequest,
  GmailTransport,
} from "./transport"
