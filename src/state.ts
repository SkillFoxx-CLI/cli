import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Ctx } from './context'
import type { AgentId } from './shared'

export type State = { lastAgents?: AgentId[]; installId?: string; telemetryNotice?: boolean }

const file = (ctx: Ctx) => path.join(ctx.sfHome, 'config.json')

export const readState = async (ctx: Ctx): Promise<State> => {
  try {
    const data = JSON.parse(await readFile(file(ctx), 'utf8'))
    return data && typeof data === 'object' ? (data as State) : {}
  } catch {
    return {}
  }
}

export const writeState = async (ctx: Ctx, state: State): Promise<void> => {
  await mkdir(ctx.sfHome, { recursive: true })
  await writeFile(file(ctx), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}
