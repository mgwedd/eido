// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { GateEnrolmentCodePrepared } from "@eido/schemas"
import { AdminDevicesView } from "../components/admin-devices-view"
import { prepareControl, submitControl } from "../lib/admin/control"

const admin = vi.hoisted(() => ({ signed: vi.fn(), sessionEnded: vi.fn() }))
vi.mock("../components/admin-step-up", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAdmin: () => ({
    elevatedUntil: null,
    elevated: vi.fn(),
    signed: admin.signed,
    sessionEnded: admin.sessionEnded,
  }),
}))
vi.mock("../lib/admin/control", () => ({
  prepareControl: vi.fn(),
  submitControl: vi.fn(),
}))
const prepare = vi.mocked(prepareControl)
const submit = vi.mocked(submitControl)

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const prepared: GateEnrolmentCodePrepared = {
  id: "ctl-1",
  purpose: "policy.set",
  target: "enrolment_code",
  payload: '{"action":"enrolment_code.issue"}',
  payloadHash: "a".repeat(64),
  nonce: "n".repeat(43),
  challenge: "c".repeat(43),
}
const CODE = "4F7K-9QX2-MB3D-H8RT"
/** Local 10:42, whatever the machine's zone is. */
const expiry = (minutes = 0) =>
  new Date(2099, 10, 7, 10, 42 + minutes).toISOString()

let container: HTMLElement
let root: Root

beforeEach(() => {
  prepare.mockResolvedValue({ kind: "ok", status: 200, value: prepared })
  // The Sign prompt is confirmed at once: signed runs what it is given.
  admin.signed.mockImplementation((_change: unknown, send: () => unknown) =>
    send()
  )
  submit.mockResolvedValue({
    kind: "ok",
    status: 200,
    value: { code: CODE, expiresAt: expiry() },
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  prepare.mockReset()
  submit.mockReset()
  admin.signed.mockReset()
  admin.sessionEnded.mockReset()
})

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
async function render() {
  act(() => {
    root.render(<AdminDevicesView />)
  })
  await settle()
}
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text)
const click = async (text: string) => {
  act(() => {
    button(text)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await settle()
}
const alertText = () => container.querySelector('[role="alert"]')?.textContent

test("starts idle with the Signed chip and the issue button, and no code", async () => {
  await render()
  expect(container.textContent).toContain("Add a device")
  expect(container.textContent).toContain("Signed")
  expect(button("Issue enrolment code")).toBeDefined()
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(prepare).not.toHaveBeenCalled()
})

test("prepares exactly the fixed payload, shows it for signing, then shows the code once", async () => {
  await render()
  await click("Issue enrolment code")
  expect(prepare).toHaveBeenCalledWith(
    {
      preparePath: "/admin/enrolment-codes/prepare",
      target: "enrolment_code",
      payload: { action: "enrolment_code.issue" },
    },
    expect.any(Function)
  )
  expect(admin.signed).toHaveBeenCalledWith(
    {
      action: "Issue enrolment code",
      fields: [["Action", "Issue one enrolment code"]],
      payloadHash: "a".repeat(64),
    },
    expect.any(Function)
  )
  expect(submit).toHaveBeenCalledWith(
    prepared,
    "/admin/enrolment-codes",
    expect.any(Function)
  )
  const region = container.querySelector('[aria-label="Enrolment code"]')
  expect(region?.textContent).toBe(
    `${CODE}Shown once · expires 10:42 · enter it at /enroll on the new device`
  )
  expect(button("Issue enrolment code")).toBeUndefined()
})

test("shows Waiting for your passkey… while the change is signed", async () => {
  let finish: (value: Awaited<ReturnType<typeof submitControl>>) => void = () =>
    undefined
  submit.mockReturnValue(new Promise((resolve) => (finish = resolve)))
  await render()
  await click("Issue enrolment code")
  const waiting = button("Waiting for your passkey…")
  expect(waiting?.hasAttribute("disabled")).toBe(true)
  act(() => finish({ kind: "cancelled" }))
  await settle()
  expect(button("Waiting for your passkey…")).toBeUndefined()
})

test("Done hides the code and returns to the issue button", async () => {
  await render()
  await click("Issue enrolment code")
  await click("Done")
  expect(container.textContent).not.toContain(CODE)
  expect(button("Issue enrolment code")).toBeDefined()
})

test("the code is dropped when its expiry passes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.setSystemTime(new Date(2099, 10, 7, 10, 32))
  await act(async () => {
    root.render(<AdminDevicesView />)
    await vi.advanceTimersByTimeAsync(0)
  })
  await act(async () => {
    button("Issue enrolment code")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true })
    )
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(container.textContent).toContain(CODE)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9 * 60_000)
  })
  expect(container.textContent).toContain(CODE)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(container.textContent).not.toContain(CODE)
  expect(alertText()).toBe("The code expired unused. Issue a new one.")
  expect(button("Issue enrolment code")).toBeDefined()
})

