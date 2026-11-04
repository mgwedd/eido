// Synthetic fixtures for the allowed folders review. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
import { createHash } from "node:crypto"
import type {
  GateFileRoots,
  GateFileRootsPrepared,
  GateFileRootsRequest,
} from "@eido/schemas"
import type { PreparedFolders } from "@/lib/file-roots"
import type { DraftFolder } from "@/lib/file-roots-draft"

/** The list the owner signed earlier, as GET /file-roots returns it. */
const signedRoots: GateFileRoots = {
  roots: [
    {
      id: "notes",
      root: {
        path: "/Users/owner.example/Notes",
        dev: "1000004",
        ino: "2f81a3",
        trashDir: ".eido-trash",
      },
    },
    {
      id: "studio",
      root: {
        path: "/Users/owner.example/Studio",
        dev: "1000004",
        ino: "2f8a10",
        trashDir: ".eido-trash",
      },
    },
  ],
}

/** The request that re-identifies `signedRoots`, written out by hand. */
const reviewRequest: GateFileRootsRequest = {
  roots: [
    {
      id: "notes",
      path: "/Users/owner.example/Notes",
      trashDir: ".eido-trash",
    },
    {
      id: "studio",
      path: "/Users/owner.example/Studio",
      trashDir: ".eido-trash",
    },
  ],
}

/** What the host found: studio now points through a link to another volume. */
const identifiedRoots: GateFileRoots = {
  roots: [
    {
      id: "notes",
      root: {
        path: "/Users/owner.example/Notes",
        dev: "1000004",
        ino: "2f81a3",
        trashDir: ".eido-trash",
      },
    },
    {
      id: "studio",
      root: {
        path: "/Volumes/Work.example/Studio",
        dev: "1000009",
        ino: "a0c47e",
        trashDir: ".eido-trash",
      },
    },
  ],
}

/**
 * RFC 8785 for this shape only, written independently of the app's canonicalize: keys in
 * sorted order, ASCII strings, no whitespace.
 */
function canonicalRoots(roots: GateFileRoots): string {
  const items = roots.roots.map(
    ({ id, root }) =>
      `{"id":${JSON.stringify(id)},"root":{"dev":${JSON.stringify(root.dev)},"ino":${JSON.stringify(root.ino)},"path":${JSON.stringify(root.path)},"trashDir":${JSON.stringify(root.trashDir)}}}`
  )
  return `{"roots":[${items.join(",")}]}`
}

const NONCE = "N".repeat(43)
const CONTROL_ID = "ctl-0001"

/** A prepare response the gate would send for `roots`, hashed with node:crypto. */
function preparedFor(
  roots: GateFileRoots,
  over: Partial<GateFileRootsPrepared> = {}
): GateFileRootsPrepared {
  const id = over.id ?? CONTROL_ID
  const nonce = over.nonce ?? NONCE
  const payloadHash =
    over.payloadHash ??
    createHash("sha256").update(canonicalRoots(roots)).digest("hex")
  const challenge =
    over.challenge ??
    createHash("sha256")
      .update(
        JSON.stringify([
          "eido.control.v1",
          "policy.set",
          "file-roots",
          id,
          payloadHash,
          nonce,
        ])
      )
      .digest("base64url")
  return {
    id,
    purpose: "policy.set",
    target: "file-roots",
    payloadHash,
    nonce,
    challenge,
    roots,
  }
}

/** The first eight bytes of a base64url challenge as grouped hex, computed with Buffer. */
function challengeHex(challenge: string): string {
  const hex = Buffer.from(challenge, "base64url").subarray(0, 8).toString("hex")
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)} ${hex.slice(12, 16)}`
}

/** The checked review of `identifiedRoots`, written out by hand: studio resolved through a link. */
function reviewedFolders(): PreparedFolders {
  const prepared = preparedFor(identifiedRoots)
  const [notes, studio] = identifiedRoots.roots
  if (notes === undefined || studio === undefined)
    throw new Error("identifiedRoots holds notes and studio")
  return {
    prepared,
    folders: [
      {
        id: "notes",
        requested: "/Users/owner.example/Notes",
        root: notes.root,
      },
      {
        id: "studio",
        requested: "/Users/owner.example/Studio",
        root: studio.root,
      },
    ],
    challenge: new Uint8Array(Buffer.from(prepared.challenge, "base64url")),
  }
}

/** Editor rows from [id, path, trash name] triples, keyed by position. */
function draftRows(
  rows: readonly (readonly [string, string, string])[]
): DraftFolder[] {
  return rows.map(([id, path, trashDir], index) => ({
    key: `row-${index}`,
    id,
    path,
    trashDir,
  }))
}

/** The first folder an owner with no signed folders adds in the editor. */
const firstFolderRequest: GateFileRootsRequest = {
  roots: [
    {
      id: "rental",
      path: "/Users/owner.example/Rental",
      trashDir: ".eido-trash",
    },
  ],
}

/** What the host found for `firstFolderRequest`. */
const firstFolderIdentified: GateFileRoots = {
  roots: [
    {
      id: "rental",
      root: {
        path: "/Users/owner.example/Rental",
        dev: "1000004",
        ino: "3c0d11",
        trashDir: ".eido-trash",
      },
    },
  ],
}

export {
  CONTROL_ID,
  draftRows,
  firstFolderIdentified,
  firstFolderRequest,
  reviewedFolders,
  NONCE,
  challengeHex,
  identifiedRoots,
  preparedFor,
  reviewRequest,
  signedRoots,
}
