import type { GateFileHelperResponse } from "@eido/schemas"

// Test support: the native helper's `list` over the in-memory disk doubles the file tests keep
// (a map from root-relative path to bytes). Folders exist only through the files under them.

/** One folder's entries, as the helper lists them: the trash folder is hidden at the root. */
export function listDisk(
  disk: ReadonlyMap<string, string>,
  trashDir: string,
  path: string
): GateFileHelperResponse {
  const prefix = path === "" ? "" : `${path}/`
  const entries = new Map<string, "file" | "directory">()
  for (const key of disk.keys()) {
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    const slash = rest.indexOf("/")
    const name = slash < 0 ? rest : rest.slice(0, slash)
    if (path === "" && name === trashDir) continue
    entries.set(name, slash < 0 ? "file" : "directory")
  }
  if (path !== "" && entries.size === 0)
    return { ok: false, code: "not_found", message: "not found" }
  return {
    ok: true,
    op: "list",
    entries: [...entries].map(([name, kind]) => ({ name, kind })),
    truncated: false,
  }
}