test("a cancelled passkey is reported as refused and nothing is shown", async () => {
  submit.mockResolvedValue({ kind: "cancelled" })
  await render()
  await click("Issue enrolment code")
  expect(alertText()).toBe("Not issued: the passkey signature was refused.")
  expect(container.textContent).not.toContain(CODE)
})

test("a 403 from the gate is refused; another refusal is the could-not-issue error", async () => {
  submit.mockResolvedValue({
    kind: "refused",
    status: 403,
    code: "verification_failed",
  })
  await render()
  await click("Issue enrolment code")
  expect(alertText()).toBe("Not issued: the passkey signature was refused.")

  submit.mockResolvedValue({
    kind: "refused",
    status: 500,
    code: "unavailable",
  })
  await click("Issue enrolment code")
  expect(alertText()).toContain(
    "Could not issue a code: the gate did not answer. Nothing was issued."
  )
})

test("preparing refused with 403 is refused; a mismatch or an invalid answer is the error", async () => {
  prepare.mockResolvedValue({ kind: "refused", status: 403, code: "forbidden" })
  await render()
  await click("Issue enrolment code")
  expect(alertText()).toBe("Not issued: the passkey signature was refused.")

  prepare.mockResolvedValue({ kind: "mismatch" })
  await click("Issue enrolment code")
  expect(alertText()).toContain("Could not issue a code")
  expect(admin.signed).not.toHaveBeenCalled()

  prepare.mockResolvedValue({ kind: "invalid" })
  await click("Issue enrolment code")
  expect(alertText()).toContain("Could not issue a code")
})

test("Retry on the error issues again", async () => {
  prepare.mockResolvedValueOnce({ kind: "invalid" })
  await render()
  await click("Issue enrolment code")
  expect(alertText()).toContain("Could not issue a code")
  await click("Retry")
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain(CODE)
})

test("an unreachable gate shows the shared message, from preparing or from signing", async () => {
  prepare.mockResolvedValue({ kind: "unreachable" })
  await render()
  await click("Issue enrolment code")
  expect(alertText()).toContain("Can't reach the gate on the host.")

  prepare.mockResolvedValue({ kind: "ok", status: 200, value: prepared })
  submit.mockResolvedValue({ kind: "unreachable" })
  await click("Issue enrolment code")
  expect(alertText()).toContain("Can't reach the gate on the host.")
})

test("an ended session sends the owner to sign in and shows no message", async () => {
  prepare.mockResolvedValue({ kind: "expired" })
  await render()
  await click("Issue enrolment code")
  expect(admin.sessionEnded).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(button("Issue enrolment code")).toBeDefined()
})

test("a session that ends while signing shows no message and the button is back", async () => {
  submit.mockResolvedValue({ kind: "expired" })
  await render()
  await click("Issue enrolment code")
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(button("Issue enrolment code")).toBeDefined()
})
