// @vitest-environment happy-dom
import { createHash } from "node:crypto"
import { act } from "react"
import { afterEach, vi } from "vitest"
import { QueueView } from "../components/queue-view"
import { mailPayload, mailPrepared, mailQueued } from "./fixtures/queue"
import { describeStates } from "./render-states"
import { waitUntil } from "./wait-until"

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
  }) => <a href={href}>{children}</a>,
}))

const reachability = vi.hoisted(() => {
  const state: { value: "reachable" | "unreachable" } = { value: "reachable" }
  return state
})
vi.mock("../components/reachability", () => ({
  useReachability: () => reachability.value,
}))

const signApproval = vi.hoisted(() => vi.fn())
vi.mock(
  "../lib/approval/sign",
  async (importOriginal: () => Promise<object>) => ({
    ...(await importOriginal()),
    signApproval,
  })
)

afterEach(() => {
  vi.useRealTimers()
  signApproval.mockReset()
  reachability.value = "reachable"
})

const HASH = createHash("sha256").update(mailPayload).digest("hex")
const WRONG_HASH = "0".repeat(64)

type Gate = {
  intents?: "none" | "unreachable" | "never"
  payload?: "ok" | "failed" | "hash-mismatch"
  history?: "ok" | "failed"
}

/** Routes the gate calls the queue makes; the default is one approvable card. */
function route({ intents, payload, history }: Gate = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("/passkey/status"))
        return Promise.resolve(
          Response.json({ enrolled: true, sessionExpiresAt: null })
        )
      if (url.endsWith("/approvals")) {
        if (intents === "never") return new Promise<Response>(() => {})
        if (intents === "unreachable")
          return Promise.resolve(new Response(null, { status: 503 }))
        return Promise.resolve(
          Response.json({ intents: intents === "none" ? [] : mailQueued })
        )
      }
      if (url.endsWith("/nonce"))
        return Promise.resolve(
          payload === "failed"
            ? new Response(null, { status: 503 })
            : Response.json(
                mailPrepared(payload === "hash-mismatch" ? WRONG_HASH : HASH)
              )
        )
      if (url.endsWith("/history"))
        return Promise.resolve(
          history === "failed"
            ? new Response(null, { status: 503 })
            : Response.json({ intentId: "intent-a", entries: [] })
        )
      return Promise.resolve(new Response(null, { status: 404 }))
    })
  )
}

const render = (gate?: Gate) => () => {
  route(gate)
  return <QueueView />
}

const approveButton = (container: HTMLElement) =>
  [...container.querySelectorAll("article button")].find(
    (button) =>
      button.textContent?.startsWith("Approve") &&
      !button.hasAttribute("disabled")
  )

const waitForApprove = (container: HTMLElement) =>
  waitUntil(
    () => approveButton(container) !== undefined,
    "approval card did not finish loading"
  )

/** Clicks Approve and lets the stubbed passkey outcome land. The card is loaded by `settle`. */
async function sign(container: HTMLElement) {
  const button = approveButton(container)
  if (!(button instanceof HTMLElement)) throw new Error("no Approve button")
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

const withPasskey = (outcome: () => unknown, gate?: Gate) => () => {
  signApproval.mockImplementation(outcome)
  return render(gate)()
}

const refused = (code: string, message: string) => () =>
  Promise.resolve({ ok: false, error: { code, message } })

const wait = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 50)
  })

describeStates("Queue", [
  {
    state: "loading",
    render: render({ intents: "never" }),
    role: "status",
    message: "Loading the queue…",
  },
  {
    state: "empty",
    render: render({ intents: "none" }),
    interact: wait,
    role: "status",
    selector: 'p[role="status"][tabindex="-1"]',
    message: "Queue clear. Every decision is in Activity.",
  },
  {
    state: "gate unreachable",
    render: render({ intents: "unreachable" }),
    interact: wait,
    role: "alert",
    message: "Couldn't load the queue.",
  },
  {
    state: "payload failed",
    render: render({ payload: "failed" }),
    interact: wait,
    role: "alert",
    message: "Could not load the payload.",
  },
  {
    state: "payload hash mismatch",
    render: render({ payload: "hash-mismatch" }),
    interact: wait,
    role: "alert",
    message: "Payload changed. Reload the card.",
  },
  {
    state: "history failed",
    render: render({ history: "failed" }),
    settle: waitForApprove,
    role: "alert",
    message: "Could not load history from the audit log.",
  },
  {
    state: "signing",
    render: withPasskey(() => new Promise(() => {})),
    settle: waitForApprove,
    interact: sign,
    role: "status",
    selector: "article > p[role=status]",
    message: "Waiting for your passkey",
  },
  {
    state: "signing cancelled",
    render: withPasskey(refused("cancelled", "The prompt was dismissed.")),
    settle: waitForApprove,
    interact: sign,
    role: "status",
    selector: "article > p[role=status]",
    message: "Signing cancelled · nothing was sent",
  },
  {
    state: "verification failed",
    render: withPasskey(refused("verification_failed", "Refused.")),
    settle: waitForApprove,
    interact: sign,
    role: "alert",
    selector: "article > [data-slot=alert]",
    message:
      "What you saw and what is stored differ. The intent was rejected and an alert was logged.",
  },
  {
    state: "approved",
    render: withPasskey(() => Promise.resolve({ ok: true, value: {} })),
    settle: waitForApprove,
    interact: sign,
    role: "status",
    selector: "header + p[role=status]",
    message: "Approved",
  },
  {
    state: "already decided",
    render: withPasskey(refused("already_decided", "Already decided.")),
    settle: waitForApprove,
    interact: sign,
    role: "status",
    selector: "header + p[role=status]",
    message: "Already decided",
  },
  {
    state: "offline",
    render: () => {
      reachability.value = "unreachable"
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date(2026, 9, 18, 9, 5))
      return render()()
    },
    interact: wait,
    role: "status",
    selector: "[data-slot=alert][role=status]",
    message:
      "Offline. Approvals need a connection. Cards below were loaded at 09:05 and cannot be signed until the Mac is reachable.",
  },
])
