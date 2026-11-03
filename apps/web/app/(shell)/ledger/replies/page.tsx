import { RepliesView } from "@/components/replies-view"

export default async function RepliesOwedPage({
  searchParams,
}: {
  searchParams: Promise<{
    entity?: string | string[]
  }>
}) {
  const { entity } = await searchParams
  return (
    <RepliesView
      initialEntity={typeof entity === "string" ? entity : undefined}
    />
  )
}
