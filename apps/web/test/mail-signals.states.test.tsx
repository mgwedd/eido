// @vitest-environment happy-dom
import {
  MailSignalsBody,
  type MailSignalsState,
} from "../components/mail-signals"
import { flaggedSignals } from "./fixtures/mail-signals"
import { describeStates } from "./render-states"

const chip =
  (state: MailSignalsState, defaultExpanded = false) =>
  () => (
    <MailSignalsBody
      state={state}
      onRetry={() => undefined}
      defaultExpanded={defaultExpanded}
    />
  )

const flagged: MailSignalsState = {
  status: "ready",
  signals: [...flaggedSignals],
}

// One row per state on the spec board's States section (#screen-phishing).
describeStates("phishing signals", [
  {
    state: "clean",
    render: chip({ status: "ready", signals: [] }),
    role: "status",
    message: null,
  },
  {
    state: "flagged, collapsed",
    render: chip(flagged),
    role: "status",
    message: "Possible phishing · 4",
  },
  {
    state: "flagged, expanded by the chip",
    render: chip(flagged),
    interact: async (container) => {
      container
        .querySelector<HTMLButtonElement>("button[aria-expanded]")
        ?.click()
      await Promise.resolve()
    },
    role: "status",
    selector: '[data-slot="alert"]:not([hidden])',
    message:
      "This message has signs of phishing." +
      "Sender failed DMARC" +
      "Reply-To is on another domainpay-desk.example.invalid" +
      "Sender domain looks like one you write toroofimg.example.invalid ~ roofing.example.invalid" +
      "A link's text shows another domainroofing.example.invalid -> pay-desk.example.invalid",
  },
  {
    state: "flagged, open in a detail card",
    render: chip(flagged, true),
    role: "status",
    selector: '[data-slot="alert"]:not([hidden])',
    message:
      "This message has signs of phishing." +
      "Sender failed DMARC" +
      "Reply-To is on another domainpay-desk.example.invalid" +
      "Sender domain looks like one you write toroofimg.example.invalid ~ roofing.example.invalid" +
      "A link's text shows another domainroofing.example.invalid -> pay-desk.example.invalid",
  },
  {
    state: "loading signals",
    render: chip({ status: "loading" }),
    role: "status",
    message: "Loading signals…",
  },
  {
    state: "signals failed",
    render: chip({ status: "failed" }),
    role: "alert",
    message: "Couldn't load the signals for this message.",
  },
  {
    state: "message gone",
    render: chip({ status: "gone" }),
    role: "status",
    message: null,
  },
])
