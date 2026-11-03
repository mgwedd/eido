import { describe, expect, test, vi } from "vitest"
import { PromptTooLargeError } from "../inference/errors"
import type { InferenceResult, ModelClient } from "../inference/types"
import { classifyDocumentType } from "./document-type"

const result = (overrides: Partial<InferenceResult> = {}): InferenceResult => ({
  text: '{"type":"Invoice"}',
  estimatedPromptTokens: 100,
  reportedPromptTokens: 100,
  truncationSuspected: false,
  finishReason: "stop",
  ...overrides,
})

function modelReturning(response: InferenceResult): {
  model: ModelClient
  complete: ReturnType<typeof vi.fn<ModelClient["complete"]>>
} {
  const complete = vi.fn<ModelClient["complete"]>(() =>
    Promise.resolve(response)
  )
  return { model: { complete }, complete }
}

describe("document type classification", () => {
  test("accepts only a schema-valid label or explicit null", async () => {
    const { model: classifier } = modelReturning(result())

    await expect(
      classifyDocumentType(classifier, "Invoice evidence", {
        tokenBudget: 1_000,
      })
    ).resolves.toMatchObject({ type: "Invoice" })

    await expect(
      classifyDocumentType(
        modelReturning(result({ text: '{"type":"Warranty"}' })),
        "Warranty evidence",
        { tokenBudget: 1_000 }
      )
    ).resolves.toMatchObject({ type: null })
    await expect(
      classifyDocumentType(
        modelReturning(result({ text: '{"type":null}' })),
        "Unclear evidence",
        { tokenBudget: 1_000 }
      )
    ).resolves.toMatchObject({ type: null })
  })

  test.each<[string, InferenceResult]>([
    ["malformed JSON", result({ text: "{broken" })],
    ["suspected prompt truncation", result({ truncationSuspected: true })],
    ["cut-off output", result({ finishReason: "length" })],
  ])("returns no label for %s", async (_name, reply) => {
    const classification = await classifyDocumentType(
      modelReturning(reply).model,
      "Synthetic document",
      { tokenBudget: 1_000 }
    )
    expect(classification.type).toBeNull()
    expect(classification.tokensUsed).toBeGreaterThan(0)
  })

  test("returns no label when local inference is unavailable", async () => {
    const classifier: ModelClient = {
      complete: vi.fn(() =>
        Promise.reject(new Error("synthetic local model unavailable"))
      ),
    }

    const classification = await classifyDocumentType(
      classifier,
      "Synthetic document",
      { tokenBudget: 1_000 }
    )
    expect(classification.type).toBeNull()
    expect(classification.tokensUsed).toBeGreaterThan(0)
  })

  test("does not call the model when its prompt would exceed the budget or context", async () => {
    const underBudget = modelReturning(result())
    await expect(
      classifyDocumentType(underBudget.model, "Synthetic document", {
        tokenBudget: 1,
      })
    ).resolves.toEqual({ type: null, tokensUsed: 0 })
    expect(underBudget.complete).not.toHaveBeenCalled()

    const overContextComplete = vi.fn(() =>
      Promise.reject(new PromptTooLargeError(100, 120, 80))
    )
    const overContext: ModelClient = {
      complete: overContextComplete,
    }
    const classification = await classifyDocumentType(
      overContext,
      "Synthetic document",
      { tokenBudget: 1_000 }
    )
    expect(classification.type).toBeNull()
    expect(classification.tokensUsed).toBeGreaterThan(0)
  })

  test("propagates an explicit abort", async () => {
    const controller = new AbortController()
    const classifier: ModelClient = {
      complete: vi.fn(() => Promise.reject(new Error("request cancelled"))),
    }
    controller.abort()

    await expect(
      classifyDocumentType(classifier, "Synthetic document", {
        tokenBudget: 1_000,
        signal: controller.signal,
      })
    ).rejects.toThrow("request cancelled")
  })

  test("caps the sample without traversing or sending the rest of a long document", async () => {
    const { model: classifier, complete } = modelReturning(result())
    const document = `${"A".repeat(6_000)}PRIVATE-TAIL`
    await classifyDocumentType(classifier, document, { tokenBudget: 10_000 })
    const request = complete.mock.calls[0]?.[0]
    const message = request?.messages[0]?.content
    expect(typeof message).not.toBe("string")
    expect(JSON.stringify(message)).not.toContain("PRIVATE-TAIL")
  })
})
