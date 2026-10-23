import { config } from "@eido/eslint-config/base"

// Issue #281: inbound material reaches a prompt only through `fence()` in src/inference/fence.ts,
// which writes every material tag with a fresh per-request boundary. A hand-written tag or an
// older "UNTRUSTED DATA" marker anywhere else is a fence the model can be tricked across.
const FORGED_FENCE =
  "Build material blocks with fence() from src/inference/fence.ts; never write a material tag or an untrusted-data marker by hand."
const fenceSelectors = [
  {
    selector: "Literal[value=/<\\s*\\/?\\s*material\\b/i]",
    message: FORGED_FENCE,
  },
  {
    selector: "TemplateElement[value.raw=/<\\s*\\/?\\s*material\\b/i]",
    message: FORGED_FENCE,
  },
  { selector: "Literal[value=/UNTRUSTED DATA/i]", message: FORGED_FENCE },
  {
    selector: "TemplateElement[value.raw=/UNTRUSTED DATA/i]",
    message: FORGED_FENCE,
  },
]
// Material's text is for display, hashing and verification. A builder that unwraps it can paste
// it into a prompt outside the fence.
const unwrapSelector = {
  selector: "CallExpression[callee.name='materialText']",
  message:
    "materialText() is for display and verification only; pass the Material to fence() instead.",
}

const TESTS = ["src/**/*.test.ts", "src/**/*.test-support.ts"]

export default [
  ...config,
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/inference/fence.ts",
      "src/extraction/normalize.ts",
      ...TESTS,
    ],
    rules: {
      "no-restricted-syntax": ["error", ...fenceSelectors, unwrapSelector],
    },
  },
  {
    // Normalizes parsed text for verification and display, so it reads material's text.
    files: ["src/extraction/normalize.ts"],
    rules: { "no-restricted-syntax": ["error", ...fenceSelectors] },
  },
]
