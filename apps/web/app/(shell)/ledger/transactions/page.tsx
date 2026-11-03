import { TransactionsView } from "@/components/transactions-view"

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    entity?: string | string[]
    account?: string | string[]
  }>
}) {
  const { entity, account } = await searchParams
  return (
    <TransactionsView
      initialEntity={typeof entity === "string" ? entity : undefined}
      initialAccount={typeof account === "string" ? account : undefined}
    />
  )
}
