import { randomUUID } from 'node:crypto'

import { userAgent } from './api'
import { tr, type Ctx } from './context'
import type { AgentId } from './shared'
import { readState, writeState } from './state'
import { VERSION } from './version'

export type InstallEvent = { entry: string; agent: AgentId | 'none'; event: 'add' | 'remove' | 'update' }

const truthy = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'

export const telemetryEnabled = (env: Record<string, string | undefined>): boolean =>
  !(truthy(env.DO_NOT_TRACK) || truthy(env.DISABLE_TELEMETRY) || env.SKILLFOXX_TELEMETRY === '0')

/**
 * Анонимный счетчик установок: запись каталога, агент, событие, версия CLI, случайный installId и признак CI.
 * Ни путей, ни переменных, ни имени пользователя. Ждем не дольше 1,5 с, любые ошибки глушатся.
 */
export const sendEvents = async (ctx: Ctx, events: InstallEvent[]): Promise<void> => {
  try {
    if (!events.length || !telemetryEnabled(ctx.env)) return
    const state = await readState(ctx)
    const installId = state.installId ?? randomUUID()
    if (!state.installId || !state.telemetryNotice) {
      if (!state.telemetryNotice) ctx.err(tr(ctx, 'SkillFoxx анонимно считает установки. Отключить: DO_NOT_TRACK=1', 'SkillFoxx counts installs anonymously. Disable: DO_NOT_TRACK=1'))
      await writeState(ctx, { ...state, installId, telemetryNotice: true })
    }
    const body = JSON.stringify({ installId, cliVersion: VERSION, ci: truthy(ctx.env.CI), events: events.slice(0, 20).map((e) => ({ ...e, source: 'cli' })) })
    await ctx.fetch(`${ctx.api}/api/v1/installs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': userAgent() },
      body,
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    // телеметрия не влияет на результат команды
  }
}
