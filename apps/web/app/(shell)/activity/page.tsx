import { ActivityView } from "@/components/activity-view"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ intent?: string | string[] }>
}) {
  const { intent } = await searchParams
  return (
    <ActivityView intentId={typeof intent === "string" ? intent : undefined} />
  )
}
