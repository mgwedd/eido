import { REVIEWED_MANIFESTS } from "@eido/schemas"
import { describe, expect, it } from "vitest"

import { plane, type PlaneDeps, type RunResult } from "./plane-cli.ts"
import type { FileStat } from "../stack/settings.ts"

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" })

const SETTINGS = "/Users/owner/Library/Application Support/eido-dev/stack.env"

const HOST: Record<string, RunResult> = {
  "/usr/bin/dscl . -read /Users/owner NFSHomeDirectory": ok(
    "NFSHomeDirectory: /Users/owner\n"
  ),
  "/usr/bin/dscl . -list /Users UniqueID": ok("owner 501\n_www 70\n"),
  "/usr/bin/dscl . -list /Groups PrimaryGroupID": ok("staff 20\n"),
  "tailscale status --json": ok('{"Self":{"DNSName":"mac.example.ts.net."}}'),
}

function harness(
  results: Record<string, RunResult> = HOST,
  options: {
    env?: Record<string, string>
    manifests?: Record<string, unknown>
    files?: Record<string, { text: string; mode: number }>
  } = {}
) {
  const out: string[] = []
  const err: string[] = []
  const calls: string[] = []
  const files = options.files ?? {}
  const deps: PlaneDeps = {
    run: (command, args) => {
      const line = [command, ...args].join(" ")
      calls.push(line)
      return Promise.resolve(
        results[line] ?? { code: 1, stdout: "", stderr: "" }
      )
    },
    env: options.env ?? { USER: "owner" },
    files: {
      read: (path) => files[path]?.text,
      stat: (path): FileStat | undefined => {
        const file = files[path]
        return file === undefined
          ? undefined
          : { isFile: true, mode: file.mode, size: file.text.length }
      },
    },
    repoRoot: "/Users/owner/dev/eido",
    execPath: "/opt/homebrew/bin/node",
    manifests: options.manifests ?? REVIEWED_MANIFESTS,
    out: (text) => out.push(text),
    err: (line) => err.push(line),
  }
  return { out, err, calls, deps }
}

