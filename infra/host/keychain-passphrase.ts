// The gate keychain passphrase runbook as scripts (#824, decided in #780): first set, rotate and
// item repair. Each mode is a list of steps, rendered as a zsh script that the owner reviews and
// runs with `sudo zsh -f`. Agents never run it.
//
// The passphrase is typed once (twice, to confirm) at a hidden prompt of the script itself. It is
// only ever in a variable of that one root shell: `security` gets it on stdin, in interactive mode
// (`security -i`), from a `print` builtin in the shell's own pipeline. It is never in a process's
// arguments or environment, the shell history or a file. `security add-generic-password` prompts
// for the item's data only when `-w` is its last argument, which leaves no room for the System
// keychain path after it; without the path the item would go to the default keychain of the
// caller's session, which under sudo is the owner's. Hence one prompt here instead of the tool's.
//
// Usage, from the repo root, as the owner (host/cli.ts hands `keychain` here):
//   node --import ./infra/ts-hooks.ts infra/host/bin.ts keychain set > ~/eido-keychain.zsh
//   less ~/eido-keychain.zsh && sudo zsh -f ~/eido-keychain.zsh
import { dirname } from "node:path"

import {
  KEYCHAIN_UNLOCK_SERVICE,
  LAUNCHER_TOOLS,
  SYSTEM_KEYCHAIN,
} from "./gate-launcher.ts"
import { DEFAULT_FIRST_ID, LABELS, NAMES, planeLayout } from "./plane.ts"

export const MODES = ["set", "rotate", "repair"] as const
export type Mode = (typeof MODES)[number]

/** The script's two secret variables: what the item and keychain hold now, and what they get. */
export type Secret = "current" | "next"

/** An argument of a `security` command: fixed text, or a secret that goes through stdin. */
export type Word = string | { secret: Secret }

/** Who runs a `security` command: root, for the System keychain, or the gate user, for its own. */
export type Actor = "root" | "gate"

/** A command that can fail: the script checks it and stops (or warns) when it does. */
export type Check =
  /** A path the script checks before it changes anything. */
  | { kind: "path"; path: string; is: "dir" | "file" | "absent" }
  /** That the System keychain item does not exist; only its attributes are read, never its data. */
  | { kind: "no-item" }
  /** Reads the item's data into a secret, through a command substitution. */
  | { kind: "read-item"; into: Secret }
  | { kind: "security"; as: Actor; args: readonly Word[] }
  | { kind: "chmod"; mode: string; path: string }
  | { kind: "kickstart"; label: string }

/** A shell builtin with nothing to check. */
export type Action =
  /** A hidden prompt, entered twice; `unlike` refuses the value already in that secret. */
  | { kind: "prompt"; into: Secret; label: string; unlike?: Secret }
  /** From here on, Ctrl-C and hangups cannot stop the script between two changes. */
  | { kind: "hold-signals" }
  | { kind: "say"; text: string }

export type Command = Check | Action

export type PassphraseStep =
  | { command: Action }
  | {
      command: Check
      /** Printed when the command fails, before the script stops: what state it left, what to do. */
      onFail: string
      /** Run when the command fails, to put back the state before it; its own failure has its own text. */
      undo?: { command: Check; onFail: string }
      /** A failure is reported and the script goes on. */
      mayFail?: boolean
    }

export type Tools = {
  security: string
  chroot: string
  env: string
  chmod: string
  launchctl: string
  id: string
}

export const TOOLS: Tools = {
  security: LAUNCHER_TOOLS.security,
  chroot: LAUNCHER_TOOLS.chroot,
  env: LAUNCHER_TOOLS.env,
  chmod: "/bin/chmod",
  launchctl: "/bin/launchctl",
  id: "/usr/bin/id",
}

export type PassphraseInput = {
  /** The gate user, which owns the keychain. */
  gateUser: string
  /** Its home, the HOME its `security` commands run with. */
  gateHome: string
  /** The gate keychain file. */
  keychain: string
  /** The gate's own log, where a start records `keychain_unlocked` or `keychain_unlock_failed`. */
  gateLog: string
  /** The gate daemon's launchd label. */
  gateLabel: string
  tools?: Tools
}

