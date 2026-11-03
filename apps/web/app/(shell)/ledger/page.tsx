import { LedgerView } from "@/components/ledger-view"

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<{
    entity?: string | string[]
    status?: string | string[]
    obligation?: string | string[]
  }>
}) {
  const { entity, status, obligation } = await searchParams
  return (
    <LedgerView
      initialEntity={typeof entity === "string" ? entity : undefined}
      initialStatus={typeof status === "string" ? status : undefined}
      initialObligation={
        typeof obligation === "string" ? obligation : undefined
      }
    />
  )
}