describe("host plane plan", () => {
  it("prints the script from what it reads, running only read commands", async () => {
    const h = harness()
    expect(await plane(["plan"], h.deps)).toBe(0)
    expect(h.calls).toEqual([
      "/usr/bin/dscl . -read /Users/owner NFSHomeDirectory",
      "/usr/bin/dscl . -list /Users UniqueID",
      "/usr/bin/dscl . -list /Groups PrimaryGroupID",
      "tailscale status --json",
    ])
    const script = h.out.join("\n")
    expect(script.startsWith("#!/bin/sh\n")).toBe(true)
    expect(script).toContain(
      "/usr/bin/rsync -a --delete --exclude=/.git --exclude=.turbo --exclude=/apps/web/.next --exclude=coverage --exclude=/infra/secrets --include=.env.example '--exclude=.env*' --exclude=/eval-local '--exclude=*.db' '--exclude=*.db-wal' '--exclude=*.db-shm' --exclude=/gate-launcher.zsh /Users/owner/dev/eido/ '/Library/Application Support/Eido/app/'"
    )
    expect(script).toContain("<string>https://mac.example.ts.net:8443</string>")
    expect(script).toContain(
      "/usr/bin/tee '/Library/Application Support/Eido/policy/eido-egress.hosts' >/dev/null <<'EIDO_EOF'\nbridge.simplefin.org\ngmail.googleapis.com\noauth2.googleapis.com\nweb.push.apple.com\nwww.googleapis.com\nEIDO_EOF"
    )
    expect(h.err).toEqual([])
  })

  it("stops when a reviewed manifest does not validate, rather than leave its hosts out", async () => {
    const h = harness(HOST, { manifests: { gmail: { name: "gmail" } } })
    expect(await plane(["plan"], h.deps)).toBe(1)
    expect(h.err).toEqual([
      "the gmail manifest is not a valid connector manifest",
    ])
    expect(h.out).toEqual([])
  })

  it("takes the owner from sudo and the tailnet name and llama port from stack.env", async () => {
    const h = harness(HOST, {
      env: { USER: "root", SUDO_USER: "owner" },
      files: {
        [SETTINGS]: {
          text: "EIDO_TAILNET_HOST=box.example.ts.net\nEIDO_LLAMA_PORT=8080\n",
          mode: 0o100600,
        },
      },
    })
    expect(
      await plane(
        ["plan", "--egress-port", "8790", "--node", "/usr/local/bin/node"],
        h.deps
      )
    ).toBe(0)
    expect(h.calls).not.toContain("tailscale status --json")
    const script = h.out.join("\n")
    expect(script).toContain("<string>https://box.example.ts.net:8443</string>")
    expect(script).toContain("port { 8790, 8080 } user 452")
    expect(script).toContain("<string>/usr/local/bin/node</string>")
  })

  it("refuses a stack.env the stack itself would refuse", async () => {
    const h = harness(HOST, {
      files: { [SETTINGS]: { text: "", mode: 0o100644 } },
    })
    expect(await plane(["plan"], h.deps)).toBe(1)
    expect(h.err[0]).toContain("has mode 0644, not 0600")
    expect(h.out).toEqual([])
  })

  it("stops and names the clash when the ids are taken", async () => {
    const h = harness({
      ...HOST,
      "/usr/bin/dscl . -list /Users UniqueID": ok("owner 501\n_other 452\n"),
    })
    expect(await plane(["plan"], h.deps)).toBe(1)
    expect(h.err).toEqual([
      "user id 452 belongs to _other; pass a free --first-id",
    ])
    expect(h.out).toEqual([])
  })

  it("uses the ids --first-id names", async () => {
    const h = harness()
    expect(await plane(["plan", "--first-id", "461"], h.deps)).toBe(0)
    expect(h.out.join("\n")).toContain(
      "/usr/bin/dscl . -create /Users/_eidodata UniqueID 462"
    )
  })

  it("reports a failed read", async () => {
    const h = harness({})
    expect(await plane(["plan", "--owner", "owner"], h.deps)).toBe(1)
    expect(h.err).toEqual([
      "/usr/bin/dscl . -read /Users/owner NFSHomeDirectory failed: exit 1",
    ])
  })

  it("refuses a bad egress port", async () => {
    const h = harness()
    expect(await plane(["plan", "--egress-port", "0"], h.deps)).toBe(1)
    expect(h.err).toEqual(['--egress-port must be a port number, not "0"'])
  })
})

describe("host plane remove", () => {
  it("prints the removal script for the accounts that exist, with the note on kept data", async () => {
    const h = harness({
      ...HOST,
      "/usr/bin/dscl . -list /Users UniqueID": ok(
        "owner 501\n_eidogate 451\n_eidodata 452\n"
      ),
    })
    expect(await plane(["remove"], h.deps)).toBe(0)
    const script = h.out.join("\n")
    expect(script).toContain("/usr/bin/dscl . -delete /Users/_eidodata\n")
    expect(script).not.toContain("/Groups/_eidoipc")
    expect(
      script.endsWith(
        "#   sudo rm -rf '/Library/Application Support/Eido' /Library/Logs/Eido"
      )
    ).toBe(true)
    expect(h.calls).not.toContain("tailscale status --json")
  })
})

describe("host plane usage", () => {
  it("refuses unknown actions, extra words and unknown flags", async () => {
    for (const argv of [[], ["apply"], ["plan", "now"], ["plan", "--force"]]) {
      const h = harness()
      expect(await plane(argv, h.deps)).toBe(2)
      expect(h.err.at(-1)).toMatch(/^usage: host plane/)
      expect(h.calls).toEqual([])
    }
  })
})
