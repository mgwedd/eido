import type { Metadata } from "next"

import { EnrollView } from "@/components/enroll-view"
import { safeEnrolNext } from "@/lib/enrol"

export const metadata: Metadata = { title: "Enrol" }

export default async function EnrollPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { next } = await searchParams
  return (
    <EnrollView
      next={safeEnrolNext(typeof next === "string" ? next : undefined)}
    />
  )
}
