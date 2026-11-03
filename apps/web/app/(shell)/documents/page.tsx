import { DocumentsView } from "@/components/documents-view"

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    entity?: string | string[]
    source?: string | string[]
  }>
}) {
  const { entity, source } = await searchParams
  return (
    <DocumentsView
      initialEntity={typeof entity === "string" ? entity : undefined}
      initialSource={typeof source === "string" ? source : undefined}
    />
  )
}