/** The item's fixed arguments: the same service and keychain the launcher reads. */
function item(input: PassphraseInput, secret: Secret): Word[] {
  return [
    "add-generic-password",
    "-U",
    "-a",
    input.gateUser,
    "-s",
    KEYCHAIN_UNLOCK_SERVICE,
    "-T",
    (input.tools ?? TOOLS).security,
    "-w",
    { secret },
    SYSTEM_KEYCHAIN,
  ]
}

function changePassword(
  input: PassphraseInput,
  from: Secret,
  to: Secret
): Check {
  return {
    kind: "security",
    as: "gate",
    args: [
      "set-keychain-password",
      "-o",
      { secret: from },
      "-p",
      { secret: to },
      input.keychain,
    ],
  }
}

function restart(input: PassphraseInput, changed: string): PassphraseStep[] {
  return [
    {
      command: { kind: "kickstart", label: input.gateLabel },
      onFail: `${changed}, but the gate did not restart. Restart it with: sudo launchctl kickstart -k system/${input.gateLabel}`,
    },
    {
      command: {
        kind: "say",
        text: `Done. The gate restarted; ${input.gateLog} gets keychain_unlocked when the unlock worked, keychain_unlock_failed when it did not.`,
      },
    },
  ]
}

/** First set: a new gate keychain and the item, both with one passphrase, then a gate restart. */
export function setSteps(input: PassphraseInput): PassphraseStep[] {
  const dir = dirname(input.keychain)
  return [
    {
      command: { kind: "path", path: dir, is: "dir" },
      onFail: `${dir} is missing. Apply the plane plan first (infra/plane-split.md). Nothing changed.`,
    },
    {
      command: { kind: "path", path: input.keychain, is: "absent" },
      onFail: `${input.keychain} already exists. To change its passphrase use rotate; if the System keychain item is lost use repair. Nothing changed.`,
    },
    {
      command: { kind: "no-item" },
      onFail: `The System keychain item ${KEYCHAIN_UNLOCK_SERVICE} already exists but there is no gate keychain. Delete the item (sudo security delete-generic-password -s ${KEYCHAIN_UNLOCK_SERVICE} ${SYSTEM_KEYCHAIN}) and run set again. Nothing changed.`,
    },
    {
      command: {
        kind: "prompt",
        into: "next",
        label: "New gate keychain passphrase",
      },
    },
    { command: { kind: "hold-signals" } },
    {
      command: {
        kind: "security",
        as: "gate",
        args: ["create-keychain", "-p", { secret: "next" }, input.keychain],
      },
      onFail: `The gate keychain could not be created. If ${input.keychain} now exists, check it holds no credentials (it is new), move it aside as the gate user and run set again; otherwise nothing changed.`,
    },
    {
      command: { kind: "chmod", mode: "600", path: input.keychain },
      onFail: `The gate keychain exists but is not mode 0600, so the gate refuses it. Run: sudo -u ${input.gateUser} chmod 600 '${input.keychain}', then repair with the same passphrase.`,
    },
    {
      // The gate turns auto-lock off at every start too (#821); this only makes it so from the start.
      command: {
        kind: "security",
        as: "gate",
        args: ["set-keychain-settings", input.keychain],
      },
      onFail:
        "Auto-lock could not be turned off now; the gate turns it off when it starts. Going on.",
      mayFail: true,
    },
    {
      command: { kind: "security", as: "root", args: item(input, "next") },
      onFail: `The gate keychain exists with the new passphrase, but the System keychain item was not written, so the gate stays locked at its next start. Run repair and enter the same passphrase.`,
    },
    ...restart(input, "The keychain and the item are set"),
  ]
}

/**
 * Rotate: the keychain password changes first, from the passphrase in the item, then the item.
 * If the item cannot be written the keychain password is changed back, so a failed step leaves the
 * keychain and the item matching: the gate unlocks at its next start either way.
 */
