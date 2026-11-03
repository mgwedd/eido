import { DocumentViewer } from "@/components/document-viewer"

function parseOptionalInt(
  value: string | string[] | undefined
): number | undefined {
  if (typeof value !== "string") return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export default async function DocumentPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ sha256: string }>
  searchParams: Promise<{
    start?: string | string[]
    end?: string | string[]
    page?: string | string[]
    line?: string | string[]
    from?: string | string[]
  }>
}>) {
  const { sha256 } = await params
  const query = await searchParams

  const start = parseOptionalInt(query.start)
  const end = parseOptionalInt(query.end)
  const page = parseOptionalInt(query.page)
  const line = parseOptionalInt(query.line)
  const from = typeof query.from === "string" ? query.from : undefined

  return (
    <DocumentViewer
      sha256={sha256}
      start={start}
      end={end}
      page={page}
      line={line}
      from={from}
    />
  )
}
