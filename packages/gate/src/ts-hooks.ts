import { registerHooks } from "node:module"

// Lets Node run the gate's TypeScript sources directly (type stripping): the sources import
// relative modules without an extension, as the bundler resolution in tsconfig allows, so
// this resolve hook tries `<specifier>.ts` and `<specifier>/index.ts`. Loaded with
// `node --import ./src/ts-hooks.ts`.

/** The paths to try for an extensionless relative specifier, in order; none for anything else. */
export function tsCandidates(specifier: string): string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return []
  if (/\.(?:[cm]?[jt]sx?|json)$/.test(specifier)) return []
  return [`${specifier}.ts`, `${specifier}/index.ts`]
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const candidate of tsCandidates(specifier)) {
      try {
        return nextResolve(candidate, context)
      } catch {
        // not this candidate; try the next one
      }
    }
    return nextResolve(specifier, context)
  },
})
