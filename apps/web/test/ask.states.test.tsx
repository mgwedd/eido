// @vitest-environment happy-dom
import {
  AskScreen,
  type AskState,
  type ProposalState,
} from "../components/ask-view"
import { answered, noMatch, refused, truncated } from "./fixtures/ask"
import { describeStates } from "./render-states"

function render(
  state: AskState,
  proposals: Record<number, ProposalState> = {}
) {
  return (
    <AskScreen
      state={state}
      proposals={proposals}
      input=""
      busy={state.status === "running"}
      onInput={() => {}}
      onSubmit={() => {}}
      onRetry={() => {}}
      onPropose={() => {}}
      onOpenSearch={() => {}}
    />
  )
}
describeStates("Ask designed states", [
  {
    state: "idle",
    render: () => render({ status: "idle" }),
    role: "status",
    message: "Ask about your mail, calendar and files.",
  },
  {
    state: "running",
    render: () => render({ status: "running", question: "Find invoice" }),
    role: "status",
    message: "Reading your mail…",
  },
  {
    state: "answered",
    render: () =>
      render({ status: "ready", question: "Find invoice", result: answered }),
    role: "status",
    message: "read 1 of 12 matching messages in full",
  },
  {
    state: "no match",
    render: () =>
      render({ status: "ready", question: "Find late fee", result: noMatch }),
    role: "status",
    message: "read 0 of 0 matching messages in full",
  },
  {
    state: "refused",
    render: () =>
      render({ status: "ready", question: "Find late fee", result: refused }),
    role: "status",
    message: "read 0 of 0 matching messages in full",
  },
  {
    state: "possibly truncated",
    render: () =>
      render({ status: "ready", question: "Find invoice", result: truncated }),
    role: "alert",
    message:
      "The model may not have read all supplied context. Treat this answer with caution.",
  },
  {
    state: "error / core unreachable",
    render: () => render({ status: "error", question: "Find invoice" }),
    role: "alert",
    message:
      "Ask could not reach the local model. Check the Mac and try again.Retry",
  },
  {
    state: "follow-up proposing",
    selector: '[aria-label="Follow-up proposals"] [role="status"]',
    render: () =>
      render(
        { status: "ready", question: "Find invoice", result: answered },
        { 0: { status: "proposing" } }
      ),
    role: "status",
    message: "Proposing…",
  },
  {
    state: "follow-up proposed",
    selector: '[aria-label="Follow-up proposals"] [role="status"]',
    render: () =>
      render(
        { status: "ready", question: "Find invoice", result: answered },
        { 0: { status: "proposed", href: "/queue" } }
      ),
    role: "status",
    message: "Proposed Open Queue",
  },
  {
    state: "follow-up failed",
    render: () =>
      render(
        { status: "ready", question: "Find invoice", result: answered },
        { 0: { status: "error" } }
      ),
    role: "alert",
    message:
      "Could not confirm the proposal. Check Activity before trying again.",
  },
])
