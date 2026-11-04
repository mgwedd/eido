import { NAV_ITEMS, type NavItem } from "@/lib/nav"

/** Milliseconds the "g" prefix waits for its second key. */
export const GO_TIMEOUT_MS = 1500

/** The input id of the Ask question field. */
export const ASK_INPUT_ID = "ask-question"

type LegendGroup = {
  title: string
  items: readonly { keys: readonly string[]; label: string }[]
}

/** The keys of one shortcut as written in the design: "g t" is two keys. */
export function keysOf(shortcut: string): string[] {
  return shortcut.split(" ")
}

/** Global go-to shortcuts, taken from the nav so a page and its key are defined once. */
export function goShortcuts(
  items: readonly NavItem[] = NAV_ITEMS
): { key: string; href: string; label: string }[] {
  return items.flatMap((item) => {
    const [prefix, key] = keysOf(item.shortcut ?? "")
    return prefix === "g" && key
      ? [{ key, href: item.href, label: item.label }]
      : []
  })
}

/** The legend shown by `?`: only shortcuts that work. */
export function legendGroups(
  items: readonly NavItem[] = NAV_ITEMS
): LegendGroup[] {
  return [
    {
      title: "Go to",
      items: goShortcuts(items).map(({ key, label }) => ({
        keys: ["g", key],
        label,
      })),
    },
    {
      title: "Anywhere",
      items: [
        { keys: ["/"], label: "Focus Ask" },
        { keys: ["?"], label: "Show shortcuts" },
      ],
    },
    {
      title: "Queue",
      items: [
        { keys: ["j"], label: "Next intent" },
        { keys: ["k"], label: "Previous intent" },
        { keys: ["Enter"], label: "Open the card" },
        { keys: ["a"], label: "Approve with passkey" },
        { keys: ["e"], label: "Edit and approve" },
        { keys: ["r"], label: "Reject" },
        { keys: ["Esc"], label: "Back to the list" },
      ],
    },
    {
      title: "Replies owed",
      items: [
        { keys: ["j"], label: "Next reply" },
        { keys: ["k"], label: "Previous reply" },
        { keys: ["Enter"], label: "Open the thread" },
        { keys: ["d"], label: "Draft reply" },
      ],
    },
    {
      title: "Ask",
      items: [{ keys: ["⌘", "↵"], label: "Send question" }],
    },
  ]
}

/** A field the user types into: a key there is text, never a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
}

/** A control that already acts on Enter. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    isTypingTarget(target) ||
    target.closest("button, a[href], summary, [role='button']") !== null
  )
}

/** True when a bare key press may act as a shortcut. */
export function isShortcutEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (isTypingTarget(event.target)) return false
  return document.querySelector('[role="dialog"]') === null
}

let askFocusRequested = false

/** Called before navigating to Ask so the page focuses its field once it mounts. */
export function requestAskFocus(): void {
  askFocusRequested = true
}

/** Returns true once for each request made by `requestAskFocus`. */
export function consumeAskFocus(): boolean {
  const requested = askFocusRequested
  askFocusRequested = false
  return requested
}
