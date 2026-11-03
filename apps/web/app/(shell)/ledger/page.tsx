import { LedgerView } from "@/components/ledger-view"

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<{
    entity?: string | string[]
    status?: string | string[]
  }>
}) {
  const { entity, status } = await searchParams
  return (
    <LedgerView
      initialEntity={typeof entity === "string" ? entity : undefined}
      initialStatus={typeof status === "string" ? status : undefined}
    />
  )
}
