export { DEFAULTS, resolveConfig } from "./config"
export type { ProtonConfig } from "./config"
export {
  AuthFailedError,
  BusyError,
  GateUnavailableMailError,
  HandshakeFailedError,
  ProtonError,
  toProtonError,
} from "./errors"
export type { ProtonErrorCode } from "./errors"
export { createProtonFacade } from "./facade"
export type {
  AttachmentTextResult,
  IntentReceipt,
  MailDocument,
  ProtonFacade,
  ProtonFacadeDeps,
  ForwardRequest,
  ReplyRequest,
} from "./facade"
export {
  CONNECTOR_NAME,
  observedToolNames,
  policyFor,
  protonManifest,
} from "./manifest"
export { attachmentText, isTextMime, parseMessage } from "../mail/parse"
export type { Mailbox, ParsedAttachment, ParsedMessage } from "../mail/parse"
export { callSource } from "./source"
export type { ProtonMailSource } from "./source"
export { CONNECTOR, syncFolder, syncProton, syncProtonWithHealth } from "./sync"
export type { FolderSyncResult } from "./sync"
