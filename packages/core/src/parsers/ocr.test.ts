import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fakeEngine } from "./fixtures.test-support"
import { ocrFile, ocrImage, toPgm } from "./ocr"
import type { OcrConfig } from "./ocr"
import { ParseFailed } from "./types"

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-ocr-"))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const config = (
  binary: string | null,
  extra: Partial<OcrConfig> = {}
): OcrConfig => ({
  binary,
  workDir: dir,
  deadline: Date.now() + 10_000,
  maxOutputBytes: 1024 * 1024,
  ...extra,
})

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ParseFailed) return error.reason
    throw error
  }
  throw new Error("expected a failure")
}

describe("toPgm", () => {
  const pixels = (pgm: Uint8Array) => [
    ...pgm.subarray(new TextEncoder().encode("P5\n2 1\n255\n").length),
  ]

  it("writes a binary PGM header", () => {
    const pgm = toPgm({
      width: 2,
      height: 1,
      kind: 2,
      data: Uint8Array.from([0, 0, 0, 255, 255, 255]),
    })
    expect(new TextDecoder().decode(pgm.subarray(0, 11))).toBe("P5\n2 1\n255\n")
    expect(pixels(pgm)).toEqual([0, 255])
  })

  it("weights RGB as luma", () => {
    const pgm = toPgm({
      width: 2,
      height: 1,
      kind: 2,
      data: Uint8Array.from([255, 0, 0, 0, 0, 255]),
    })
    expect(pixels(pgm)).toEqual([76, 29])
  })

  it("skips alpha in RGBA", () => {
    const pgm = toPgm({
      width: 2,
      height: 1,
      kind: 3,
      data: Uint8Array.from([0, 255, 0, 9, 10, 10, 10, 0]),
    })
    expect(pixels(pgm)).toEqual([150, 10])
  })

  it("unpacks 1-bit rows, most significant bit first, padded per row", () => {
    // 2x2: row 0 is 0b10, row 1 is 0b01; each row takes one byte.
    const pgm = toPgm({
      width: 2,
      height: 2,
      kind: 1,
      data: Uint8Array.from([0b10000000, 0b01000000]),
    })
    expect([...pgm.subarray(pgm.length - 4)]).toEqual([255, 0, 0, 255])
  })

  it("reads missing pixel data as black", () => {
    const pgm = toPgm({
      width: 2,
      height: 1,
      kind: 2,
      data: Uint8Array.from([255, 255, 255]),
    })
    expect(pixels(pgm)).toEqual([255, 0])
  })
})

describe("ocrFile", () => {
  it("returns one string per form-feed separated page", async () => {
    const engine = fakeEngine(
      dir,
      "pages.sh",
      "printf 'Lorem  \\n\\fipsum\\n\\f'"
    )
    expect(await ocrFile("/nonexistent.png", config(engine))).toEqual([
      "Lorem",
      "ipsum",
    ])
  })

  it("passes the image path and stdout, with only a thread limit in the environment", async () => {
    const engine = fakeEngine(
      dir,
      "args.sh",
      'printf "%s|%s|%s" "$1" "$2" "$(env | grep -v \'^PWD=\\|^SHLVL=\\|^_=\' | tr \'\\n\' \',\')"'
    )
    expect(await ocrFile("/img.pgm", config(engine))).toEqual([
      "/img.pgm|stdout|OMP_THREAD_LIMIT=1,",
    ])
  })

  it("is ocr_unavailable with no engine, or one that does not exist", async () => {
    expect(await failure(ocrFile("/img.pgm", config(null)))).toBe(
      "ocr_unavailable"
    )
    expect(
      await failure(ocrFile("/img.pgm", config(join(dir, "missing"))))
    ).toBe("ocr_unavailable")
  })

  it("is malformed when the engine fails on the image", async () => {
    expect(
      await failure(
        ocrFile("/img.pgm", config(fakeEngine(dir, "fail.sh", "exit 1")))
      )
    ).toBe("malformed")
  })

  it("is a timeout when the engine runs past the deadline", async () => {
    const engine = fakeEngine(dir, "slow.sh", "exec sleep 5")
    expect(
      await failure(
        ocrFile("/img.pgm", config(engine, { deadline: Date.now() + 200 }))
      )
    ).toBe("timeout")
  })

  it("is oversize when the engine prints more than the output limit", async () => {
    const engine = fakeEngine(dir, "loud.sh", "yes lorem | head -c 100000")
    expect(
      await failure(
        ocrFile("/img.pgm", config(engine, { maxOutputBytes: 1000 }))
      )
    ).toBe("oversize")
  })
})

describe("ocrImage", () => {
  it("writes the image as a PGM into the work dir and reads it", async () => {
    const engine = fakeEngine(dir, "cat-size.sh", 'wc -c < "$1" | tr -d " "')
    const image = { width: 3, height: 2, kind: 2, data: new Uint8Array(18) }
    expect(await ocrImage(image, config(engine))).toEqual([String(11 + 6)])
    const written = readdirSync(dir).filter((name) => name.endsWith(".pgm"))
    expect(written).toHaveLength(1)
    expect(readFileSync(join(dir, written[0] ?? "")).subarray(0, 11)).toEqual(
      Buffer.from("P5\n3 2\n255\n")
    )
  })

  it("is ocr_unavailable with no engine and writes nothing", async () => {
    const before = readdirSync(dir).length
    expect(
      await failure(
        ocrImage(
          { width: 1, height: 1, kind: 2, data: new Uint8Array(3) },
          config(null)
        )
      )
    ).toBe("ocr_unavailable")
    expect(readdirSync(dir)).toHaveLength(before)
  })
})
