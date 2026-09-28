import { stat } from 'node:fs/promises'

import { AGENTS, agentDef, expandGlobal } from './agents'
import { CliError, findOnPath, tr, type Ctx } from './context'
import { AGENT_IDS, type AgentId } from './shared'
import { readState, writeState } from './state'

/** Подтвержденные признаки запуска внутри агента (спецификация, раздел 5). Cursor раньше VS Code: его терминал тоже vscode. */
export const hostAgent = (env: Record<string, string | undefined>): AgentId | null => {
  if (env.CLAUDECODE === '1') return 'claude-code'
  if (env.CURSOR_TRACE_ID) return 'cursor'
  if (env.TERM_PROGRAM === 'vscode') return 'vscode'
  return null
}

const exists = async (p: string) => Boolean(await stat(p).catch(() => null))

export const detectInstalled = async (ctx: Ctx): Promise<AgentId[]> => {
  let extensions: string[] | null = null
  const vscodeExtensions = async () => {
    if (extensions) return extensions
    const code = await findOnPath(ctx, 'code')
    if (!code) return (extensions = [])
    const r = await ctx.exec(code, ['--list-extensions'], 3000)
    return (extensions = r.code === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean) : [])
  }
  const found: AgentId[] = []
  for (const a of AGENTS) {
    let hit = false
    for (const p of a.detect.paths) if (!hit && (await exists(expandGlobal(ctx, p)))) hit = true
    for (const b of a.detect.bins) if (!hit && (await findOnPath(ctx, b))) hit = true
    if (!hit && a.detect.vscodeExt) hit = (await vscodeExtensions()).includes(a.detect.vscodeExt)
    if (hit) found.push(a.id)
  }
  return found
}

export const chooseAgents = async (ctx: Ctx, flag: string | undefined): Promise<AgentId[]> => {
  if (flag !== undefined) {
    const names = flag.split(',').map((s) => s.trim()).filter(Boolean)
    if (names.length === 1 && names[0] === 'all') {
      const all = await detectInstalled(ctx)
      if (!all.length) throw new CliError(64, tr(ctx, 'Агенты на этой машине не найдены. Укажите их явно: --agent claude-code,cursor', 'No agents found on this machine. Name them: --agent claude-code,cursor'))
      return all
    }
    const unknown = names.filter((n) => !(AGENT_IDS as readonly string[]).includes(n))
    if (unknown.length || !names.length) {
      throw new CliError(64, tr(ctx, `Неизвестный агент: ${unknown.join(', ')}. Доступны: ${AGENT_IDS.join(', ')}`, `Unknown agent: ${unknown.join(', ')}. Available: ${AGENT_IDS.join(', ')}`))
    }
    return [...new Set(names)] as AgentId[]
  }
  const host = hostAgent(ctx.env)
  if (host) return [host]
  const found = await detectInstalled(ctx)
  if (!found.length) throw new CliError(64, tr(ctx, 'Агенты на этой машине не найдены. Укажите их явно: --agent claude-code,cursor', 'No agents found on this machine. Name them: --agent claude-code,cursor'))
  if (!ctx.tty || found.length === 1) return found
  const state = await readState(ctx)
  const last = (state.lastAgents ?? []).filter((a) => found.includes(a))
  found.forEach((id, i) => ctx.out(`  ${i + 1}. ${agentDef(id).title}`))
  const def = last.length ? last : found
  const answer = await ctx.prompt(tr(ctx, `Номера через запятую (Enter: ${def.map((a) => agentDef(a).title).join(', ')}): `, `Numbers separated by commas (Enter: ${def.map((a) => agentDef(a).title).join(', ')}): `), false)
  const picked = answer
    ? answer.split(',').map((s) => found[Number(s.trim()) - 1]).filter((a): a is AgentId => Boolean(a))
    : def
  if (!picked.length) throw new CliError(64, tr(ctx, 'Не выбран ни один агент.', 'No agent selected.'))
  await writeState(ctx, { ...state, lastAgents: picked })
  return picked
}
