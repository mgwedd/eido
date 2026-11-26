import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { gateLauncher } from "./gate-launcher.ts"
import { main } from "./cli.ts"
import {
  passphraseSteps,
  planeInput,
  renderPassphraseScript,
  type Mode,
  type PassphraseInput,
  type PassphraseStep,
  type Word,
} from "./keychain-passphrase.ts"

const input: PassphraseInput = {
  gateUser: "_eidogate",
  gateHome: "/plane/home/gate",
  keychain: "/plane/home/gate/Library/Keychains/eido/eido.keychain-db",
  gateLog: "/plane/gate/gate.log",
  gateLabel: "com.eido.plane.gate",
}

/** A step in a few words, written here independently of the generator's renderer. */
function describeStep(step: PassphraseStep): string {
  const word = (w: Word) => (typeof w === "string" ? w : `<${w.secret}>`)
  const { command } = step
  const text = (() => {
    switch (command.kind) {
      case "path":
        return `path ${command.is}: ${command.path}`
      case "no-item":
        return "no item"
      case "prompt":
        return `prompt ${command.into}${command.unlike === undefined ? "" : ` unlike ${command.unlike}`}`
      case "read-item":
        return `read item into ${command.into}`
      case "hold-signals":
        return "hold signals"
      case "security":
        return `${command.as}: ${command.args.map(word).join(" ")}`
      case "chmod":
        return `chmod ${command.mode} ${command.path}`
      case "kickstart":
        return `kickstart ${command.label}`
      case "say":
        return "say"
    }
  })()
  if (!("undo" in step) || step.undo === undefined) return text
  const undo = step.undo.command
  return `${text} (undo: ${undo.kind === "security" ? undo.args.map(word).join(" ") : undo.kind})`
}

const SYSTEM_ITEM = (secret: string) =>
  `root: add-generic-password -U -a _eidogate -s com.eido.gate.keychain-unlock -T /usr/bin/security -w <${secret}> /Library/Keychains/System.keychain`

describe("passphraseSteps", () => {
  const steps = (mode: Mode) => passphraseSteps(mode, input).map(describeStep)

  it("sets the keychain and then the item from one prompt, and turns auto-lock off", () => {
    expect(steps("set")).toEqual([
      "path dir: /plane/home/gate/Library/Keychains/eido",
      "path absent: /plane/home/gate/Library/Keychains/eido/eido.keychain-db",
      "no item",
      "prompt next",
      "hold signals",
      "gate: create-keychain -p <next> /plane/home/gate/Library/Keychains/eido/eido.keychain-db",
      "chmod 600 /plane/home/gate/Library/Keychains/eido/eido.keychain-db",
      "gate: set-keychain-settings /plane/home/gate/Library/Keychains/eido/eido.keychain-db",
      SYSTEM_ITEM("next"),
      "kickstart com.eido.plane.gate",
      "say",
    ])
  })

  it("rotates the keychain from the item's passphrase first, then the item, changing the keychain back when the item fails", () => {
    expect(steps("rotate")).toEqual([
      "path file: /plane/home/gate/Library/Keychains/eido/eido.keychain-db",
      "read item into current",
      "prompt next unlike current",
      "hold signals",
      "gate: set-keychain-password -o <current> -p <next> /plane/home/gate/Library/Keychains/eido/eido.keychain-db",
      `${SYSTEM_ITEM("next")} (undo: set-keychain-password -o <next> -p <current> /plane/home/gate/Library/Keychains/eido/eido.keychain-db)`,
      "kickstart com.eido.plane.gate",
      "say",
    ])
  })

  it("repairs the item only after the keychain accepts the passphrase", () => {
    expect(steps("repair")).toEqual([
      "path file: /plane/home/gate/Library/Keychains/eido/eido.keychain-db",
      "prompt next",
      "hold signals",
      "gate: set-keychain-password -o <next> -p <next> /plane/home/gate/Library/Keychains/eido/eido.keychain-db",
      SYSTEM_ITEM("next"),
      "kickstart com.eido.plane.gate",
      "say",
    ])
  })

  it("writes the item the launcher reads: the same service and System keychain", () => {
    const launcher = gateLauncher({
      user: "_eidogate",
      groups: ["_eidogate", "_eidoipc"],
      cwd: "/app/packages/gate",
      argv: ["/opt/node", "./src/main.ts"],
    })
    const read = /'find-generic-password' '-s' '([^']+)' '-w' '([^']+)'/.exec(
      launcher
    )
    for (const mode of ["set", "rotate", "repair"] as const) {
      const write = passphraseSteps(mode, input).find(
        (step) =>
          step.command.kind === "security" &&
          step.command.args[0] === "add-generic-password"
      )?.command
      if (write?.kind !== "security") throw new Error(`${mode} writes no item`)
      const args = write.args
      expect([args[args.indexOf("-s") + 1], args.at(-1)]).toEqual([
        read?.[1],
        read?.[2],
      ])
    }
  })
})

