/** Eido boundary rules. Run from the repo root; fixtures mirror the real paths. */
import type { IConfiguration } from "dependency-cruiser"

const CORE_INTERNALS = "(^|/)packages/core/src/(?!index\\.ts$)"
const MAIL_AND_KEYCHAIN_LIBS =
  "imapflow|nodemailer|keytar|node-keytar|@napi-rs/keyring|keychain"
const GATE_INTERNALS = "(^|/)packages/gate/src/(?!index\\.ts$)"

const config: IConfiguration = {
  forbidden: [
    {
      name: "gate-internals-are-private",
      comment:
        "Only packages/gate may import gate internals. Everyone else (including packages/core) goes through the public entry point, src/index.ts.",
      severity: "error",
      from: { pathNot: "(^|/)packages/gate/" },
      to: { path: GATE_INTERNALS },
    },
    {
      name: "gate-imports-schemas-only",
      comment:
        "packages/gate calls nothing in the data plane (ADR 0003): it imports no workspace package but @eido/schemas, so never packages/core or an app.",
      severity: "error",
      from: { path: "(^|/)packages/gate/" },
      to: {
        path: "(^|/)(packages|apps)/",
        pathNot: "(^|/)packages/(gate|schemas)/",
      },
    },
    {
      name: "gate-has-no-parsers",
      comment:
        "packages/gate never parses documents (#43): it imports none of the parser libraries core's sandboxed parsers use, by package name or through node_modules.",
      severity: "error",
      from: { path: "(^|/)packages/gate/" },
      to: {
        path: [
          "^(pdfjs-dist|postal-mime|html-to-text|htmlparser2|dom-serializer|domhandler|domutils)(/|$)",
          "(^|/)node_modules/(pdfjs-dist|postal-mime|html-to-text|htmlparser2|dom-serializer|domhandler|domutils)/",
          "(^|/)node_modules/\\.pnpm/(pdfjs-dist|postal-mime|html-to-text|htmlparser2|dom-serializer|domhandler|domutils)@",
        ],
      },
    },
    {
      name: "core-imports-no-apps-or-ui",
      comment:
        "packages/core is the data plane: it imports no app and not @eido/ui (the presentational component package).",
      severity: "error",
      from: { path: "(^|/)packages/core/" },
      to: { path: ["(^|/)apps/", "(^|/)packages/ui/", "^@eido/ui(/|$)"] },
    },
    {
      name: "mail-and-keychain-libs-are-gate-only",
      comment:
        "imapflow, nodemailer and keychain libraries carry credentials and external writes (ADR 0001): only packages/gate imports them, by package name or through node_modules.",
      severity: "error",
      from: { pathNot: "(^|/)packages/gate/" },
      to: {
        path: [
          `^(${MAIL_AND_KEYCHAIN_LIBS})(/|$)`,
          `(^|/)node_modules/(${MAIL_AND_KEYCHAIN_LIBS})/`,
          `(^|/)node_modules/\\.pnpm/(${MAIL_AND_KEYCHAIN_LIBS.replaceAll("/", "\\+")})@`,
        ],
      },
    },
    {
      name: "infra-uses-public-entry-points-only",
      comment:
        "infra imports packages/core and packages/gate only through their public entry point, src/index.ts, never their internals.",
      severity: "error",
      from: { path: "(^|/)infra/" },
      to: { path: [CORE_INTERNALS, GATE_INTERNALS] },
    },
    {
      name: "web-imports-schemas-and-ui-only",
      comment:
        "apps/web talks to the gate and core over HTTP. It may import @eido/schemas, plus @eido/ui (the shadcn component package, which imports no workspace package).",
      severity: "error",
      from: { path: "(^|/)apps/web/" },
      to: { path: "(^|/)packages/(?!schemas/|ui/)" },
    },
    {
      name: "web-test-fixtures-are-test-only",
      comment:
        'apps/web/test/fixtures holds synthetic UI-state data. Only test files and other files under apps/web/test may import it (.claude/rules/no-placeholders.md). The second path catches the "@/" alias form, which the root tsconfig does not resolve (see not-to-unresolvable).',
      severity: "error",
      from: {
        path: "(^|/)apps/web/",
        pathNot: "(^|/)apps/web/(test/|.*\\.test\\.tsx?$)",
      },
      to: { path: ["(^|/)apps/web/test/fixtures/", "^@/test/fixtures/"] },
    },
    {
      name: "schemas-import-nothing",
      comment: "packages/schemas imports no other workspace package.",
      severity: "error",
      from: { path: "(^|/)packages/schemas/" },
      to: { path: "(^|/)(packages|apps)/", pathNot: "(^|/)packages/schemas/" },
    },
    {
      name: "core-things-no-child-process",
      comment:
        "packages/core/src/connectors/things must not import child_process (AC 6 of #302). Things automation is gate-only.",
      severity: "error",
      from: { path: "(^|/)packages/core/src/connectors/things/" },
      to: { path: "^(node:)?child_process$" },
    },
    {
      name: "ui-imports-nothing",
      comment:
        "packages/ui is presentational and imports no other workspace package.",
      severity: "error",
      from: { path: "(^|/)packages/ui/" },
      to: { path: "(^|/)(packages|apps)/", pathNot: "(^|/)packages/ui/" },
    },
    {
      name: "no-circular",
      comment: "No circular dependencies.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment:
        "Every import must resolve. An unresolvable specifier usually means a workspace package was imported without being declared, or a deep import into another package that its exports map does not allow.",
      severity: "error",
      from: {},
      // Two known resolution gaps, both outside this rule's scope:
      // "@/" is an apps/web tsconfig path alias; the root tsconfig does not load it.
      // "next/image-types/*" is a Next.js type reference from next-env.d.ts.
      to: { couldNotResolve: true, pathNot: ["^@/", "^next/image-types/"] },
    },
    {
      name: "no-non-package-json",
      comment:
        "Imports must resolve to a package with a package.json. Blocks bare imports of files that no package owns.",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(^|/)((\\.next|dist|coverage|\\.turbo)/|eslint\\.config\\.js$)",
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
  },
}

export default config
