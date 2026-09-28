import type { RecipeBody } from './api'
import { CliError, findOnPath, tr, type Ctx } from './context'
import { clean, confirm } from './io'
import type { InstallRecipe } from './shared'

export type Gate = { ok: true; warnings: string[]; needsRiskConsent: boolean; riskLines: string[] } | { ok: false; code: 3 | 4; message: string }

const OS: Partial<Record<NodeJS.Platform, 'macos' | 'linux' | 'windows'>> = { darwin: 'macos', linux: 'linux', win32: 'windows' }

/** Допуск по порядку спецификации (раздел 6, шаг 3): первый отказ останавливает. */
export const gate = (ctx: Pick<Ctx, 'lang' | 'platform'>, body: RecipeBody | null): Gate => {
  if (!body) return { ok: false, code: 3, message: tr(ctx, 'Записи нет в каталоге или она снята.', 'The entry is not in the catalog or was removed.') }
  if (body.blocked) {
    const title = clean(body.blocked.title)
    return { ok: false, code: 3, message: tr(ctx, `Установка остановлена: у записи открытый инцидент (${title}). ${body.entry.url}`, `Installation stopped: the entry has an open incident (${title}). ${body.entry.url}`) }
  }
  if (!body.recipe || !body.status || body.status === 'unsupported') {
    const reason = body.reason ? `: ${clean(body.reason)}` : ''
    return { ok: false, code: 4, message: tr(ctx, `Автоматической установки нет${reason}. Инструкция на карточке: ${body.entry.url}`, `No automatic install${reason}. See the card: ${body.entry.url}`) }
  }
  const recipe = body.recipe
  if (recipe.source.kind !== 'github' && recipe.components.some((c) => c.kind === 'skill' || c.kind === 'rules')) {
    return { ok: false, code: 4, message: tr(ctx, `Файлы скилла доступны только из репозитория GitHub. Инструкция: ${body.entry.url}`, `Skill files are only available from a GitHub repository. See: ${body.entry.url}`) }
  }
  const allowed = recipe.requirements?.os ?? []
  const current = OS[ctx.platform]
  if (allowed.length && (!current || !allowed.includes(current))) {
    return { ok: false, code: 4, message: tr(ctx, `Запись работает только на: ${allowed.join(', ')}.`, `The entry works only on: ${allowed.join(', ')}.`) }
  }
  const warnings: string[] = []
  if (body.status === 'ai') warnings.push(tr(ctx, 'Рецепт собран автоматически и вручную еще не проверен.', 'The recipe was built automatically and has not been checked by hand yet.'))
  if (body.status === 'review') warnings.push(tr(ctx, 'У записи есть изменение на проверке, ставится последняя принятая версия.', 'A change is under review, the last accepted version is installed.'))
  const reasons = body.risk.reasons.map(clean).filter(Boolean)
  if (body.risk.level === 'medium') warnings.push(tr(ctx, `Средний риск: ${reasons.join('; ')}`, `Medium risk: ${reasons.join('; ')}`))
  const high = body.risk.level === 'high'
  return { ok: true, warnings, needsRiskConsent: high, riskLines: high ? reasons : [] }
}

export const riskConsent = async (ctx: Ctx, g: Extract<Gate, { ok: true }>, yes: boolean): Promise<void> => {
  if (!g.needsRiskConsent) return
  ctx.err(tr(ctx, 'Высокий риск (risk=high):', 'High risk (risk=high):'))
  for (const line of g.riskLines) ctx.err(`  ${line}`)
  if (yes) return
  if (!ctx.tty) throw new CliError(5, tr(ctx, 'Высокий риск требует явного согласия: запустите в терминале или добавьте --yes.', 'High risk needs explicit consent: run in a terminal or add --yes.'))
  if (!(await confirm(ctx, tr(ctx, 'Все равно установить?', 'Install anyway?'), false))) throw new CliError(5, tr(ctx, 'Установка отменена.', 'Installation cancelled.'))
}

const RUNTIME_BIN: Record<string, string> = { npx: 'npx', uvx: 'uvx', docker: 'docker', node: 'node', python: 'python3' }
const REQUIREMENT_BIN: Record<string, string> = { 'node>=18': 'node', 'node>=20': 'node', 'python>=3.10': 'python3', 'python>=3.11': 'python3', docker: 'docker', bun: 'bun', go: 'go', deno: 'deno' }

const below = async (ctx: Ctx, bin: string, pattern: RegExp, min: [number, number]): Promise<boolean> => {
  const r = await ctx.exec(bin, ['--version'], 5000)
  const m = pattern.exec(`${r.stdout} ${r.stderr}`)
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2] ?? 0)]
  return major < min[0] || (major === min[0] && minor < min[1])
}

/** Недостающий рантайм не останавливает установку: конфиг полезен и тогда, когда рантайм поставят позже. */
export const checkRuntimes = async (ctx: Ctx, recipe: InstallRecipe): Promise<string[]> => {
  const bins = new Set<string>()
  for (const r of recipe.requirements?.runtimes ?? []) bins.add(REQUIREMENT_BIN[r])
  for (const c of recipe.components) if (c.kind === 'mcp-stdio' && RUNTIME_BIN[c.runtime]) bins.add(RUNTIME_BIN[c.runtime])
  const warnings: string[] = []
  for (const bin of bins) {
    if (!(await findOnPath(ctx, bin))) warnings.push(tr(ctx, `Не найден ${bin}: сервер не запустится, пока его нет.`, `${bin} not found: the server will not start without it.`))
  }
  const runtimes = recipe.requirements?.runtimes ?? []
  const node = runtimes.includes('node>=20') ? ([20, 0] as [number, number]) : runtimes.includes('node>=18') ? ([18, 0] as [number, number]) : null
  if (node && (await findOnPath(ctx, 'node')) && (await below(ctx, 'node', /v(\d+)\.(\d+)/, node))) warnings.push(tr(ctx, `Нужен Node.js ${node[0]} или новее.`, `Node.js ${node[0]} or newer is required.`))
  const py = runtimes.includes('python>=3.11') ? ([3, 11] as [number, number]) : runtimes.includes('python>=3.10') ? ([3, 10] as [number, number]) : null
  if (py && (await findOnPath(ctx, 'python3')) && (await below(ctx, 'python3', /Python (\d+)\.(\d+)/, py))) warnings.push(tr(ctx, `Нужен Python ${py.join('.')} или новее.`, `Python ${py.join('.')} or newer is required.`))
  return warnings
}
