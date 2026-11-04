// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AskScreen } from "../components/ask-view"
import { DocumentViewer } from "../components/document-viewer"
import { InjectionFlag } from "../components/injection-flag"
import { QueueView } from "../components/queue-view"
import { answered } from "./fixtures/ask"
import {
  cleanCitation,
  cleanIntent,
  cleanPrepared,
  flaggedCitation,
  flaggedDocumentView,
  flaggedIntent,
  flaggedPrepared,
} from "./fixtures/injection"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string
    children: React.ReactNode
    className?: string
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
})

const settle = async (steps = 10) => {
  for (let step = 0; step < steps; step += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

describe("InjectionFlag component", () => {
  test("clean item renders an empty live region and no interactive buttons", async () => {
    act(() => {
      root.render(<InjectionFlag injectionSuspected={false} reasons={[]} />)
    })
    await settle()

    const flag = container.querySelector('[data-slot="injection-flag"]')
    expect(flag).not.toBeNull()
    expect(flag?.textContent?.trim()).toBe("")
    expect(container.querySelector("button")).toBeNull()
  })

  test("flagged chip opens panel with description and all four reasons in fixed order", async () => {
    act(() => {
      root.render(
        <InjectionFlag
          injectionSuspected
          reasons={[
            "hidden-characters",
            "boundary-confusion",
            "template-marker",
            "fence-tag",
          ]}
        />
      )
    })
    await settle()

    const chip = container.querySelector(
      'button[aria-label="Possible injection"]'
    )
    expect(chip).not.toBeNull()
    expect(chip?.textContent?.trim()).toBe("Possible injection")

    // Open the panel
    act(() => {
      chip?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await settle()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain("Possible injection")
    expect(dialog?.textContent).toContain(
      "This item contained text that tried to pass as instructions."
    )

    const listItems = dialog?.querySelectorAll("li")
    expect(listItems).toHaveLength(4)
    expect(listItems?.[0]?.textContent).toBe("Forged fence tag")
    expect(listItems?.[1]?.textContent).toBe("Template marker")
    expect(listItems?.[2]?.textContent).toBe("Boundary-confusion line")
    expect(listItems?.[3]?.textContent).toBe("Hidden characters")
  })

  test("variant='button' renders a small '!' button that opens the panel", async () => {
    act(() => {
      root.render(
        <InjectionFlag
          variant="button"
          injectionSuspected
          reasons={["template-marker"]}
        />
      )
    })
    await settle()

    const btn = container.querySelector(
      'button[aria-label="Possible injection"]'
    )
    expect(btn).not.toBeNull()
    expect(btn?.textContent?.trim()).toBe("!")

    act(() => {
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await settle()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain("Template marker")
    expect(dialog?.textContent).not.toContain("Forged fence tag")
  })

  test("closing the sheet removes the dialog", async () => {
    act(() => {
      root.render(
        <InjectionFlag injectionSuspected reasons={["fence-tag"]} defaultOpen />
      )
    })
    await settle()

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    const closeBtn = document.querySelector('[data-slot="sheet-close"]')
    act(() => {
      closeBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await settle()

    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe("Approval card injection flag & actions", () => {
  test("flagged intent shows chip and never disables Approve, Edit, or Reject", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        if (
          url.includes("/api/gate/approvals") &&
          !url.includes("/nonce") &&
          !url.includes("/history")
        ) {
          return Promise.resolve(Response.json({ intents: [flaggedIntent] }))
        }
        if (url.includes("/nonce")) {
          return Promise.resolve(Response.json(flaggedPrepared))
        }
        if (url.includes("/history")) {
          return Promise.resolve(
            Response.json({ intentId: flaggedIntent.id, entries: [] })
          )
        }
        return Promise.resolve(new Response(null, { status: 500 }))
      })
    )

    act(() => {
      root.render(<QueueView />)
    })
    await settle()

    // Flag chip is present beside heading
    const chip = container.querySelector('[data-slot="injection-flag"] button')
    expect(chip).not.toBeNull()
    expect(chip?.textContent?.trim()).toBe("Possible injection")

    // Heading exists
    const h2 = container.querySelector("article h2")
    expect(h2).not.toBeNull()

    // Acceptance criterion: The flag never disables Approve, Edit or Reject
    const approveBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Approve")
    )
    const editBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Edit")
    )
    const rejectBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Reject")
    )

    expect(approveBtn).toBeDefined()
    expect(approveBtn?.disabled).toBe(false)

    expect(editBtn).toBeDefined()
    expect(editBtn?.disabled).toBe(false)

    expect(rejectBtn).toBeDefined()
    expect(rejectBtn?.disabled).toBe(false)
  })

  test("clean intent in queue shows no injection flag chip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        if (
          url.includes("/api/gate/approvals") &&
          !url.includes("/nonce") &&
          !url.includes("/history")
        ) {
          return Promise.resolve(Response.json({ intents: [cleanIntent] }))
        }
        if (url.includes("/nonce")) {
          return Promise.resolve(Response.json(cleanPrepared))
        }
        if (url.includes("/history")) {
          return Promise.resolve(
            Response.json({ intentId: cleanIntent.id, entries: [] })
          )
        }
        return Promise.resolve(new Response(null, { status: 500 }))
      })
    )

    act(() => {
      root.render(<QueueView />)
    })
    await settle()

    const chip = container.querySelector('[data-slot="injection-flag"] button')
    expect(chip).toBeNull()
  })
})

