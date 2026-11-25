import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { APPLE_MAX_BYTES, createAppleRunner } from "./runner"

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
function executable(script: string, consumeInput = true): string {
  const dir = mkdtempSync(join(tmpdir(), "eido-apple-runner-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "helper")
  writeFileSync(
    path,
    `#!/bin/sh\n${consumeInput ? "/bin/cat >/dev/null\n" : ""}${script}\n`,
    { mode: 0o700 }
  )
  return path
}
const request = { operation: "list_calendars", args: {} } as const
const options = { platform: "darwin" } as const
const nativeTest = process.platform === "win32" ? test.skip : test

describe("Apple Helper private-pipe runner", () => {
  test("fails closed without configuration or off macOS", async () => {
    await expect(createAppleRunner(undefined)(request)).rejects.toMatchObject({
      code: "unavailable",
    })
    await expect(
      createAppleRunner("/tmp/helper", { platform: "linux" })(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      createAppleRunner("relative", options)(request)
    ).rejects.toMatchObject({ code: "unavailable" })
  })
  nativeTest("only accepts a gate-owned executable regular file", async () => {
    const path = executable(
      `printf '%s' '{"ok":true,"result":{"calendars":[]}}'`
    )
    chmodSync(path, 0o720)
    await expect(
      createAppleRunner(path, options)(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    chmodSync(path, 0o600)
    await expect(
      createAppleRunner(path, options)(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    chmodSync(path, 0o700)
    symlinkSync(path, `${path}-link`)
    await expect(
      createAppleRunner(`${path}-link`, options)(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      createAppleRunner(`${path}-missing`, options)(request)
    ).rejects.toMatchObject({ code: "unavailable" })
  })
  nativeTest(
    "refuses a writable ancestor before launching an otherwise private executable",
    async () => {
      const path = executable(
        `printf '%s' '{"ok":true,"result":{"calendars":[]}}'`
      )
      const directory = dirname(path)
      const marker = join(directory, "launched")
      const nested = join(directory, "private")
      mkdirSync(nested, { mode: 0o700 })
      const nestedExecutable = join(nested, "helper")
      // The intermediate directory and executable are private; only the ancestor is unsafe.
      writeFileSync(
        nestedExecutable,
        `#!/bin/sh\n/bin/cat >/dev/null\n/usr/bin/touch '${marker}'\nprintf '%s' '{"ok":true,"result":{"calendars":[]}}'\n`,
        { mode: 0o700 }
      )
      chmodSync(directory, 0o777)
      await expect(
        createAppleRunner(nestedExecutable, options)(request)
      ).rejects.toMatchObject({ code: "unavailable" })
      expect(existsSync(marker)).toBe(false)
      chmodSync(directory, 0o700)
      await expect(
        createAppleRunner(nestedExecutable, options)(request)
      ).resolves.toEqual({ calendars: [] })
      expect(existsSync(marker)).toBe(true)
    }
  )
  nativeTest(
    "resolves a directory alias to a protected executable and permits a trusted sticky ancestor",
    async () => {
      const path = executable(
        `printf '%s' '{"ok":true,"result":{"calendars":[]}}'`
      )
      const directory = dirname(path)
      const sticky = join(directory, "sticky")
      const target = join(sticky, "private")
      mkdirSync(sticky, { mode: 0o700 })
      mkdirSync(target, { mode: 0o700 })
      const nativePath = join(target, "helper")
      writeFileSync(
        nativePath,
        '#!/bin/sh\n/bin/cat >/dev/null\nprintf \'%s\' \'{"ok":true,"result":{"calendars":[]}}\'\n',
        { mode: 0o700 }
      )
      chmodSync(sticky, 0o1777)
      symlinkSync(target, join(directory, "release"))
      await expect(
        createAppleRunner(
          join(directory, "release", "helper"),
          options
        )(request)
      ).resolves.toEqual({ calendars: [] })
    }
  )
  nativeTest(
    "refuses a protected target selected through an alias in a writable directory",
    async () => {
      const path = executable(
        `printf '%s' '{"ok":true,"result":{"calendars":[]}}'`
      )
      const directory = dirname(path)
      const unsafe = join(directory, "unsafe")
      mkdirSync(unsafe, { mode: 0o700 })
      symlinkSync(directory, join(unsafe, "release"))
      chmodSync(unsafe, 0o777)
      await expect(
        createAppleRunner(join(unsafe, "release", "helper"), options)(request)
      ).rejects.toMatchObject({ code: "unavailable" })
    }
  )
  nativeTest(
    "passes a single request through stdin and scrubs inherited credentials",
    async () => {
      const path = executable(
        `IFS= read -r input || :
case "$input" in *list_calendars*) ;; *) exit 7;; esac
if [ -n "$EIDO_RUNNER_TEST_SECRET" ]; then exit 8; fi
printf '%s' '{"ok":true,"result":{"calendars":[{"id":"cal-1","title":"Work","writable":true}]}}'`,
        false
      )
      const previous = process.env["EIDO_RUNNER_TEST_SECRET"]
      process.env["EIDO_RUNNER_TEST_SECRET"] = "synthetic-not-a-credential"
      try {
        await expect(
          createAppleRunner(path, options)(request)
        ).resolves.toEqual({
          calendars: [{ id: "cal-1", title: "Work", writable: true }],
        })
      } finally {
        if (previous === undefined)
          delete process.env["EIDO_RUNNER_TEST_SECRET"]
        else process.env["EIDO_RUNNER_TEST_SECRET"] = previous
      }
    }
  )
  nativeTest("validates requests before launching the child", async () => {
    const path = executable("exit 1")
    await expect(
      createAppleRunner(
        path,
        options
      )({
        operation: "list_events",
        args: { calendarId: "", start: "bad", end: "bad" },
      })
    ).rejects.toMatchObject({ code: "invalid_request" })
  })
  nativeTest.each([
    "invalid_request",
    "permission_denied",
    "not_found",
    "read_only",
    "unsupported_event",
    "unavailable",
  ])("returns only the bounded error code %s", async (code) => {
    const path = executable(`printf '%s' '{"ok":false,"code":"${code}"}'`)
    await expect(
      createAppleRunner(path, options)(request)
    ).rejects.toMatchObject({ code, message: `Apple Helper refused: ${code}` })
  })
  nativeTest.each([
    `printf '%s' 'not json'`,
    `printf '%s' '{"ok":true,"result":{"unexpected":"private content"}}'`,
    `printf '%s' 'private stderr content' >&2; exit 1`,
  ])(
    "rejects malformed replies and subprocess failures without leaking content",
    async (script) => {
      await expect(
        createAppleRunner(executable(script), options)(request)
      ).rejects.toMatchObject({
        code: "unavailable",
        message: "Apple Helper refused: unavailable",
      })
    }
  )
  nativeTest("kills an oversized response and a timed-out child", async () => {
    await expect(
      createAppleRunner(
        executable(`/usr/bin/head -c ${APPLE_MAX_BYTES + 1} /dev/zero`),
        options
      )(request)
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      createAppleRunner(executable("while :; do :; done"), {
        ...options,
        timeoutMs: 20,
      })(request)
    ).rejects.toMatchObject({ code: "unavailable" })
  })
})
