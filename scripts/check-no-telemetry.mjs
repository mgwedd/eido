// Keep Eido's local-first promise enforceable: reject known telemetry, analytics,
// crash-reporting, and advertising SDKs in manifests, the lockfile, and app source.
// Exceptions must name one exact file and one exact finding, with a review reason.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const DEPENDENCIES = [
  [
    "analytics SDK",
    /^(?:posthog-js|@posthog\/[^/]+|@amplitude\/[^/]+|amplitude-js|mixpanel-browser|mixpanel|@segment\/[^/]+|analytics-node|@vercel\/analytics|@cloudflare\/web-analytics|plausible-tracker|umami(?:-tracker)?)$/i,
  ],
  [
    "crash-reporting SDK",
    /^(?:@sentry\/[^/]+|sentry-(?:electron|react-native)|sentry|bugsnag(?:-js|-react-native)?|@bugsnag\/[^/]+|@firebase\/crashlytics|firebase-crashlytics|@crashlytics\/[^/]+|instabug-reactnative)$/i,
  ],
  [
    "advertising SDK",
    /^(?:react-native-google-mobile-ads|google-mobile-ads|@react-native-fbads\/[^/]+|react-native-fbads|facebook-ads|@adobe\/react-native-acpcore|cordova-plugin-admob)$/i,
  ],
  [
    "telemetry SDK",
    /^(?:@opentelemetry\/[^/]+|opentelemetry-(?:api|sdk)|datadog-(?:browser|rum|mobile)|@datadog\/[^/]+|newrelic|@newrelic\/[^/]+|honeycomb-beeline|@highlight-run\/[^/]+)$/i,
  ],
]

