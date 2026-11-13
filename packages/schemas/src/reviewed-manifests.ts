import drive from "../manifests/drive.json" with { type: "json" }
import files from "../manifests/files.json" with { type: "json" }
import gmail from "../manifests/gmail.json" with { type: "json" }
import protonCalendar from "../manifests/proton-calendar.json" with { type: "json" }
import protonMail from "../manifests/proton-mail.json" with { type: "json" }
import simplefin from "../manifests/simplefin.json" with { type: "json" }
import things from "../manifests/things.json" with { type: "json" }

// The reviewed connector manifests (ADR 0009, decision 7): committed JSON the owner reviews in
// a pull request, so the gate can offer a first pin from the Admin page without running core
// code. `pnpm --filter @eido/core connector-manifest <name>` prints each one; a core test fails
// when a file here differs from core's source. Proton Mail and Proton Calendar read the owner's
// addresses from core's environment only to validate them: the addresses are not in the manifest,
// so one committed file serves every owner. SimpleFIN's only environment value is its daily
// request budget; the committed file declares the default (24). An owner who wants a lower
// budget places their own manifest on the Mac, which the gate reads before this one.
// The values are unchecked JSON; the gate validates one before it pins it.

export const REVIEWED_MANIFESTS: Readonly<Record<string, unknown>> = {
  drive,
  files,
  gmail,
  "proton-calendar": protonCalendar,
  "proton-mail": protonMail,
  simplefin,
  things,
}
