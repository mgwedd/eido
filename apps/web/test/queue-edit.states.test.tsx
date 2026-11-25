// @vitest-environment happy-dom
import { QueueEditForm } from "../components/queue-edit-sheet"
import { type EditRefusal, editRefusal } from "../lib/queue/edit"
import { describeStates } from "./render-states"

const PAYLOAD = JSON.stringify({
  kind: "email.send",
  args: {
    to: ["x@example.invalid"],
    subject: "Lorem ipsum",
    body: "Dolor sit amet",
  },
})

const form = (busy: boolean, refusal: EditRefusal | null) => () => (
  <QueueEditForm
    intentId="intent-a"
    payload={PAYLOAD}
    busy={busy}
    refusal={refusal}
    onSubmit={() => undefined}
    onCancel={() => undefined}
  />
)

// One row per editor state on the Queue design's Edit before approving board that has a live
// region. Pristine and changed have none; queue-edit-flow.test.tsx covers them.
describeStates("queue edit before approving", [
  {
    state: "signing",
    render: form(true, null),
    role: "status",
    message: "Waiting for your passkey",
  },
  {
    state: "refused, tier changed",
    render: form(
      false,
      editRefusal({ code: "tier_changed", message: "tier would change" })
    ),
    role: "alert",
    message:
      "This change moves the request to a different approval tier, so it was not saved. Reject it and ask again instead.",
  },
  {
    state: "refused, invalid request",
    render: form(
      false,
      editRefusal({ code: "invalid_request", message: "to: not an address" })
    ),
    role: "alert",
    selector: '[role="alert"] [data-slot="alert-description"]',
    message: "to: not an address",
  },
  {
    state: "refused, forbidden",
    render: form(false, editRefusal({ code: "forbidden", message: "policy" })),
    role: "alert",
    message: "You cannot edit this request.",
  },
  {
    state: "gate unreachable",
    render: form(
      false,
      editRefusal({ code: "network", message: "could not be reached" })
    ),
    role: "alert",
    message: "The gate is not reachable. Your changes are kept.",
  },
])