const INITIALIZERS = [
  [
    "analytics SDK initialization",
    /\b(?:posthog|PostHog|amplitude|Amplitude|mixpanel|Mixpanel)\s*\.\s*(?:init|initWithoutPageview)\s*\(|\banalytics\s*\.\s*load\s*\(|\bgtag\s*\(\s*["']config["']|\bfbq\s*\(\s*["']init["']/,
  ],
  [
    "crash-reporting SDK initialization",
    /\b(?:Sentry|Bugsnag|Crashlytics|Instabug)\s*\.\s*(?:init|start|configure)\s*\(/,
  ],
  [
    "advertising SDK initialization",
    /\b(?:AdMob|GoogleMobileAds|AudienceNetwork|FBAdSettings)\s*\./,
  ],
  [
    "telemetry SDK initialization",
    /\b(?:OpenTelemetry|trace|metrics)\s*\.\s*(?:init|registerInstrumentations|setGlobalTracerProvider)\s*\(|\b(?:Datadog|NewRelic|Honeycomb)\s*\.\s*(?:init|start)\s*\(/,
  ],
]

// Each exception must be one exact repository path and one exact finding label.
// Add an entry only after review, with its rationale. No globs or regex exceptions.
const EXCEPTIONS = []

function filesFromGit() {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      encoding: "utf8",
    }
  )
    .split("\0")
    .filter(Boolean)
}

function scan(files) {
  const findings = []
  for (const file of files) {
    const isManifest = /(^|\/)package\.json$/.test(file)
    const isLockfile = /(^|\/)pnpm-lock\.yaml$/.test(file)
    const isAppSource = /^apps\/.+\.(?:[cm]?[jt]sx?|swift)$/.test(file)
    if (!isManifest && !isLockfile && !isAppSource) continue

    let content
    try {
      content = readFileSync(file, "utf8")
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EISDIR") continue
      throw error
    }
    if (isManifest) {
      let manifest
      try {
        manifest = JSON.parse(content)
      } catch {
        continue
      }
      const dependencies = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      })
      for (const dependency of dependencies) {
        const match = DEPENDENCIES.find(([, pattern]) =>
          pattern.test(dependency)
        )
        if (match) findings.push({ file, finding: match[0] })
      }
    } else if (isLockfile) {
      // Check installed package records, not peer dependency references from unrelated packages.
      for (const line of content.split("\n")) {
        const key = /^  ['"]?(.+?)['"]?:$/.exec(line)?.[1]
        if (!key) continue
        const versionAt = key.indexOf(
          "@",
          key.startsWith("@") ? key.indexOf("/") + 1 : 0
        )
        if (versionAt < 1) continue
        const name = key.slice(0, versionAt)
        const match = DEPENDENCIES.find(([, pattern]) => pattern.test(name))
        if (match) findings.push({ file, finding: match[0] })
      }
    } else {
      for (const [finding, pattern] of INITIALIZERS) {
        if (pattern.test(content)) findings.push({ file, finding })
      }
    }
  }
  return findings.filter(
    ({ file, finding }) =>
      !EXCEPTIONS.some(
        (entry) =>
          entry.file === file &&
          entry.finding === finding &&
          entry.reason.trim()
      )
  )
}

function selfTest() {
  const fixtures = [
    {
      file: "apps/web/package.json",
      finding: "analytics SDK",
      source: '{"dependencies":{"posthog-js":"^1.0.0"}}',
    },
    {
      file: "apps/web/package.json",
      finding: "crash-reporting SDK",
      source: '{"dependencies":{"@sentry/nextjs":"^8.0.0"}}',
    },
    {
      file: "apps/web/package.json",
      finding: "advertising SDK",
      source: '{"dependencies":{"react-native-google-mobile-ads":"^1.0.0"}}',
    },
    {
      file: "apps/web/package.json",
      finding: "telemetry SDK",
      source: '{"dependencies":{"@opentelemetry/api":"^1.0.0"}}',
    },
    {
      file: "apps/web/src/init.ts",
      finding: "analytics SDK initialization",
      source: 'posthog.init("key")',
    },
    {
      file: "apps/web/src/init.ts",
      finding: "crash-reporting SDK initialization",
      source: 'Sentry.init({ dsn: "example" })',
    },
    {
      file: "apps/web/src/init.ts",
      finding: "advertising SDK initialization",
      source: "AdMob.configure()",
    },
    {
      file: "apps/web/src/init.ts",
      finding: "telemetry SDK initialization",
      source: "OpenTelemetry.registerInstrumentations()",
    },
  ]
  const files = fixtures.map(({ file, source }) => ({ file, source }))
  const detected = []
  for (const { file, source } of files) {
    const manifest = /package\.json$/.test(file)
    if (manifest) {
      const parsed = JSON.parse(source)
      for (const dependency of Object.keys(parsed.dependencies)) {
        const match = DEPENDENCIES.find(([, pattern]) =>
          pattern.test(dependency)
        )
        if (match) detected.push(`${file}:${match[0]}`)
      }
    } else {
      for (const [finding, pattern] of INITIALIZERS) {
        if (pattern.test(source)) detected.push(`${file}:${finding}`)
      }
    }
  }
  const expected = fixtures.map(({ file, finding }) => `${file}:${finding}`)
  if (JSON.stringify(detected) !== JSON.stringify(expected)) {
    console.error(
      `FAIL: telemetry check self-test expected ${JSON.stringify(expected)} but got ${JSON.stringify(detected)}`
    )
    process.exit(1)
  }
  const allowed = scanFixtureSafeCases()
  if (allowed !== 0) process.exit(1)
  console.log(
    `ok: self-test catches all ${expected.length} SDK categories and initialization patterns`
  )
}

function scanFixtureSafeCases() {
  const safe = [
    {
      file: "apps/web/src/turbo.ts",
      source: 'process.env.TURBO_TELEMETRY_DISABLED = "1"',
    },
    {
      file: "apps/web/src/logging.ts",
      source: 'console.error("request failed", error)',
    },
    {
      file: "apps/web/src/metrics.ts",
      source: 'const segments = path.split("/")',
    },
  ]
  for (const { file, source } of safe) {
    if (INITIALIZERS.some(([, pattern]) => pattern.test(source))) {
      console.error(`FAIL: telemetry check self-test incorrectly flags ${file}`)
      return 1
    }
  }
  return 0
}

if (process.argv.includes("--self-test")) {
  selfTest()
} else {
  const findings = scan(filesFromGit())
  if (findings.length) {
    console.error(
      "FAIL: telemetry, analytics, crash-reporting, or advertising SDK found (review scripts/check-no-telemetry.mjs denylist):\n" +
        findings
          .map(({ file, finding }) => `  - ${file}: ${finding}`)
          .join("\n")
    )
    process.exit(1)
  }
  console.log(
    "ok: no denied telemetry SDKs in manifests, lockfile, or app source"
  )
}
