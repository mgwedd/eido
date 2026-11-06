// Entry point: hands process.argv and real files, processes, launchctl, signals and fetch to main().
import { main } from "./cli.ts"
import { llamaEffects } from "./effects.ts"

process.exitCode = await main(process.argv.slice(2), llamaEffects())
