// Entry point: hands process.argv and the real effects (effects.ts) to main().
import { main } from "./cli.ts"
import { stackEffects } from "./effects.ts"

process.exitCode = await main(process.argv.slice(2), stackEffects())
