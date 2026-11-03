// @vitest-environment happy-dom
import { InjectionFlag } from "../components/injection-flag"
import {
  cleanCitation,
  cleanDocumentView,
  cleanIntent,
  flaggedCitation,
  flaggedDocumentView,
  flaggedIntent,
} from "./fixtures/injection"
import { describeStates } from "./render-states"

const cardFlag = (injection: typeof flaggedIntent.injection) => () => (
  <InjectionFlag injection={injection} />
)

const citationFlag = (citation: typeof flaggedCitation) => () => (
  <InjectionFlag
    variant="button"
    injectionSuspected={citation.injectionSuspected}
    reasons={citation.injectionReasons}
  />
)

const mailFlag = (view: typeof flaggedDocumentView, flagged: boolean) => () => (
  <InjectionFlag
    injectionSuspected={flagged}
    reasons={flagged ? ["template-marker", "boundary-confusion"] : []}
  />
)

describeStates("Injection flag on approval card", [
  {
    state: "clean approval card shows nothing",
    render: cardFlag(cleanIntent.injection),
    selector: '[data-slot="injection-flag"]',
    role: "status",
    message: null,
  },
  {
    state: "flagged approval card shows Possible injection chip",
    render: cardFlag(flaggedIntent.injection),
    selector: '[data-slot="injection-flag"]',
    role: "status",
    message: "Possible injection",
  },
])

describeStates("Injection flag on Ask citation", [
  {
    state: "clean citation shows nothing",
    render: citationFlag(cleanCitation),
    selector: '[data-slot="injection-flag"]',
    role: "status",
    message: null,
  },
  {
    state: "flagged citation shows ! button",
    render: citationFlag(flaggedCitation),
    selector: '[data-slot="injection-flag"]',
    role: "status",
    message: "!",
  },
])

describeStates("Injection flag on mail detail", [
  {
    state: "clean mail detail shows nothing",
    render: mailFlag(cleanDocumentView, false),
    selector: '[data-slot="injection-flag"]',
    role: "status",
    message: null,
  },
  {
    state: "flagged mail detail shows Possible injection chip",
    render: mailFlag(flaggedDocumentView, true),
    selector: '[data-slot="injection-flag"]',
    role: "status",
    message: "Possible injection",
  },
])
