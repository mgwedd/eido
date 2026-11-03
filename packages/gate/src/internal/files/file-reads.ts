import type { DatabaseSync } from "node:sqlite"
import type {
  GateFileHelperResponse,
  GateFileRoots,
  GateLocalFileRequest,
} from "@eido/schemas"
import { validateGateLocalFileRequest } from "@eido/schemas"
import { append } from "../audit"
import { payloadHash } from "../canonical"
import { approvedFileRoot, approvedFileRoots } from "./file-roots"
import type { FileHelper } from "./file-helper"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"

export type FileReads = {
  roots(): GateFileRoots
  perform(request: GateLocalFileRequest): Promise<GateFileHelperResponse>
}

export function createFileReads(
  db: DatabaseSync,
  helper: FileHelper
): FileReads {
  return {
    roots: () => approvedFileRoots(db) ?? { roots: [] },
    async perform(request) {
      const root = approvedFileRoot(db, request.root)
      if (root === undefined)
        return {
          ok: false,
          code: "invalid_path",
          message: "file root is unavailable",
        }
      const result = await helper(
        request.op === "read"
          ? { op: "read", root, path: request.path, maxBytes: request.maxBytes }
          : { op: "list", root, path: request.path }
      )
      append(db, {
        actor: "data-plane",
        action: `files.${request.op}`,
        target: request.root,
        detailHash: payloadHash({ op: request.op, ok: result.ok }),
      })
      return result
    },
  }
}

export async function fileReadRoute(
  request: GateRequest,
  files?: FileReads
): Promise<Reply | undefined> {
  const roots = request.method === "GET" && request.path === "/file-roots"
  if (!roots && !(request.method === "POST" && request.path === "/files"))
    return undefined
  if (files === undefined)
    return apiError(503, "unavailable", "file helper is not configured")
  if (roots) return { status: 200, body: files.roots() }
  const body = await request.body()
  if (!body.ok)
    return apiError(413, "invalid_request", "file read request is too large")
  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    return apiError(400, "invalid_request", "invalid file read request")
  }
  const checked = validateGateLocalFileRequest(parsed)
  if (!checked.ok)
    return apiError(400, "invalid_request", "invalid file read request")
  try {
    const result = await files.perform(checked.value)
    if (result.ok) return { status: 200, body: result }
    if (["invalid_path", "symlink", "root_changed"].includes(result.code))
      return apiError(403, "forbidden", "file path is not allowed")
    if (result.code === "not_found")
      return apiError(404, "not_found", "file was not found")
    return apiError(503, "unavailable", "file read could not be completed")
  } catch {
    return apiError(503, "unavailable", "file read could not be completed")
  }
}
