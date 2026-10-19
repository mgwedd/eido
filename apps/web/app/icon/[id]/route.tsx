import { IconImage } from "@/lib/icon-image"

const ICONS = {
  "192": { px: 192, scale: 0.72 },
  "512": { px: 512, scale: 0.72 },
  maskable: { px: 512, scale: 0.56 },
} as const

export const dynamicParams = false

export function generateStaticParams() {
  return Object.keys(ICONS).map((id) => ({ id }))
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const icon = ICONS[id as keyof typeof ICONS]
  return IconImage(icon.px, icon.scale)
}
