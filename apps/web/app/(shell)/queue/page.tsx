import { QueueView } from "@/components/queue-view"

export default async function QueuePage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ intent?: string | string[] }>
}>) {
  const { intent } = await searchParams
  return (
    <QueueView initialId={typeof intent === "string" ? intent : undefined} />
  )
}
