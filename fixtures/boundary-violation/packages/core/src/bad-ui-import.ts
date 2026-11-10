// Deliberately breaks core-imports-no-apps-or-ui: core imports the UI package.
// CI asserts that dependency-cruiser fails on this file.
import { BUTTON } from "../../ui/src/index"

export const widget = BUTTON
