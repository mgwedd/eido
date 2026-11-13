// @vitest-environment happy-dom
import { DoneAutomaticallyCard } from "../components/done-automatically-card"
import { entry } from "./fixtures/activity"
import { describeStates } from "./render-states"

const noop = () => undefined
const card =
  (state: Parameters<typeof DoneAutomaticallyCard>[0]["state"]) => () => (
    <DoneAutomaticallyCard
      state={state}
      onRetry={noop}
      onUndoSettled={noop}
      onSignedOut={noop}
    />
  )

const auto = (seq: number, undo: "available" | "done") =>
  entry(seq, {
    displayActor: "auto",
    actor: "policy",
    action: "email.markRead",
    undo,
  })

describeStates("Today: done automatically", [
  {
    state: "loading",
    render: card({ status: "loading" }),
    role: "status",
    message: "Loading automatic actions…",
  },
  {
    state: "empty",
    render: card({ status: "ready", entries: [] }),
    role: "status",
    message: "Nothing done automatically yet.",
  },
  {
    state: "empty (only actions with no undo)",
    render: card({
      status: "ready",
      entries: [entry(3, { displayActor: "auto", undo: "none" })],
    }),
    role: "status",
    message: "Nothing done automatically yet.",
  },
  {
    state: "populated, undone",
    render: card({ status: "ready", entries: [auto(2, "done")] }),
    role: "status",
    message: "Undone",
  },
  {
    state: "error",
    render: card({ status: "error" }),
    role: "alert",
    message: "Couldn't load automatic actions.",
  },
])
