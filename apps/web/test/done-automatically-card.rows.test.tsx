// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"

import { DoneAutomaticallyCard } from "../components/done-automatically-card"
import { entry } from "./fixtures/activity"

const noop = () => undefined
const html = (description?: string) =>
  renderToStaticMarkup(
    <DoneAutomaticallyCard
      state={{
        status: "ready",
        entries: [
          entry(5, {
            displayActor: "auto",
            actor: "policy",
            action: "execute",
            undo: "available",
            ...(description === undefined ? {} : { description }),
          }),
        ],
      }}
      onRetry={noop}
      onUndoSettled={noop}
      onSignedOut={noop}
    />
  )

test("shows the gate's description in place of the raw action name", () => {
  const markup = html("Marked 4 messages read in Gmail")
  expect(markup).toContain("Marked 4 messages read in Gmail")
  expect(markup).not.toContain(">execute<")
})

test("falls back to the action name when the row has no description", () => {
  expect(html()).toContain(">execute<")
})
