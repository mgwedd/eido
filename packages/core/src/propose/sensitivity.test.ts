import { describe, expect, it } from "vitest"
import type {
  CompleteOptions,
  InferenceRequest,
  ModelClient,
} from "../inference/types"
import "../parsers/no-network"
import { classifyIntentSensitivity, classifySensitivity } from "./sensitivity"

function fakeModel(
  handler: (
    request: InferenceRequest,
    options?: CompleteOptions
  ) => Promise<{ text: string }>
): ModelClient {
  return {
    complete: async (req, opts) => {
      const res = await handler(req, opts)
      return {
        text: res.text,
        estimatedPromptTokens: 0,
        reportedPromptTokens: 0,
        truncationSuspected: false,
        finishReason: "stop",
      }
    },
  }
}

describe("core sensitivity classifier", () => {
  it("makes no network call (tested with network blocked)", async () => {
    // Attempting network call throws NetworkBlockedError
    expect(() => fetch("http://127.0.0.1:9/")).toThrow()

    const result = await classifySensitivity("buy printer paper")
    expect(result).toBeUndefined()

    const sensitiveResult = await classifySensitivity("Patient medical history")
    expect(sensitiveResult).toBe("sensitive")
  })

  describe("rules pre-filter", () => {
    it.each([
      ["email address", "Please email alex@example.com"],
      ["phone number", "Call (555) 123-4567 regarding the inquiry"],
      ["12-digit number", "Transaction confirmation 123456789012"],
      ["health term", "Consult with doctor on symptoms"],
      ["legal term", "Review terms with attorney"],
      ["financial term", "Check direct deposit of monthly salary"],
    ])("flags %s as sensitive without model", async (_label, text) => {
      const res = await classifySensitivity(text)
      expect(res).toBe("sensitive")
    })

    it("leaves ordinary synthetic text unflagged", async () => {
      const res = await classifySensitivity("buy printer paper")
      expect(res).toBeUndefined()
    })
  })

  describe("model classification", () => {
    it("flags text when model outputs sensitive: true", async () => {
      const model = fakeModel(() =>
        Promise.resolve({
          text: JSON.stringify({ sensitive: true }),
        })
      )
      const res = await classifySensitivity("Internal company roadmap", {
        model,
      })
      expect(res).toBe("sensitive")
    })

    it("leaves text unflagged when model outputs sensitive: false", async () => {
      const model = fakeModel(() =>
        Promise.resolve({
          text: JSON.stringify({ sensitive: false }),
        })
      )
      const res = await classifySensitivity("Ordinary office supplies", {
        model,
      })
      expect(res).toBeUndefined()
    })

    it("model output never marks text 'normal'; absence means not flagged", async () => {
      const model = fakeModel(() =>
        Promise.resolve({
          text: JSON.stringify({ sensitive: false, tier: "normal" }),
        })
      )
      const res = await classifySensitivity("Clean up workbench", { model })
      // Returns undefined, never "normal"
      expect(res).toBeUndefined()
    })
  })

  describe("fail closed behavior", () => {
    it("a core classifier failure yields sensitive (failing fake throws)", async () => {
      const failingModel = fakeModel(() => {
        throw new Error("model execution failed: out of memory")
      })
      const res = await classifySensitivity("Some ambiguous text", {
        model: failingModel,
      })
      expect(res).toBe("sensitive")
    })

    it("a core classifier timeout yields sensitive", async () => {
      const timingOutModel = fakeModel(
        () => new Promise((resolve) => setTimeout(resolve, 5000))
      )
      const res = await classifySensitivity("Some text", {
        model: timingOutModel,
        timeoutMs: 10,
      })
      expect(res).toBe("sensitive")
    })

    it("malformed model JSON yields sensitive", async () => {
      const malformedModel = fakeModel(() =>
        Promise.resolve({
          text: "Not valid JSON output from local model",
        })
      )
      const res = await classifySensitivity("Some text", {
        model: malformedModel,
      })
      expect(res).toBe("sensitive")
    })

    it("respects caller-provided signal that is already aborted", async () => {
      const controller = new AbortController()
      controller.abort()
      const slowModel = fakeModel(
        () => new Promise((resolve) => setTimeout(resolve, 5000))
      )
      const res = await classifySensitivity("Some text", {
        model: slowModel,
        signal: controller.signal,
        timeoutMs: 50,
      })
      expect(res).toBe("sensitive")
    })
  })

  describe("intent classification helper", () => {
    it("flags sensitive intent free text in checklist and sets sensitivity: 'sensitive'", async () => {
      const todo = {
        kind: "things.add_todo" as const,
        args: {
          title: "Errands",
          checklist: ["Buy apples", "Doctor checkup"],
        },
      }
      const classified = await classifyIntentSensitivity(todo)
      expect(classified.sensitivity).toBe("sensitive")
    })

    it("flags sensitive intent free text and sets sensitivity: 'sensitive'", async () => {
      const todo = {
        kind: "things.add_todo" as const,
        args: {
          title: "Buy milk",
          notes: "Call physician at 555-123-4567",
        },
      }
      const classified = await classifyIntentSensitivity(todo)
      expect(classified.sensitivity).toBe("sensitive")
    })

    it("leaves ordinary intent unflagged without sensitivity field", async () => {
      const todo = {
        kind: "things.add_todo" as const,
        args: {
          title: "buy printer paper",
          notes: "two packs of 500 sheets",
        },
      }
      const classified = await classifyIntentSensitivity(todo)
      expect(classified.sensitivity).toBeUndefined()
    })

    it("preserves already sensitive intent", async () => {
      const todo = {
        kind: "things.add_todo" as const,
        args: { title: "buy printer paper" },
        sensitivity: "sensitive" as const,
      }
      const classified = await classifyIntentSensitivity(todo)
      expect(classified.sensitivity).toBe("sensitive")
    })
  })
})
