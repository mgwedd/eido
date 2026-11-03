import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Intent } from "@eido/schemas"
import { createExecutor } from "../executor"
import { propose } from "../intents"
import { issueNonce, verifyApproval } from "../approvals"
import { verifyChain } from "../audit"
import {
  FILE_OPS,
  manifest,
  setup,
  assertion,
  deviceChallenge,
  testAuthenticator,
  WEBAUTHN,
  controlAuthorization,
  signedPin,
  socketAddress,
} from "../test-fixtures"
import type { Setup } from "../test-fixtures"
import { runGate } from "../../main"
import { runningGate } from "../runtime"
import { createIntentClient, createFileClient } from "../client"
import { fileHelper } from "./file-helper"
import { prepareFileRoots, setFileRoots } from "./file-roots"

// CI's three-platform helper job supplies a binary built from the pinned Rust toolchain.
const binary = process.env["EIDO_FILE_HELPER"]
let fixture: Setup | undefined
let base: string | undefined
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
  if (base) rmSync(base, { recursive: true, force: true })
  base = undefined
})

describe.skipIf(binary === undefined)("native file intent execution", () => {
  async function start() {
    fixture = setup([manifest("files", FILE_OPS)])
    const s = fixture
    base = realpathSync.native(
      mkdtempSync(join(tmpdir(), "eido-executor-files-"))
    )
    const root = join(base, "docs")
    mkdirSync(join(root, "archive"), { recursive: true })
    const path = binary ?? ""
    const helper = fileHelper({
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    })
    const prepared = await prepareFileRoots(s.db, helper, {
      roots: [{ id: "docs", path: root, trashDir: ".eido-trash" }],
    })
    const roots: unknown = JSON.parse(prepared.payload)
    setFileRoots(s.db, roots, controlAuthorization(s.db, prepared))
    const executor = createExecutor(
      s.db,
      [],
      () => Promise.reject(new Error("network forbidden")),
      helper
    )
    function proposal(intent: Intent) {
      const p = propose(s.db, s.policy, { intent, origin: "reactive" })
      if (!p.ok) throw new Error(p.code)
      return p.intentId
    }
    function approve(id: string) {
      const auth = testAuthenticator()
      s.db
        .prepare(
          "INSERT INTO credentials(credential_id,public_key,sign_count,created_at) VALUES (?,?,0,?)"
        )
        .run(auth.credentialId, auth.publicKey, new Date().toISOString())
      const nonce = issueNonce(s.db, id)
      if (!nonce.ok) throw new Error("prepare failed")
      expect(
        verifyApproval(s.db, WEBAUTHN, {
          intentId: id,
          nonce: nonce.nonce,
          assertion: assertion(
            auth,
            deviceChallenge(nonce.payloadHash, id, nonce.nonce)
          ),
        }).ok
      ).toBe(true)
    }
    return { ...s, root, executor, proposal, approve }
  }

  it("production wiring executes a proposal received on the gate data socket", async () => {
    base = realpathSync.native(
      mkdtempSync(join(tmpdir(), "eido-file-runtime-"))
    )
    const root = join(base, "docs")
    mkdirSync(root)
    const path = binary ?? ""
    const config = {
      dataDir: join(base, "gate"),
      socketPath: socketAddress(base, "data.sock"),
      controlSocketPath: socketAddress(base, "control.sock"),
      webAuthn: WEBAUTHN,
      fileHelper: {
        path,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      },
    }
    const gate = await runGate(config)
    try {
      const db = runningGate().db
      signedPin(db, manifest("files", FILE_OPS))
      const prepared = await prepareFileRoots(
        db,
        fileHelper(config.fileHelper),
        { roots: [{ id: "docs", path: root, trashDir: ".eido-trash" }] }
      )
      const roots: unknown = JSON.parse(prepared.payload)
      setFileRoots(db, roots, controlAuthorization(db, prepared))
      const proposal = await createIntentClient({
        socketPath: config.socketPath,
      }).propose({
        intent: {
          kind: "file.create",
          args: {
            root: "docs",
            path: "socket.txt",
            content: "through real gate",
          },
        },
        origin: "reactive",
      })
      expect(proposal).toMatchObject({ tier: "auto", state: "executed" })
      expect(readFileSync(join(root, "socket.txt"), "utf8")).toBe(
        "through real gate"
      )
      const files = createFileClient({ socketPath: config.socketPath })
      expect((await files.roots()).roots.map((entry) => entry.id)).toEqual([
        "docs",
      ])
      expect(
        await files.perform({
          op: "read",
          root: "docs",
          path: "socket.txt",
          maxBytes: 1024,
        })
      ).toEqual({
        ok: true,
        op: "read",
        contentBase64: "dGhyb3VnaCByZWFsIGdhdGU=",
      })
      expect(
        await files.perform({ op: "list", root: "docs", path: "" })
      ).toEqual({
        ok: true,
        op: "list",
        entries: [{ name: "socket.txt", kind: "file" }],
        truncated: false,
      })
      await expect(
        files.perform({
          op: "read",
          root: "unknown",
          path: "socket.txt",
          maxBytes: 1024,
        })
      ).rejects.toMatchObject({ status: 403, code: "forbidden" })
      expect(verifyChain(db).ok).toBe(true)
    } finally {
      await gate.close()
    }
  })

  it("executes real create/rename/move/Trash and restores their bytes through Undo", async () => {
    const f = await start()
    const content = "synthetic native executor bytes"
    const create = f.proposal({
      kind: "file.create",
      args: { root: "docs", path: "a.txt", content },
    })
    expect(existsSync(join(f.root, "a.txt"))).toBe(false)
    expect((await f.executor.execute(create)).ok).toBe(true)
    expect(readFileSync(join(f.root, "a.txt"), "utf8")).toBe(content)
    const rename = f.proposal({
      kind: "file.rename",
      args: { root: "docs", path: "a.txt", newName: "b.txt" },
    })
    expect((await f.executor.execute(rename)).ok).toBe(true)
    const move = f.proposal({
      kind: "file.move",
      args: { root: "docs", path: "b.txt", toPath: "archive/b.txt" },
    })
    expect((await f.executor.execute(move)).ok).toBe(true)
    expect(readFileSync(join(f.root, "archive", "b.txt"), "utf8")).toBe(content)
    expect((await f.executor.undo(move)).ok).toBe(true)
    expect((await f.executor.undo(rename)).ok).toBe(true)
    const trash = f.proposal({
      kind: "file.delete",
      args: { root: "docs", path: "a.txt" },
    })
    expect((await f.executor.execute(trash)).ok).toBe(false)
    expect(readFileSync(join(f.root, "a.txt"), "utf8")).toBe(content)
    f.approve(trash)
    expect((await f.executor.execute(trash)).ok).toBe(true)
    expect(existsSync(join(f.root, "a.txt"))).toBe(false)
    expect((await f.executor.undo(trash)).ok).toBe(true)
    expect(readFileSync(join(f.root, "a.txt"), "utf8")).toBe(content)
    expect((await f.executor.undo(create)).ok).toBe(true)
    const recovered = readdirSync(join(f.root, ".eido-trash")).map((name) =>
      readFileSync(join(f.root, ".eido-trash", name), "utf8")
    )
    expect(recovered).toEqual([content])
    expect(verifyChain(f.db).ok).toBe(true)
  })

  it("refuses overwrite and root replacement while preserving native bytes", async () => {
    const f = await start()
    writeFileSync(join(f.root, "a.txt"), "source")
    writeFileSync(join(f.root, "b.txt"), "destination")
    const move = f.proposal({
      kind: "file.move",
      args: { root: "docs", path: "a.txt", toPath: "b.txt" },
    })
    expect(await f.executor.execute(move)).toEqual({
      ok: false,
      code: "file_exists",
    })
    expect(readFileSync(join(f.root, "a.txt"), "utf8")).toBe("source")
    expect(readFileSync(join(f.root, "b.txt"), "utf8")).toBe("destination")
    const create = f.proposal({
      kind: "file.create",
      args: { root: "docs", path: "new.txt", content: "new bytes" },
    })
    renameSync(f.root, `${f.root}-moved`)
    mkdirSync(f.root)
    expect(await f.executor.execute(create)).toEqual({
      ok: false,
      code: "file_root_changed",
    })
    expect(readdirSync(f.root)).toEqual([])
  })
})