describe("renderPassphraseScript", () => {
  it("never puts a secret into an argument, the environment, a here-string or a trace", () => {
    for (const mode of ["set", "rotate", "repair"] as const) {
      const script = renderPassphraseScript(
        mode,
        passphraseSteps(mode, input),
        input
      )
      const lines = script.split("\n")
      // Each secret variable is only read by eido_quote, a comparison, or the `security -i` line.
      const uses = lines.filter((line) =>
        /\$\{?eido_(current|next)\b/.test(line)
      )
      for (const line of uses)
        expect(line).toMatch(
          /^(\[\[ |\(\( |eido_quote |eido_line=|if ! \{ eido_current=\$\()/
        )
      // The quoted copies go only into eido_line, and eido_line only into `print` on a pipe.
      expect(
        lines.filter(
          (line) =>
            line.includes("$eido_line") &&
            !line.includes('print -r -- "$eido_line" | ')
        )
      ).toEqual([])
      expect(
        lines.filter((line) =>
          /<<|set -[a-z]*[xv]|\bexport eido|\btee\b/.test(line)
        )
      ).toEqual([])
    }
  })
})

describe("planeInput and host keychain", () => {
  const env = { USER: "owner", HOME: "/Users/owner" }

  it("takes the gate's paths from the plane layout", () => {
    expect(planeInput(env)).toEqual({
      gateUser: "_eidogate",
      gateHome: "/Library/Application Support/Eido/home/gate",
      keychain:
        "/Library/Application Support/Eido/home/gate/Library/Keychains/eido/eido.keychain-db",
      gateLog: "/Library/Application Support/Eido/gate/gate.log",
      gateLabel: "com.eido.plane.gate",
    })
  })

  const run = async (argv: string[], environment: Record<string, string>) => {
    const out: string[] = []
    const err: string[] = []
    const calls: string[] = []
    const code = await main(["keychain", ...argv], {
      env: environment,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      run: (command) => {
        calls.push(command)
        return Promise.resolve({ code: 1, stdout: "", stderr: "" })
      },
      files: { read: () => undefined, stat: () => undefined },
      repoRoot: "/repo",
      execPath: "/opt/node",
      manifests: {},
    })
    // Printing a script reads nothing from the host.
    expect(calls).toEqual([])
    return { code, out, err }
  }

  it("prints the script for a mode", async () => {
    const { code, out, err } = await run(["repair"], env)
    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(out).toHaveLength(1)
    expect(out[0]?.endsWith("\n")).toBe(false)
    expect(out[0]?.split("\n").slice(0, 2)).toEqual([
      "#!/bin/zsh -f",
      "# Eido gate keychain passphrase: repair (#824). Generated by infra/host/keychain-passphrase.ts;",
    ])
  })

  it("refuses an unknown mode or extra arguments", async () => {
    for (const argv of [[], ["unlock"], ["set", "now"]]) {
      const { code, out, err } = await run(argv, env)
      expect([code, out, err]).toEqual([
        2,
        [],
        [
          "usage: host keychain <set|rotate|repair> > <file>; then sudo zsh -f <file>",
        ],
      ])
    }
  })

  it("refuses an environment with no user", async () => {
    const { code, out, err } = await run(["set"], {})
    expect([code, out, err]).toEqual([
      1,
      [],
      [
        'keychain-passphrase: "" is not a user name; run it as yourself, not with sudo',
      ],
    ])
  })

  it("says to run it as the owner when run as root", async () => {
    const { code, err } = await run(["set"], {
      USER: "root",
      HOME: "/var/root",
    })
    expect(code).toBe(1)
    expect(err).toEqual([
      "keychain-passphrase: the owner must be the person's own account, not root; run it as yourself, not with sudo",
    ])
  })
})

// The fake `security`: a tiny keychain whose state is files in the test dir. It parses
// `security -i` lines with its own port of the splitter in Apple's security.c (split_line).
const FAKE_SECURITY = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
const [dir, ...argv] = process.argv.slice(2)
const p = (name) => dir + "/" + name
// PWD, SHLVL and _ come from the /bin/sh wrapper and __CF_USER_TEXT_ENCODING from macOS, not from the script.
const { PWD, SHLVL, _, __CF_USER_TEXT_ENCODING, ...env } = process.env
appendFileSync(p("procs.jsonl"), JSON.stringify({ argv, env }) + "\n")
const fails = existsSync(p("fail")) ? readFileSync(p("fail"), "utf8").split("\n").filter(Boolean) : []
function split(line) {
  const out = []
  let arg = null, quote = null, escaped = false
  for (const ch of line) {
    if (arg === null) {
      if (/\s/.test(ch)) continue
      arg = ""
      if (ch === '"' || ch === "'") { quote = ch; continue }
    }
    if (escaped) { arg += ch; escaped = false; continue }
    if (ch === "\\") { escaped = true; continue }
    if (quote !== null && ch === quote) { out.push(arg); arg = null; quote = null; continue }
    if (quote === null && /\s/.test(ch)) { out.push(arg); arg = null; continue }
    arg += ch
  }
  if (arg !== null) out.push(arg)
  return out
}
const opt = (args, flag) => args[args.indexOf(flag) + 1]
const read = (name) => (existsSync(p(name)) ? readFileSync(p(name), "utf8") : undefined)
function run(args) {
  appendFileSync(p("commands.jsonl"), JSON.stringify(args) + "\n")
  const [cmd] = args
  const n = readFileSync(p("commands.jsonl"), "utf8").split("\n").filter((l) => l !== "" && JSON.parse(l)[0] === cmd).length
  if (fails.includes(cmd) || fails.includes(cmd + "@" + n)) return 1
  const last = args[args.length - 1]
  switch (cmd) {
    case "create-keychain":
      if (existsSync(last)) return 48
      writeFileSync(last, "keychain", { mode: 0o644 })
      writeFileSync(p("keychain.pw"), opt(args, "-p"))
      return 0
    case "set-keychain-settings":
      if (args.length !== 2) return 2
      writeFileSync(p("settings"), "no auto-lock")
      return 0
    case "set-keychain-password":
      if (read("keychain.pw") !== opt(args, "-o")) return 51
      writeFileSync(p("keychain.pw"), opt(args, "-p"))
      return 0
    case "add-generic-password":
      if (existsSync(p("item")) && !args.includes("-U")) return 45
      writeFileSync(p("item"), opt(args, "-w"))
      return 0
    case "find-generic-password":
      if (!existsSync(p("item"))) return 44
      if (args.includes("-w")) process.stdout.write(read("item") + "\n")
      return 0
  }
  return 2
}
if (argv[0] === "-i") {
  let result = 0
  for (const line of readFileSync(0, "utf8").split("\n")) if (line !== "") result = run(split(line))
  process.exitCode = result
} else process.exitCode = run(argv)
`

// Runs the generated scripts under the real zsh with fakes for every tool that needs root or
// touches a keychain. Nothing here reads or writes a real keychain.
describe.runIf(existsSync("/bin/zsh"))("the scripts under zsh", () => {
  let dir = ""
  let state = ""
  let fakes: PassphraseInput = input
  const OLD = `old "Qx7pw" \\ 'one' $(id)`
  const NEW = `new "Qx7pw" \\ 'two' $(id)`

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "eido-passphrase-")))
    state = join(dir, "state")
    const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
    const fake = async (name: string, lines: string[]) => {
      const path = join(dir, name)
      await writeFile(path, ["#!/bin/sh", ...lines, ""].join("\n"))
      await chmod(path, 0o755)
      return path
    }
    await writeFile(join(dir, "fake-security.mjs"), FAKE_SECURITY)
    const security = await fake("security", [
      `exec ${q(process.execPath)} ${q(join(dir, "fake-security.mjs"))} ${q(state)} "$@"`,
    ])
    const chroot = await fake("chroot", [
      `printf '%s\\n' "$*" >> ${q(join(state, "chroot.calls"))}`,
      `while [ "$1" != / ]; do shift; done; shift`,
      `exec "$@"`,
    ])
    const launchctl = await fake("launchctl", [
      `printf '%s\\n' "$*" >> ${q(join(state, "launchctl.calls"))}`,
    ])
    const id = await fake("id", ["echo 0"])
    fakes = {
      ...input,
      gateHome: join(dir, "home"),
      keychain: join(dir, "home", "Keychains", "eido.keychain-db"),
      tools: {
        security,
        chroot,
        env: "/usr/bin/env",
        chmod: "/bin/chmod",
        launchctl,
        id,
      },
    }
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await rm(state, { recursive: true, force: true })
    await rm(join(dir, "home"), { recursive: true, force: true })
    await mkdir(state)
    await mkdir(join(dir, "home", "Keychains"), { recursive: true })
  })

  /** A keychain and an item that already hold `passphrase`, as after a first set. */
  const existing = async (passphrase: string) => {
    await writeFile(fakes.keychain, "keychain", { mode: 0o600 })
    await writeFile(join(state, "keychain.pw"), passphrase)
    await writeFile(join(state, "item"), passphrase)
  }

  const run = async (mode: Mode, typed: string[], fail: string[] = []) => {
    if (fail.length > 0) await writeFile(join(state, "fail"), fail.join("\n"))
    const script = join(dir, `${mode}.zsh`)
    await writeFile(
      script,
      renderPassphraseScript(mode, passphraseSteps(mode, fakes), fakes)
    )
    const child = spawn("/bin/zsh", ["-f", script], {
      env: { PATH: "/usr/bin:/bin", EIDO_SECRET_PROBE: "env-probe" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin.end(typed.map((line) => `${line}\n`).join(""))
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    const code = await new Promise<number | null>((done) =>
      child.on("close", done)
    )
    const text = async (name: string) =>
      existsSync(join(state, name))
        ? await readFile(join(state, name), "utf8")
        : undefined
    const procs = ((await text("procs.jsonl")) ?? "")
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => JSON.parse(line))
    const commands = ((await text("commands.jsonl")) ?? "")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as string[])[0])
    return {
      code,
      stdout,
      stderr,
      procs,
      commands,
      keychainPassword: await text("keychain.pw"),
      item: await text("item"),
      kickstarts: await text("launchctl.calls"),
      chroots: await text("chroot.calls"),
    }
  }

  /** No process got a passphrase in its arguments or environment, and none got the owner's env. */
  const expectNoLeak = (procs: unknown[], chroots: string | undefined) => {
    const seen = JSON.stringify(procs) + (chroots ?? "")
    for (const secret of ["Qx7pw", "env-probe"])
      expect(seen).not.toContain(secret)
  }

  it("set: creates the keychain and the item with the typed passphrase, then restarts the gate", async () => {
    const result = await run("set", [NEW, NEW])
    expect(result.stderr).toBe(
      "New gate keychain passphrase: \nType it again: \n"
    )
    expect(result.code).toBe(0)
    expect(result.keychainPassword).toBe(NEW)
    expect(result.item).toBe(NEW)
    expect(result.commands).toEqual([
      "find-generic-password",
      "create-keychain",
      "set-keychain-settings",
      "add-generic-password",
    ])
    expect((await stat(fakes.keychain)).mode & 0o777).toBe(0o600)
    expect(result.kickstarts).toBe("kickstart -k system/com.eido.plane.gate\n")
    expect(result.chroots).toBe(
      "-u _eidogate -g _eidogate -G _eidogate / /usr/bin/env -i HOME=" +
        `${fakes.gateHome} ${fakes.tools?.security ?? ""} -i\n` +
        `-u _eidogate -g _eidogate -G _eidogate / /bin/chmod 600 ${fakes.keychain}\n` +
        "-u _eidogate -g _eidogate -G _eidogate / /usr/bin/env -i HOME=" +
        `${fakes.gateHome} ${fakes.tools?.security ?? ""} set-keychain-settings ${fakes.keychain}\n`
    )
    expectNoLeak(result.procs, result.chroots)
    // security ran with root's or the gate's home and nothing else.
    expect(result.procs.map((proc) => (proc as { env: unknown }).env)).toEqual([
      { HOME: "/var/root" },
      { HOME: fakes.gateHome },
      { HOME: fakes.gateHome },
      { HOME: "/var/root" },
    ])
  })

  it("set: stops before any change when the item already exists, or when the entries differ", async () => {
    await writeFile(join(state, "item"), OLD)
    const exists = await run("set", [NEW, NEW])
    expect(exists.code).toBe(1)
    expect(exists.commands).toEqual(["find-generic-password"])
    expect(exists.keychainPassword).toBeUndefined()
    await rm(join(state, "item"))
    await rm(join(state, "commands.jsonl"))
    const differ = await run("set", [NEW, OLD])
    expect(differ.code).toBe(1)
    expect(differ.stderr).toContain(
      "eido keychain set: The two entries differ. Nothing changed.\n"
    )
    expect(differ.commands).toEqual(["find-generic-password"])
    expect(existsSync(fakes.keychain)).toBe(false)
  })

  it("set: names repair when the item cannot be written after the keychain was created", async () => {
    const result = await run("set", [NEW, NEW], ["add-generic-password"])
    expect(result.code).toBe(1)
    expect(result.keychainPassword).toBe(NEW)
    expect(result.item).toBeUndefined()
    expect(result.stderr).toContain(
      "eido keychain set: The gate keychain exists with the new passphrase, but the System keychain item was not written, so the gate stays locked at its next start. Run repair and enter the same passphrase.\n"
    )
    expect(result.kickstarts).toBeUndefined()
  })

  it("set: goes on when auto-lock cannot be turned off yet", async () => {
    const result = await run("set", [NEW, NEW], ["set-keychain-settings"])
    expect(result.code).toBe(0)
    expect(result.item).toBe(NEW)
    expect(result.stderr).toContain(
      "eido keychain: Auto-lock could not be turned off now; the gate turns it off when it starts. Going on.\n"
    )
  })

  it("refuses passphrases the launcher could not pass through: empty, too long or not printable ASCII", async () => {
    for (const [typed, message] of [
      ["", "The passphrase is empty."],
      ["x".repeat(257), "The passphrase is longer than 256 characters."],
      [
        "café",
        "Use printable ASCII only (letters, digits, spaces, punctuation).",
      ],
      [
        "tab\there",
        "Use printable ASCII only (letters, digits, spaces, punctuation).",
      ],
    ] as const) {
      const result = await run("set", [typed, typed])
      expect([
        result.code,
        result.stderr.endsWith(`${message} Nothing changed.\n`),
      ]).toEqual([1, true])
      expect(existsSync(fakes.keychain)).toBe(false)
    }
  })

  it("rotate: changes the keychain from the item's passphrase, then the item, then restarts the gate", async () => {
    await existing(OLD)
    const result = await run("rotate", [NEW, NEW])
    expect(result.code).toBe(0)
    expect([result.keychainPassword, result.item]).toEqual([NEW, NEW])
    expect(result.commands).toEqual([
      "find-generic-password",
      "set-keychain-password",
      "add-generic-password",
    ])
    expect(result.kickstarts).toBe("kickstart -k system/com.eido.plane.gate\n")
    expectNoLeak(result.procs, result.chroots)
  })

  it("rotate: a failed keychain change leaves both on the old passphrase", async () => {
    await existing(OLD)
    const result = await run("rotate", [NEW, NEW], ["set-keychain-password"])
    expect(result.code).toBe(1)
    expect([result.keychainPassword, result.item]).toEqual([OLD, OLD])
    expect(result.kickstarts).toBeUndefined()
  })

  it("rotate: a failed item update changes the keychain back, so both stay on the old passphrase", async () => {
    await existing(OLD)
    const result = await run("rotate", [NEW, NEW], ["add-generic-password"])
    expect(result.code).toBe(1)
    expect([result.keychainPassword, result.item]).toEqual([OLD, OLD])
    expect(result.commands).toEqual([
      "find-generic-password",
      "set-keychain-password",
      "add-generic-password",
      "set-keychain-password",
    ])
    expect(result.stderr).toContain(
      "eido keychain rotate: The System keychain item could not be updated, so the keychain password was changed back. The keychain and the item hold the old passphrase. Fix the cause and rotate again.\n"
    )
    expect(result.kickstarts).toBeUndefined()
  })

  it("rotate: when changing back fails too, it says the keychain has the new passphrase and to run repair with it", async () => {
    await existing(OLD)
    const result = await run(
      "rotate",
      [NEW, NEW],
      ["add-generic-password", "set-keychain-password@2"]
    )
    expect(result.code).toBe(1)
    expect([result.keychainPassword, result.item]).toEqual([NEW, OLD])
    expect(result.stderr).toContain(
      "eido keychain rotate: Half done: the keychain now opens with the new passphrase, but the System keychain item still holds the old one, and changing the keychain back failed. The gate stays locked at its next start. Run repair and enter the new passphrase.\n"
    )
    // The way out it names: once the cause is fixed, repair with the new passphrase matches both.
    await rm(join(state, "fail"))
    const repaired = await run("repair", [NEW, NEW])
    expect(repaired.code).toBe(0)
    expect([repaired.keychainPassword, repaired.item]).toEqual([NEW, NEW])
  })

  it("rotate: refuses the current passphrase as the new one, and a missing item", async () => {
    await existing(OLD)
    const same = await run("rotate", [OLD, OLD])
    expect(same.code).toBe(1)
    expect(same.stderr).toContain(
      "eido keychain rotate: That is the current passphrase. Nothing changed.\n"
    )
    expect(same.commands).toEqual(["find-generic-password"])
    await rm(join(state, "item"))
    const missing = await run("rotate", [NEW, NEW])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toBe(
      "eido keychain rotate: The System keychain item com.eido.gate.keychain-unlock is missing or unreadable. Run repair with the passphrase from your password manager, then rotate. Nothing changed.\n"
    )
    expect(missing.keychainPassword).toBe(OLD)
  })

  it("repair: writes the item only when the keychain accepts the passphrase", async () => {
    await existing(OLD)
    await rm(join(state, "item"))
    const wrong = await run("repair", [NEW, NEW])
    expect(wrong.code).toBe(1)
    expect(wrong.item).toBeUndefined()
    expect(wrong.keychainPassword).toBe(OLD)
    const right = await run("repair", [OLD, OLD])
    expect(right.code).toBe(0)
    expect([right.keychainPassword, right.item]).toEqual([OLD, OLD])
    expect(right.kickstarts).toBe("kickstart -k system/com.eido.plane.gate\n")
    expectNoLeak(right.procs, right.chroots)
  })
})