export function rotateSteps(input: PassphraseInput): PassphraseStep[] {
  return [
    {
      command: { kind: "path", path: input.keychain, is: "file" },
      onFail: `${input.keychain} is missing. Use set for a first keychain. Nothing changed.`,
    },
    {
      command: { kind: "read-item", into: "current" },
      onFail: `The System keychain item ${KEYCHAIN_UNLOCK_SERVICE} is missing or unreadable. Run repair with the passphrase from your password manager, then rotate. Nothing changed.`,
    },
    {
      command: {
        kind: "prompt",
        into: "next",
        label: "New gate keychain passphrase",
        unlike: "current",
      },
    },
    { command: { kind: "hold-signals" } },
    {
      command: changePassword(input, "current", "next"),
      onFail:
        "The keychain password did not change. The keychain and the item still hold the old passphrase. Nothing changed.",
    },
    {
      command: { kind: "security", as: "root", args: item(input, "next") },
      undo: {
        command: changePassword(input, "next", "current"),
        onFail:
          "Half done: the keychain now opens with the new passphrase, but the System keychain item still holds the old one, and changing the keychain back failed. The gate stays locked at its next start. Run repair and enter the new passphrase.",
      },
      onFail:
        "The System keychain item could not be updated, so the keychain password was changed back. The keychain and the item hold the old passphrase. Fix the cause and rotate again.",
    },
    ...restart(input, "The keychain and the item hold the new passphrase"),
  ]
}

/**
 * Repair: writes the item again from the keychain's passphrase, after it was lost or went stale.
 * The passphrase is checked against the keychain first, by a password change to the same value,
 * which fails on a wrong one and changes nothing.
 */
export function repairSteps(input: PassphraseInput): PassphraseStep[] {
  return [
    {
      command: { kind: "path", path: input.keychain, is: "file" },
      onFail: `${input.keychain} is missing. Use set for a first keychain. Nothing changed.`,
    },
    {
      command: {
        kind: "prompt",
        into: "next",
        label: "Gate keychain passphrase (from your password manager)",
      },
    },
    { command: { kind: "hold-signals" } },
    {
      command: changePassword(input, "next", "next"),
      onFail:
        "The gate keychain did not accept that passphrase. Nothing changed. If the passphrase is lost too, see infra/keychain-vault.md.",
    },
    {
      command: { kind: "security", as: "root", args: item(input, "next") },
      onFail:
        "The System keychain item could not be written. Nothing changed. Fix the cause and repair again.",
    },
    ...restart(input, "The item is set"),
  ]
}

export function passphraseSteps(
  mode: Mode,
  input: PassphraseInput
): PassphraseStep[] {
  switch (mode) {
    case "set":
      return setSteps(input)
    case "rotate":
      return rotateSteps(input)
    case "repair":
      return repairSteps(input)
  }
}

/** Single-quoted for zsh: no expansion applies to the value. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Double-quoted for `security -i`'s own line splitter, where a backslash escapes the next byte. */
function lineQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

const VAR: Record<Secret, string> = {
  current: "eido_current",
  next: "eido_next",
}
/** The secret quoted for `security -i`, as the script's `eido_quote` leaves it. */
const QUOTED: Record<Secret, string> = {
  current: "eido_current_q",
  next: "eido_next_q",
}

/** The longest passphrase: a `security -i` line holds 4095 bytes, and a rotation carries two. */
export const MAX_PASSPHRASE = 256

/** chroot(8) to `/` as the gate user, with its own group only, in the same process. */
function drop(tools: Tools, input: PassphraseInput): string[] {
  const user = input.gateUser
  return [tools.chroot, "-u", user, "-g", user, "-G", user, "/"]
}

/** An empty environment but HOME, so no setting of the caller's reaches `security`. */
function runner(tools: Tools, input: PassphraseInput, as: Actor): string[] {
  return as === "root"
    ? [tools.env, "-i", "HOME=/var/root"]
    : [...drop(tools, input), tools.env, "-i", `HOME=${input.gateHome}`]
}

