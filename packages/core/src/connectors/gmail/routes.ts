// Every Gmail endpoint this connector names. The read client builds its URLs from READ_PATHS and
// the manifest pins the same templates, so the egress proxy allows exactly what the client sends.

/** Connector name in the gate (the egress proxy header and the pinned manifest). */
export const GMAIL_CONNECTOR = "gmail"
/** `source` of every indexed Gmail document, and the connector name in the `cursors` table. */
export const GMAIL_SOURCE = "gmail"
export const GMAIL_HOST = "gmail.googleapis.com"
/** Google's OAuth token endpoint, reached only by the gate to refresh access tokens. */
export const GOOGLE_OAUTH_HOST = "oauth2.googleapis.com"

export const SCOPE_READONLY = "https://www.googleapis.com/auth/gmail.readonly"
/** Drafts, labels, archive, read flag, send and trash. It cannot delete a message permanently. */
export const SCOPE_MODIFY = "https://www.googleapis.com/auth/gmail.modify"

const USER = "/gmail/v1/users/me"

export const READ_PATHS = {
  profile: `${USER}/profile`,
  messages: `${USER}/messages`,
  message: `${USER}/messages/{id}`,
  thread: `${USER}/threads/{id}`,
  history: `${USER}/history`,
} as const

/** Write endpoints pinned for the gate's approved Gmail API calls. */
export const WRITE_PATHS = {
  batchModify: `${USER}/messages/batchModify`,
  messageSend: `${USER}/messages/send`,
} as const

export const GMAIL_PATH_PREFIX = USER