describe("Ask citation injection flag", () => {
  test("flagged citation displays '!' button which opens panel", async () => {
    const askResult = {
      ...answered,
      answer: "Invoice paid [M1]",
      citations: [flaggedCitation],
    }

    act(() => {
      root.render(
        <AskScreen
          state={{
            status: "ready",
            question: "Check invoice",
            result: askResult,
          }}
          input=""
          proposals={{}}
          busy={false}
          onInput={() => {}}
          onSubmit={() => {}}
          onRetry={() => {}}
          onPropose={() => {}}
          onOpenSearch={() => {}}
        />
      )
    })
    await settle()

    const flagButton = container.querySelector(
      'li [data-slot="injection-flag"] button[aria-label="Possible injection"]'
    )
    expect(flagButton).not.toBeNull()
    expect(flagButton?.textContent?.trim()).toBe("!")

    act(() => {
      flagButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await settle()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain("Template marker")
    expect(dialog?.textContent).toContain("Boundary-confusion line")
  })

  test("clean citation does not display '!' button", async () => {
    const askResult = {
      ...answered,
      answer: "Clean answer [M2]",
      citations: [cleanCitation],
    }

    act(() => {
      root.render(
        <AskScreen
          state={{
            status: "ready",
            question: "Check email",
            result: askResult,
          }}
          input=""
          proposals={{}}
          busy={false}
          onInput={() => {}}
          onSubmit={() => {}}
          onRetry={() => {}}
          onPropose={() => {}}
          onOpenSearch={() => {}}
        />
      )
    })
    await settle()

    const flagButton = container.querySelector(
      'li [data-slot="injection-flag"] button'
    )
    expect(flagButton).toBeNull()
  })
})

describe("DocumentViewer mail detail injection flag", () => {
  test("flagged mail detail renders Possible injection chip beside title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(flaggedDocumentView)))
    )

    act(() => {
      root.render(
        <DocumentViewer
          sha256={flaggedDocumentView.document.sha256}
          injectionSuspected
          injectionReasons={["fence-tag"]}
        />
      )
    })
    await settle()

    const heading = container.querySelector("h1")
    expect(heading?.textContent).toContain(flaggedDocumentView.document.name)

    const chip = container.querySelector('[data-slot="injection-flag"] button')
    expect(chip).not.toBeNull()
    expect(chip?.textContent?.trim()).toBe("Possible injection")

    act(() => {
      chip?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await settle()

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain("Forged fence tag")
  })

  test("clean mail detail does not show injection chip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(flaggedDocumentView)))
    )

    act(() => {
      root.render(
        <DocumentViewer
          sha256={flaggedDocumentView.document.sha256}
          injectionSuspected={false}
          injectionReasons={[]}
        />
      )
    })
    await settle()

    const chip = container.querySelector('[data-slot="injection-flag"] button')
    expect(chip).toBeNull()
  })
})