/** The command as zsh lines that set it up, then one condition that is true when it worked. */
function renderCommand(
  command: Check,
  input: PassphraseInput,
  tools: Tools
): { setup: string[]; test: string } {
  switch (command.kind) {
    case "path": {
      const path = quote(command.path)
      const test = {
        dir: `[[ -d ${path} && ! -L ${path} ]]`,
        file: `[[ -f ${path} && ! -L ${path} ]]`,
        absent: `[[ ! -e ${path} && ! -L ${path} ]]`,
      }[command.is]
      return { setup: [], test }
    }
    case "no-item": {
      const probe = [
        ...runner(tools, input, "root"),
        tools.security,
        "find-generic-password",
        "-s",
        KEYCHAIN_UNLOCK_SERVICE,
        SYSTEM_KEYCHAIN,
      ]
        .map(quote)
        .join(" ")
      return { setup: [], test: `! ${probe} >/dev/null 2>&1` }
    }
    case "read-item": {
      const read = [
        ...runner(tools, input, "root"),
        tools.security,
        "find-generic-password",
        "-s",
        KEYCHAIN_UNLOCK_SERVICE,
        "-w",
        SYSTEM_KEYCHAIN,
      ]
        .map(quote)
        .join(" ")
      const name = VAR[command.into]
      return {
        setup: [],
        test: `${name}=$(${read} 2>/dev/null) && [[ -n "$${name}" ]] && eido_quote "$${name}" && ${QUOTED[command.into]}=$REPLY`,
      }
    }
    case "security": {
      const prefix = [...runner(tools, input, command.as), tools.security]
        .map(quote)
        .join(" ")
      if (command.args.every((word) => typeof word === "string"))
        return {
          setup: [],
          test: `${prefix} ${command.args.map((word) => quote(word)).join(" ")} >/dev/null`,
        }
      // One `security -i` line, built in the shell: fixed words quoted here, secrets by the shell.
      const line = command.args
        .map((word) =>
          typeof word === "string"
            ? quote(lineQuote(word))
            : `"$${QUOTED[word.secret]}"`
        )
        .join("' '")
      return {
        setup: [`eido_line=${line}`],
        test: `print -r -- "$eido_line" | ${prefix} -i >/dev/null`,
      }
    }
    case "chmod":
      return {
        setup: [],
        test: [...drop(tools, input), tools.chmod, command.mode, command.path]
          .map(quote)
          .join(" "),
      }
    case "kickstart":
      return {
        setup: [],
        test: [tools.launchctl, "kickstart", "-k", `system/${command.label}`]
          .map(quote)
          .join(" "),
      }
  }
}

function renderPrompt(command: Extract<Action, { kind: "prompt" }>): string[] {
  const name = VAR[command.into]
  const lines = [
    `print -u2 -n -r -- ${quote(`${command.label}: `)}`,
    `IFS= read -rs ${name} || eido_fail 'No passphrase was read. Nothing changed.'`,
    "print -u2",
    `print -u2 -n -r -- 'Type it again: '`,
    `IFS= read -rs eido_again || eido_fail 'No passphrase was read. Nothing changed.'`,
    "print -u2",
    `[[ "$${name}" == "$eido_again" ]] || eido_fail 'The two entries differ. Nothing changed.'`,
    "unset eido_again",
    `[[ -n "$${name}" ]] || eido_fail 'The passphrase is empty. Nothing changed.'`,
    `(( \${#${name}} <= ${String(MAX_PASSPHRASE)} )) || eido_fail ${quote(`The passphrase is longer than ${String(MAX_PASSPHRASE)} characters. Nothing changed.`)}`,
    // `security find-generic-password -w` prints data with any other byte as hex: the gate would
    // get the hex, not the passphrase.
    `[[ "$${name}" != *[^\\ -~]* ]] || eido_fail 'Use printable ASCII only (letters, digits, spaces, punctuation). Nothing changed.'`,
  ]
  if (command.unlike !== undefined)
    lines.push(
      `[[ "$${name}" != "$${VAR[command.unlike]}" ]] || eido_fail 'That is the current passphrase. Nothing changed.'`
    )
  lines.push(`eido_quote "$${name}"; ${QUOTED[command.into]}=$REPLY`)
  return lines
}

