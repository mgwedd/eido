// @vitest-environment happy-dom
import { DraftReplyAction } from "../components/draft-reply-action"
import { ResolveAction } from "../components/resolve-action"
import type { DraftReplyState, ResolveState } from "../lib/replies"
import { describeStates, type StateCase } from "./render-states"

const idle = (overrides: {
  state?: DraftReplyState
  hasDraftIntent?: boolean
  isOffline?: boolean
}): StateCase["render"] => {
  return () => (
    <DraftReplyAction
      state={overrides.state}
      hasDraftIntent={overrides.hasDraftIntent ?? false}
      isOffline={overrides.isOffline ?? false}
      size="desktop"
      onDraft={() => undefined}
    />
  )
}

const failed = (
  state: string,
  reason: Extract<DraftReplyState, { status: "failed" }>["reason"],
  message: string
): StateCase => ({
  state,
  render: idle({ state: { status: "failed", reason } }),
  role: "alert",
  message,
})

describeStates("Draft reply row states", [
  { state: "idle", render: idle({}), role: "status", message: null },
  {
    state: "pending",
    render: idle({ state: { status: "pending" } }),
    role: "status",
    message: "Drafting reply…",
  },
  {
    state: "saved from the POST response",
    render: idle({
      state: { status: "saved", activityHref: "/activity?intent=intent-9" },
    }),
    role: "status",
    message: "Draft saved",
  },
  {
    state: "saved, from the list's hasDraftIntent",
    render: idle({ hasDraftIntent: true }),
    role: "status",
    message: "Draft saved",
  },
  {
    state: "offline",
    render: idle({ isOffline: true }),
    role: "status",
    message: "Unavailable offline",
  },
  failed(
    "error: connector_paused",
    "connector_paused",
    "Mail connector paused. Nothing was drafted. Open Connectors"
  ),
  failed(
    "error: no_draft",
    "no_draft",
    "Eido could not write a draft for this thread. Try again."
  ),
  failed("error: busy", "busy", "Too many drafts this hour. Try again later."),
  failed(
    "error: gate_unavailable",
    "gate_unavailable",
    "Gate unreachable. Nothing was saved. Try again."
  ),
  failed(
    "error: invalid_transition",
    "invalid_transition",
    "This reply is no longer open. Reload the page."
  ),
  failed(
    "error: invalid",
    "invalid",
    "This thread cannot be drafted from here."
  ),
  failed(
    "error: not_found (also the route absent without a local model)",
    "not_found",
    "Cannot draft this reply: it may be gone, or no local model is set up."
  ),
  failed(
    "error: unauthenticated",
    "unauthenticated",
    "Sign in again to draft a reply."
  ),
  failed(
    "error: network",
    "network",
    "Connection lost. Nothing was saved. Try again."
  ),
  failed(
    "error: unreadable response",
    "unreadable",
    "Draft failed. Nothing was saved. Try again."
  ),
])

const resolveRow = (overrides: {
  state?: ResolveState
  isOffline?: boolean
}): StateCase["render"] => {
  return () => (
    <ResolveAction
      state={overrides.state}
      isOffline={overrides.isOffline ?? false}
      size="desktop"
      onResolve={() => undefined}
    />
  )
}

const resolveFailed = (
  state: string,
  reason: Extract<ResolveState, { status: "failed" }>["reason"],
  message: string
): StateCase => ({
  state,
  render: resolveRow({ state: { status: "failed", reason } }),
  role: "alert",
  message,
})

describeStates("Mark resolved row states", [
  { state: "idle", render: resolveRow({}), role: "status", message: null },
  {
    state: "pending",
    render: resolveRow({ state: { status: "pending" } }),
    role: "status",
    message: "Marking resolved…",
  },
  {
    state: "offline",
    render: resolveRow({ isOffline: true }),
    role: "status",
    message: "Unavailable offline",
  },
  resolveFailed(
    "error: not_found",
    "not_found",
    "This thread is gone. Reload the page."
  ),
  resolveFailed(
    "error: invalid_transition",
    "invalid_transition",
    "This thread is no longer open. Reload the page."
  ),
  resolveFailed(
    "error: unauthenticated",
    "unauthenticated",
    "Sign in again to mark this resolved."
  ),
  resolveFailed(
    "error: network",
    "network",
    "Connection lost. Nothing was changed. Try again."
  ),
  resolveFailed(
    "error: unreadable response",
    "unreadable",
    "Could not mark this resolved. Nothing was changed. Try again."
  ),
])
