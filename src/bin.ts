import { main } from './cli'
import { makeCtx } from './context'

process.exitCode = await main(process.argv.slice(2), makeCtx())