function renderStep(
  step: PassphraseStep,
  input: PassphraseInput,
  tools: Tools
): string[] {
  if (!("onFail" in step)) {
    const { command } = step
    switch (command.kind) {
      case "prompt":
        return renderPrompt(command)
      case "hold-signals":
        return ["trap '' INT TERM HUP QUIT TSTP"]
      case "say":
        return [`print -r -- ${quote(command.text)}`]
    }
  }
  const { setup, test } = renderCommand(step.command, input, tools)
  const fail = (text: string) =>
    step.mayFail === true
      ? `print -u2 -r -- ${quote(`eido keychain: ${text}`)}`
      : `eido_fail ${quote(text)}`
  const lines = [...setup]
  if (step.undo === undefined) {
    lines.push(`if ! { ${test}; }; then`, `  ${fail(step.onFail)}`, "fi")
  } else {
    const undo = renderCommand(step.undo.command, input, tools)
    lines.push(
      `if ! { ${test}; }; then`,
      ...undo.setup.map((text) => `  ${text}`),
      `  if { ${undo.test}; }; then`,
      `    ${fail(step.onFail)}`,
      "  fi",
      `  ${fail(step.undo.onFail)}`,
      "fi"
    )
  }
  if (setup.length > 0) lines.push("unset eido_line")
  return lines
}

/** The zsh script for `sudo zsh -f`. */
export function renderPassphraseScript(
  mode: Mode,
  steps: readonly PassphraseStep[],
  input: PassphraseInput
): string {
  const tools = input.tools ?? TOOLS
  return [
    "#!/bin/zsh -f",
    `# Eido gate keychain passphrase: ${mode} (#824). Generated by infra/host/keychain-passphrase.ts;`,
    "# review it, then run it with `sudo zsh -f <this file>`. It prompts for the passphrase and keeps",
    "# it in this shell only: never in an argument, the environment, the history or a file.",
    "set -u",
    "umask 077",
    // No core file can hold the passphrase.
    "ulimit -c 0",
    "export LC_ALL=C",
    `if [[ $(${quote(tools.id)} -u) != 0 ]]; then print -u2 -r -- 'eido keychain: run this with sudo zsh -f'; exit 1; fi`,
    `typeset ${VAR.current}= ${VAR.next}= ${QUOTED.current}= ${QUOTED.next}= eido_again= eido_line=`,
    `eido_forget() { unset ${VAR.current} ${VAR.next} ${QUOTED.current} ${QUOTED.next} eido_again eido_line REPLY }`,
    `eido_fail() { eido_forget; print -u2 -r -- "eido keychain ${mode}: $1"; exit 1 }`,
    // A backslash or a double quote inside the passphrase is escaped for `security -i`.
    `eido_quote() { REPLY=\${1//\\\\/\\\\\\\\}; REPLY="\\"\${REPLY//\\"/\\\\\\"}\\"" }`,
    ...steps.flatMap((step) => renderStep(step, input, tools)),
    "eido_forget",
    "",
  ].join("\n")
}

/** The gate's paths from the plane layout, as `host plane` lays them out. */
export function planeInput(
  env: Readonly<Record<string, string | undefined>>
): PassphraseInput {
  const layout = planeLayout({
    owner: env.USER ?? "",
    ownerHome: env.HOME ?? "",
    firstId: DEFAULT_FIRST_ID,
    env,
  })
  return {
    gateUser: NAMES.gate,
    gateHome: layout.gateHome,
    keychain: layout.keychain,
    gateLog: `${layout.gateDir}/gate.log`,
    gateLabel: LABELS.gate,
  }
}

export const KEYCHAIN_USAGE =
  "usage: host keychain <set|rotate|repair> > <file>; then sudo zsh -f <file>"

function isMode(value: string | undefined): value is Mode {
  return MODES.some((mode) => mode === value)
}

/** `host keychain <mode>`: prints the script for one mode as one line block; it runs nothing. */
export function keychain(
  argv: readonly string[],
  deps: {
    env: Readonly<Record<string, string | undefined>>
    out: (line: string) => void
    err: (line: string) => void
  }
): number {
  const [mode, ...rest] = argv
  if (!isMode(mode) || rest.length > 0) {
    deps.err(KEYCHAIN_USAGE)
    return 2
  }
  let input: PassphraseInput
  try {
    input = planeInput(deps.env)
  } catch (error) {
    deps.err(
      `keychain-passphrase: ${(error as Error).message}; run it as yourself, not with sudo`
    )
    return 1
  }
  const script = renderPassphraseScript(
    mode,
    passphraseSteps(mode, input),
    input
  )
  deps.out(script.replace(/\n$/, ""))
  return 0
}
