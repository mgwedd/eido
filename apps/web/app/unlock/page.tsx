import type { Metadata } from "next"

import { UnlockView } from "@/components/unlock-view"
import { safeNext } from "@/lib/auth/unlock"

export const metadata: Metadata = { title: "Unlock" }

export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { next } = await searchParams
  return (
    <UnlockView next={safeNext(typeof next === "string" ? next : undefined)} />
  )
}
