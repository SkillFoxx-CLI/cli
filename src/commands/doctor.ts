import { lstat, stat } from 'node:fs/promises'

import type { Scope } from '../agents'
import { fetchRecipe } from '../api'
import type { Command } from '../cli'
import { ConfigEditError, readKey } from '../config-file'
import { CliError, tr, type Ctx } from '../context'
import { gate } from '../gate'
import { clean, printJson } from '../io'
import { lockItemTarget } from '../contain'
import { sameConfig, type LockEntry, type LockVar } from '../lock'
import { skillState } from '../skill-place'
import { lockScopes } from './target'

export type Problem = { key: string; scope: Scope; kind: 'missing' | 'modified' | 'broken' | 'foreign' | 'outdated' | 'removed' | 'blocked' | 'unsupported' | 'risk' | 'unchecked' | 'env'; detail: string }

export type EnvRow = { key: string; scope: Scope; name: string; required: boolean; secret: boolean; status: 'ok' | 'missing' }

/**
 * Переменные окружения одной записи lock: пусто, если lock записан до этой версии CLI и еще не
 * обновлен (обратная совместимость, поле vars необязательное). set и непустое в ctx.env — ok, иначе
 * missing; отдельно от Problem, потому что необязательная переменная не считается проблемой doctor.
 */
export const envRows = (ctx: Pick<Ctx, 'env'>, key: string, scope: Scope, vars: LockVar[] | undefined): EnvRow[] =>
  (vars ?? []).map((v) => ({ key, scope, name: v.name, required: v.required, secret: v.secret, status: ctx.env[v.name] ? 'ok' : ('missing' as const) }))

/** Проблемы doctor из недостающих переменных: только обязательные, секретные раньше несекретных. */
export const envProblems = (ctx: Pick<Ctx, 'lang'>, rows: EnvRow[]): Problem[] =>
  rows
    .filter((r) => r.required && r.status === 'missing')
    .sort((a, b) => Number(b.secret) - Number(a.secret))
    .map((r) => ({ key: r.key, scope: r.scope, kind: 'env', detail: r.secret ? tr(ctx, `${r.name} (секрет)`, `${r.name} (secret)`) : r.name }))

export const localProblems = async (ctx: Ctx, key: string, scope: Scope, entry: LockEntry, root: string): Promise<Problem[]> => {
  const out: Problem[] = []
  for (const item of entry.items) {
    if (item.kind !== 'mcp' && item.kind !== 'skill') continue
    const abs = lockItemTarget(ctx, scope, root, item)
    if (!abs) {
      out.push({ key, scope, kind: 'foreign', detail: item.kind === 'mcp' ? item.file : item.path })
      continue
    }
    if (item.kind === 'mcp') {
      try {
        const current = await readKey({ file: abs, format: item.format, key: item.key })
        if (!current.exists) out.push({ key, scope, kind: 'missing', detail: `${item.file}: ${item.key.join(' > ')}` })
        else if (!sameConfig(current.value, item.config, item.secrets)) out.push({ key, scope, kind: 'modified', detail: `${item.file}: ${item.key.join(' > ')}` })
      } catch (error) {
        if (!(error instanceof ConfigEditError)) throw error
        out.push({ key, scope, kind: 'broken', detail: item.file })
      }
    } else {
      const link = await lstat(abs).catch(() => null)
      if (!link || (link.isSymbolicLink() && !(await stat(abs).catch(() => null)))) out.push({ key, scope, kind: 'missing', detail: item.path })
      else if (!link.isSymbolicLink()) {
        const state = await skillState(abs)
        if (state !== 'unchanged') out.push({ key, scope, kind: state === 'missing' ? 'missing' : 'modified', detail: item.path })
      }
    }
  }
  return out
}

const LABEL: Record<Problem['kind'], [string, string]> = {
  missing: ['нет на месте', 'missing'],
  modified: ['изменено вручную', 'edited by hand'],
  broken: ['файл не разбирается', 'the file does not parse'],
  foreign: ['путь в lock не совпадает с папкой агента', 'the lock path is not the agent folder'],
  outdated: ['есть сверенное обновление', 'a rechecked update is available'],
  removed: ['запись снята из каталога', 'the entry was removed from the catalog'],
  blocked: ['установка заблокирована', 'installation is blocked'],
  unsupported: ['автоматическая установка больше не поддерживается', 'automatic install is no longer supported'],
  risk: ['риск вырос до high', 'risk went up to high'],
  unchecked: ['не удалось проверить', 'could not check'],
  env: ['переменная окружения не задана', 'environment variable is not set'],
}

export const runDoctor: Command = async (ctx, _args, flags) => {
  const problems: Problem[] = []
  const env: EnvRow[] = []
  let checked = 0
  for (const s of await lockScopes(ctx, flags)) {
    for (const [key, entry] of Object.entries(s.lock.entries)) {
      checked++
      problems.push(...(await localProblems(ctx, key, s.scope, entry, s.root)))
      const rows = envRows(ctx, key, s.scope, entry.vars)
      env.push(...rows)
      problems.push(...envProblems(ctx, rows))
      try {
        const body = await fetchRecipe(ctx, entry.section, entry.slug)
        const g = gate(ctx, body)
        if (!body) problems.push({ key, scope: s.scope, kind: 'removed', detail: `npx skillfoxx remove ${key}` })
        else if (body.blocked) problems.push({ key, scope: s.scope, kind: 'blocked', detail: clean(body.blocked.title) })
        else if (!g.ok) problems.push({ key, scope: s.scope, kind: 'unsupported', detail: body.entry.url })
        else {
          if (body.hash !== entry.recipeHash) problems.push({ key, scope: s.scope, kind: 'outdated', detail: `npx skillfoxx update ${key}` })
          if (body.risk.level === 'high' && entry.risk !== 'high') problems.push({ key, scope: s.scope, kind: 'risk', detail: body.risk.reasons.map(clean).join('; ') })
        }
      } catch (error) {
        if (!(error instanceof CliError)) throw error
        problems.push({ key, scope: s.scope, kind: 'unchecked', detail: error.message })
      }
    }
  }
  const optionalMissing = env.filter((r) => !r.required && r.status === 'missing')
  if (flags.json) printJson(ctx, { checked, problems, env })
  else if (!problems.length && !optionalMissing.length) ctx.out(tr(ctx, `Проверено записей: ${checked}, проблем нет.`, `Entries checked: ${checked}, no problems.`))
  else {
    for (const p of problems) ctx.out(`${p.key}: ${tr(ctx, ...LABEL[p.kind])}, ${p.detail}`)
    for (const r of optionalMissing) ctx.out(tr(ctx, `${r.key}: необязательная переменная не задана, ${r.name}`, `${r.key}: optional variable is not set, ${r.name}`))
  }
  return problems.length ? 2 : 0
}
