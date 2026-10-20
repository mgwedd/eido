import type { ProtonMailSource } from "./source"

const encoder = new TextEncoder()

/** Raw RFC 5322 text with CRLF line endings, as bytes. All content is ASCII (wire encodings carry the rest). */
export function raw(lines: string[]): Uint8Array {
  return encoder.encode(lines.join("\r\n") + "\r\n")
}

/** A plain single-part message. */
export function plainMessage(
  id: string,
  options: {
    subject?: string
    body?: string
    date?: string
    extra?: string[]
  } = {}
): Uint8Array {
  return raw([
    "From: Ada Example <ada@example.com>",
    "To: Assistant <assistant@example.com>",
    `Subject: ${options.subject ?? `subject ${id}`}`,
    `Message-ID: <${id}@example.com>`,
    `Date: ${options.date ?? "Mon, 05 Oct 2026 10:00:00 +0000"}`,
    ...(options.extra ?? []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.body ?? `body ${id}`,
  ])
}

type Folder = {
  uidValidity: string
  uidNext: number
  messages: { uid: number; raw: Uint8Array }[]
}

/** An in-memory mail source that records every call, and can fail on demand. */
export class MemorySource implements ProtonMailSource {
  readonly folders = new Map<string, Folder>()
  readonly calls: string[] = []
  /** Throws on the n-th (1-based) fetchRaw call, once. */
  failFetchOn: { call: number; error: Error } | undefined
  failAll: Error | undefined
  private fetches = 0

  addFolder(
    name: string,
    uidValidity: string,
    messages: { uid: number; raw: Uint8Array }[] = []
  ): void {
    const uidNext = Math.max(0, ...messages.map((m) => m.uid)) + 1
    this.folders.set(name, { uidValidity, uidNext, messages: [...messages] })
  }

  /** Server renumbers the folder: a new UIDVALIDITY and new UIDs for the same mail. */
  renumber(name: string, uidValidity: string, firstUid: number): void {
    const folder = this.folder(name)
    folder.uidValidity = uidValidity
    folder.messages = folder.messages.map((m, i) => ({
      uid: firstUid + i,
      raw: m.raw,
    }))
    folder.uidNext = firstUid + folder.messages.length
  }

  private folder(name: string): Folder {
    const folder = this.folders.get(name)
    if (folder === undefined) throw new Error(`no folder ${name}`)
    return folder
  }

  private enter(call: string): void {
    this.calls.push(call)
    if (this.failAll !== undefined) throw this.failAll
  }

  listFolders(): Promise<string[]> {
    return this.run(() => {
      this.enter("listFolders")
      return [...this.folders.keys()]
    })
  }

  folderState(
    folder: string
  ): Promise<{ uidValidity: string; uidNext: number }> {
    return this.run(() => {
      this.enter(`folderState ${folder}`)
      const f = this.folder(folder)
      return { uidValidity: f.uidValidity, uidNext: f.uidNext }
    })
  }

  fetchRaw(
    folder: string,
    fromUid: number,
    limit: number
  ): Promise<{ uid: number; raw: Uint8Array }[]> {
    return this.run(() => {
      this.enter(`fetchRaw ${folder} ${fromUid} ${limit}`)
      this.fetches++
      if (this.failFetchOn?.call === this.fetches) throw this.failFetchOn.error
      return this.folder(folder)
        .messages.filter((m) => m.uid >= fromUid)
        .sort((a, b) => a.uid - b.uid)
        .slice(0, limit)
    })
  }

  private run<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn())
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("failed")
      )
    }
  }
}
