// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { CoreApiBrief } from "@eido/schemas"
import { DueSoonCard } from "../components/due-soon-card"
import { MorningBriefCard } from "../components/morning-brief-card"
import { TodayView } from "../components/needs-you"
import type { DueSoonEntry } from "../lib/today-due-soon"

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

const NOW = new Date(2026, 9, 18, 12) // Oct 18, 2026

function toUrlString(url: RequestInfo | URL): string {
  if (typeof url === "string") return url
  if (url instanceof URL) return url.href
  return url.url
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const sampleBrief: CoreApiBrief = {
  id: "brief-1",
  date: "2026-10-18",
  generatedAt: "2026-10-18T07:02:00.000Z",
  windowStart: "2026-10-17T07:00:00.000Z",
  windowEnd: "2026-10-18T07:00:00.000Z",
  lines: [
    {
      kind: "due",
      text: "Electric bill of $84.20 due tomorrow.",
      ledger: { type: "obligation", id: "obl-1" },
      source: {
        documentId: "1".repeat(64),
        span: { start: 10, end: 40 },
      },
    },
    {
      kind: "changed",
      text: "Lease renewal received from landlord.",
      ledger: { type: "obligation", id: "obl-2" },
      source: {
        documentId: "2".repeat(64),
        span: { start: 5, end: 25 },
      },
    },
  ],
  coverage: {
    messagesRead: 212,
    messagesTotal: 212,
    documentsRead: 5,
    documentsTotal: 6,
    windowStart: "2026-10-17T07:00:00.000Z",
    windowEnd: "2026-10-18T07:00:00.000Z",
    skipped: 0,
  },
  coverageLine:
    "Read 212 new messages and 5 of 6 documents since yesterday. Proton Mail not read: Bridge paused.",
}

const sampleEntities: Array<DueSoonEntry["entity"]> = [
  { id: "e-pers", name: "Personal", kind: "personal", tag: "personal" },
  { id: "e-rent", name: "Rental", kind: "property", tag: "rental" },
]

const sampleDueEntries: DueSoonEntry[] = [
  {
    id: 1,
    action: "Pay electric bill",
    party: "City Power",
    dueAt: "2026-10-15", // overdue by 3 days
    direction: "owed",
    entity: sampleEntities[0]!,
    source: {
      documentId: "3".repeat(64),
      span: { start: 100, end: 150 },
    },
  },
  {
    id: 2,
    action: "Follow up on deposit",
    party: "Tenant",
    dueAt: "2026-10-20", // in 2 days
    direction: "waiting",
    entity: sampleEntities[1]!,
    source: {
      documentId: "4".repeat(64),
      span: { start: 200, end: 250 },
    },
  },
  {
    id: 3,
    action: "Send invoice draft",
    party: "Studio Client",
    dueAt: "2026-10-25", // in 7 days
    direction: "owed",
    entity: sampleEntities[0]!,
    source: {
      documentId: "5".repeat(64),
      span: { start: 300, end: 350 },
    },
  },
]

test("MorningBriefCard renders paragraph with citations and coverage line", () => {
  act(() => {
    root.render(
      <MorningBriefCard
        state={{ status: "ready", brief: sampleBrief }}
        now={NOW}
        onRetry={() => undefined}
      />
    )
  })

  expect(container.textContent).toContain(
    "Electric bill of $84.20 due tomorrow."
  )
  expect(container.textContent).toContain(
    "Lease renewal received from landlord."
  )
  expect(container.textContent).toContain(sampleBrief.coverageLine)

  // Citations are links to the source document span
  const citationLinks = container.querySelectorAll("a[href^='/documents/']")
  expect(citationLinks.length).toBe(2)
  expect(citationLinks[0]?.getAttribute("href")).toBe(
    `/documents/${"1".repeat(64)}?start=10&end=40`
  )
})

test("MorningBriefCard does not render a line lacking a source link", () => {
  const briefWithBadLine: CoreApiBrief = {
    ...sampleBrief,
    lines: [
      sampleBrief.lines[0]!,
      {
        kind: "due",
        text: "Buggy line without source link.",
        ledger: { type: "obligation", id: "obl-bad" },
        // @ts-expect-error testing missing source
        source: null,
      },
    ],
  }

  act(() => {
    root.render(
      <MorningBriefCard
        state={{ status: "ready", brief: briefWithBadLine }}
        now={NOW}
        onRetry={() => undefined}
      />
    )
  })

  expect(container.textContent).toContain(
    "Electric bill of $84.20 due tomorrow."
  )
  expect(container.textContent).not.toContain("Buggy line without source link.")
})

test("MorningBriefCard renders empty state when no brief exists", () => {
  act(() => {
    root.render(
      <MorningBriefCard
        state={{ status: "empty" }}
        now={NOW}
        onRetry={() => undefined}
      />
    )
  })

  expect(container.textContent).toContain("No brief yet.")
})

test("MorningBriefCard renders earlier day header when brief is from a prior date", () => {
  const earlierBrief: CoreApiBrief = {
    ...sampleBrief,
    date: "2026-10-17",
  }

  act(() => {
    root.render(
      <MorningBriefCard
        state={{ status: "ready", brief: earlierBrief }}
        now={NOW}
        onRetry={() => undefined}
      />
    )
  })

  expect(container.querySelector("h2")?.parentElement?.textContent).toContain(
    "Oct 17"
  )
})

test("DueSoonCard renders desktop table with 5 columns and phone list", () => {
  act(() => {
    root.render(
      <DueSoonCard
        state={{
          status: "ready",
          entries: sampleDueEntries,
          entities: sampleEntities,
        }}
        now={NOW}
        activeEntity="all"
        onSelectEntity={() => undefined}
        onRetry={() => undefined}
        pendingDraftObligationIds={new Set([3])}
      />
    )
  })

  // Table headers on desktop
  const headers = [...container.querySelectorAll("th")].map((th) =>
    th.textContent?.trim()
  )
  expect(headers).toEqual(["Obligation", "Entity", "Due", "Source", "Status"])

  // Rows contain actions
  expect(container.textContent).toContain("Pay electric bill")
  expect(container.textContent).toContain("Follow up on deposit")

  // Overdue row has overdue styling
  expect(container.textContent).toContain("3 days overdue")

  // Status chips: row 1 is open (neutral), row 2 is tracking (waiting), row 3 is draft ready
  expect(container.textContent).toContain("Tracking")
  expect(container.textContent).toContain("Draft ready")
  expect(container.textContent).toContain("Open")
})

test("DueSoonCard renders empty state with no table headers when empty", () => {
  act(() => {
    root.render(
      <DueSoonCard
        state={{
          status: "ready",
          entries: [],
          entities: sampleEntities,
        }}
        now={NOW}
        activeEntity="all"
        onSelectEntity={() => undefined}
        onRetry={() => undefined}
      />
    )
  })

  expect(container.textContent).toContain("No obligations yet.")
  expect(container.querySelectorAll("th")).toHaveLength(0)
  expect(container.querySelectorAll("table")).toHaveLength(0)
})

test("DueSoonCard entity filter updates active button and shows filtered empty state", () => {
  const onSelect = vi.fn()

  const rerender = (entity: string) => {
    act(() => {
      root.render(
        <DueSoonCard
          state={{
            status: "ready",
            entries: [sampleDueEntries[0]!], // only Personal
            entities: sampleEntities,
          }}
          now={NOW}
          activeEntity={entity}
          onSelectEntity={onSelect}
          onRetry={() => undefined}
        />
      )
    })
  }

  rerender("all")

  // Filter buttons exist for All, Personal, Rental
  const buttons = [...container.querySelectorAll("button")].filter(
    (b) => b.getAttribute("aria-pressed") !== null
  )
  expect(buttons.length).toBeGreaterThanOrEqual(3)
  expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true")

  // Click "Rental" button
  const rentalButton = buttons.find((b) => b.textContent?.trim() === "Rental")
  rentalButton?.click()
  expect(onSelect).toHaveBeenCalledWith("e-rent")

  // Rerender with "e-rent" active
  rerender("e-rent")
  expect(container.textContent).toContain(
    "Nothing due in the next 90 days for Rental."
  )
  expect(container.querySelectorAll("table")).toHaveLength(0)
})

test("TodayView integrates Needs you, Morning brief and Due soon sections", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((url) => {
      const urlStr = toUrlString(url)
      if (urlStr.includes("/api/gate/approvals")) {
        return Promise.resolve(Response.json({ intents: [] }))
      }
      if (urlStr.includes("/api/core/brief/latest")) {
        return Promise.resolve(Response.json(sampleBrief))
      }
      if (urlStr.includes("/api/core/today/due-soon")) {
        return Promise.resolve(
          Response.json({
            timezone: "America/New_York",
            fromDate: "2026-10-18",
            throughDate: "2027-01-16",
            entries: sampleDueEntries,
            nextOffset: null,
          })
        )
      }
      if (urlStr.includes("/api/core/entities")) {
        return Promise.resolve(Response.json({ entities: sampleEntities }))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })
  )

  await act(async () => {
    root.render(<TodayView />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  // All three sections are present
  expect(container.querySelector("#needs-you-heading")).not.toBeNull()
  expect(container.querySelector("#morning-brief-heading")).not.toBeNull()
  expect(container.querySelector("#due-soon-heading")).not.toBeNull()

  // Content from brief and due-soon is rendered
  expect(container.textContent).toContain(
    "Electric bill of $84.20 due tomorrow."
  )
  expect(container.textContent).toContain("Pay electric bill")
})
