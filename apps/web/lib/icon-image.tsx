import { ImageResponse } from "next/og"

/**
 * The Eido mark: a rounded square with an "E" on the page colour. These are image
 * pixels, not UI, so the colours are literals (the manifest uses the same values).
 * `scale` is the mark's share of the canvas; maskable icons keep it inside the
 * 80% safe zone.
 */
export function IconImage(px: number, scale: number) {
  const mark = Math.round(px * scale)
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#09090b",
      }}
    >
      <div
        style={{
          width: mark,
          height: mark,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: Math.round(mark * 0.22),
          background: "#fafafa",
          color: "#09090b",
          fontSize: Math.round(mark * 0.62),
          fontWeight: 700,
        }}
      >
        E
      </div>
    </div>,
    { width: px, height: px }
  )
}
