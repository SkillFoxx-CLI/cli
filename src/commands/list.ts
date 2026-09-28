import type { Command } from '../cli'
import { tr } from '../context'
import { printJson } from '../io'
import { lockScopes } from './target'

export const runList: Command = async (ctx, _args, flags) => {
  const rows = (await lockScopes(ctx, flags)).flatMap((s) =>
    Object.entries(s.lock.entries).map(([key, e]) => ({ key, scope: s.scope, agents: e.agents, status: e.status, commit: e.commitSha?.slice(0, 7) ?? null, updatedAt: e.updatedAt })),
  )
  if (flags.json) {
    printJson(ctx, rows)
    return 0
  }
  if (!rows.length) {
    ctx.out(tr(ctx, 'Ничего не установлено. Найти запись: npx skillfoxx search <запрос>', 'Nothing installed. Find an entry: npx skillfoxx search <query>'))
    return 0
  }
  for (const r of rows) {
    const scope = r.scope === 'project' ? tr(ctx, 'проект', 'project') : tr(ctx, 'пользователь', 'user')
    const agents = r.agents.length ? r.agents.join(', ') : tr(ctx, 'без агентов', 'no agents')
    ctx.out(`${r.key}  ${scope}  ${agents}  ${r.updatedAt.slice(0, 10)}`)
  }
  return 0
}
