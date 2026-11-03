// Synthetic fixtures for the allowed folders review. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
import { createHash } from "node:crypto"
import type {
  GateFileRoots,
  GateFileRootsPrepared,
  GateFileRootsRequest,
} from "@eido/schemas"

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

export {
  CONTROL_ID,
  NONCE,
  challengeHex,
  identifiedRoots,
  preparedFor,
  reviewRequest,
  signedRoots,
}
