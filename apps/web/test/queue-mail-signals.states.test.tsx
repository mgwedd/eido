// @vitest-environment happy-dom
import { createHash } from "node:crypto"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { QueueView } from "../components/queue-view"
import { mailMessageSha256 } from "../lib/queue/card"
import { FLAGGED_SHA, flaggedSignals } from "./fixtures/mail-signals"
import { mailPayload, mailPrepared, mailQueued } from "./fixtures/queue"
import { describeStates } from "./render-states"

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
  }) => <a href={href}>{children}</a>,
}))

type Signals = "flagged" | "clean" | "failed" | "gone"
const hash = createHash("sha256").update(mailPayload).digest("hex")

function route(signals: Signals) {
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith("/approvals"))
      return Promise.resolve(Response.json({ intents: mailQueued }))
    if (url.endsWith("/nonce"))
      return Promise.resolve(Response.json(mailPrepared(hash)))
    if (url.endsWith("/history"))
      return Promise.resolve(
        Response.json({ intentId: "intent-a", entries: [] })
      )
    if (url.endsWith(`/mail/${FLAGGED_SHA}/signals`))
      return Promise.resolve(
        signals === "failed" || signals === "gone"
          ? new Response(null, { status: signals === "gone" ? 404 : 503 })
          : Response.json({
              signals: signals === "flagged" ? flaggedSignals : [],
            })
      )
    return Promise.resolve(new Response(null, { status: 404 }))
  })
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}

async function settled(container: HTMLElement) {
  for (let step = 0; step < 50; step += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const approve = [...container.querySelectorAll("article button")].find(
      (button) => button.textContent?.startsWith("Approve")
    )
    if (approve && !approve.hasAttribute("disabled")) return
  }
  throw new Error("approval card did not finish loading")
}

const render = (signals: Signals) => () => {
  route(signals)
  return <QueueView />
}

describeStates("Queue phishing signals", [
  {
    state: "flagged row, collapsed",
    render: render("flagged"),
    interact: settled,
    role: "status",
    selector: 'li [data-slot="mail-signals"] > [role="status"]',
    message: "Possible phishing · 4",
  },
  {
    state: "flagged detail, expanded",
    render: render("flagged"),
    interact: settled,
    role: "status",
    selector:
      'article [data-slot="mail-signals"] [data-slot="alert"]:not([hidden])',
    message:
      "This message has signs of phishing." +
      "Sender failed DMARC" +
      "Reply-To is on another domainpay-desk.example.invalid" +
      "Sender domain looks like one you write toroofimg.example.invalid ~ roofing.example.invalid" +
      "A link's text shows another domainroofing.example.invalid -> pay-desk.example.invalid",
  },
  {
    state: "clean row",
    render: render("clean"),
    interact: settled,
    role: "status",
    selector: 'li [role="status"]',
    message: null,
  },
  {
    state: "clean detail",
    render: render("clean"),
    interact: settled,
    role: "status",
    selector: 'article [data-slot="card-content"] > [role="status"]',
    message: null,
  },
])

describe("Queue phishing signals decisions", () => {
  let root: Root | undefined
  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ""
    vi.unstubAllGlobals()
  })

  test.each(["flagged", "clean", "failed", "gone"] as const)(
    "%s signals leave Approve enabled and do not refresh the signing nonce",
    async (signals) => {
      const fetcher = route(signals)
      const container = document.createElement("div")
      document.body.appendChild(container)
      root = createRoot(container)
      act(() => root?.render(<QueueView />))
      await settled(container)
      const approve = [
        ...container.querySelectorAll<HTMLButtonElement>("article button"),
      ].find((button) => button.textContent?.startsWith("Approve"))
      expect(approve?.disabled).toBe(false)
      expect(
        fetcher.mock.calls.filter(([url]) => url.endsWith("/nonce"))
      ).toHaveLength(1)
      if (signals === "flagged") {
        const rowChip = container.querySelector<HTMLButtonElement>(
          "li button[aria-expanded]"
        )
        expect(rowChip?.getAttribute("aria-expanded")).toBe("false")
        expect(
          container
            .querySelector("article button[aria-expanded]")
            ?.getAttribute("aria-expanded")
        ).toBe("true")
        act(() => rowChip?.click())
        expect(rowChip?.getAttribute("aria-expanded")).toBe("true")
        expect(
          fetcher.mock.calls.filter(([url]) => url.endsWith("/nonce"))
        ).toHaveLength(1)
      } else if (signals === "clean") {
        expect(container.querySelector('[data-slot="mail-signals"]')).toBeNull()
      }
    }
  )

  test("uses only a reply or forward target hash, rejecting invalid hashes", () => {
    expect(mailMessageSha256("email.reply", mailPayload)).toBe(FLAGGED_SHA)
    expect(mailMessageSha256("email.forward", mailPayload)).toBe(FLAGGED_SHA)
    expect(mailMessageSha256("email.send", mailPayload)).toBeUndefined()
    expect(mailMessageSha256("email.reply", "not json")).toBeUndefined()
    expect(
      mailMessageSha256(
        "email.reply",
        JSON.stringify({ args: { messageSha256: "not-a-hash" } })
      )
    ).toBeUndefined()
  })
})
