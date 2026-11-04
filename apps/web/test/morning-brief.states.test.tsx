// @vitest-environment happy-dom
import { MorningBriefCard } from "../components/morning-brief-card"
import { NOW, briefWith } from "./fixtures/today"
import { describeStates } from "./render-states"

const card = (state: Parameters<typeof MorningBriefCard>[0]["state"]) => () => (
  <MorningBriefCard state={state} now={NOW} onRetry={() => undefined} />
)

describeStates("Today: morning brief", [
  {
    state: "loading",
    render: card({ status: "loading" }),
    role: "status",
    message: "Loading morning brief…",
  },
  {
    state: "empty",
    render: card({ status: "empty" }),
    role: "status",
    message: "No brief yet.",
  },
  {
    state: "error",
    render: card({ status: "error" }),
    role: "alert",
    message: "Couldn't load morning brief.",
  },
  {
    // The Deferred label heads the list; its own region, not a live one.
    state: "deferred lines",
    render: card({
      status: "ready",
      brief: briefWith([
        {
          kind: "deferred",
          text: "Sed do eiusmod tempor (Incididunt)",
          ledger: { type: "obligation", id: "42" },
        },
      ]),
    }),
    role: "status",
    selector: "section[aria-labelledby='morning-brief-deferred-heading'] h3",
    message: "Deferred",
  },
])
