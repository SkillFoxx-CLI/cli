import { fetchRecipe } from '../api'
import type { Command } from '../cli'
import { CliError, tr, type Ctx } from '../context'
import { chooseAgents } from '../detect'
import { chooseTelemetry, disclosureLines, optOuts, withOptOut } from '../disclosures'
import { checkRuntimes, gate, riskConsent } from '../gate'
import { install, installEvents, mergeItems } from '../install'
import { confirm, printJson } from '../io'
import { lockFileFor, pickScope, readLock, recipeVars, rootFor, writeLock } from '../lock'
import { buildPlan, describePlan, planJson, remoteAuthWarnings } from '../plan'
import { sendEvents } from '../telemetry'
import { VERSION } from '../version'
import { resolveTarget } from './target'

/**
 * Обязательная переменная, которой нет в окружении CLI: агент из Dock или Launchpad ~/.zshrc не читает
 * и получит пустую строку. Имена без значений, macOS отдельно (launchctl setenv или терминал), остальные
 * системы общей фразой про профиль оболочки или настройки самого агента.
 */
const envHint = (ctx: Ctx, names: string[]): string => {
  const list = names.join(', ')
  if (ctx.platform === 'darwin') {
    return tr(
      ctx,
      `Переменные окружения нужны агенту при запуске: ${list}. Приложение, открытое из Dock или Launchpad, не видит экспорт из ~/.zshrc. Задайте значение командой launchctl setenv ИМЯ значение (действует до перезагрузки) или запускайте агента из терминала, где переменная уже задана, например open -a Cursor из этого терминала.`,
      `The agent needs these environment variables at launch: ${list}. An app opened from the Dock or Launchpad does not see exports from ~/.zshrc. Set the value with launchctl setenv NAME value (lasts until reboot), or start the agent from a terminal where the variable is already set, for example open -a Cursor from that terminal.`,
    )
  }
  return tr(
    ctx,
    `Переменные окружения нужны агенту при запуске: ${list}. Задайте их в профиле оболочки или в собственных настройках окружения агента.`,
    `The agent needs these environment variables at launch: ${list}. Set them in your shell profile or in the agent's own environment settings.`,
  )
}

export const runAdd: Command = async (ctx, args, flags) => {
  if (args.length !== 1) throw new CliError(64, tr(ctx, 'Укажите одну запись: npx skillfoxx add <раздел>/<slug>', 'Name one entry: npx skillfoxx add <section>/<slug>'))
  const { section, slug } = await resolveTarget(ctx, args[0])
  const key = `${section}/${slug}`
  const body = await fetchRecipe(ctx, section, slug)
  const g = gate(ctx, body)
  if (!g.ok) throw new CliError(g.code, g.message)
  const b = body!
  const original = b.recipe!
  for (const w of [...g.warnings, ...(await checkRuntimes(ctx, original)), ...remoteAuthWarnings(ctx, original)]) ctx.err(w)
  await riskConsent(ctx, g, Boolean(flags.yes))
  const scope = await pickScope(ctx, flags)
  const root = await rootFor(ctx, scope)
  const agents = await chooseAgents(ctx, flags.agent)
  const planned = await buildPlan(ctx, original, agents, scope, root)
  if (flags.dryRun && flags.json) {
    printJson(ctx, { entry: key, scope, agents, actions: planJson(planned, root), disclosures: original.disclosures ?? [] })
    return 0
  }
  ctx.out(tr(ctx, `План установки ${key} (${scope === 'project' ? 'в проект' : 'для пользователя'}):`, `Install plan for ${key} (${scope === 'project' ? 'project' : 'user'}):`))
  for (const line of describePlan(ctx, planned, root)) ctx.out(`  ${line}`)
  for (const line of disclosureLines(ctx, original)) ctx.out(line)
  if (flags.dryRun) return 0

  const lockFile = lockFileFor(ctx, scope, root)
  const lock = await readLock(lockFile, scope)
  const previous = lock.entries[key]
  // Вопрос про телеметрию идет до подтверждения установки: ответ меняет то, что запишется в конфиг.
  const offList = optOuts(original, planned)
  const telemetry = await chooseTelemetry(ctx, offList, flags, previous?.telemetry)
  if (!flags.yes && !(await confirm(ctx, tr(ctx, 'Установить?', 'Install?'), true))) return 1
  const recipe = telemetry === 'off' ? withOptOut(original, offList) : original
  const actions = recipe === original ? planned : await buildPlan(ctx, recipe, agents, scope, root)
  const result = await install(ctx, { recipe, entryKey: key, entryUrl: b.entry.url, actions, agents, scope, root, force: Boolean(flags.force), yes: Boolean(flags.yes), previous })
  const now = ctx.now().toISOString()
  const github = recipe.source.kind === 'github' ? recipe.source : null
  lock.entries[key] = {
    section, slug,
    recipeHash: b.hash ?? '',
    commitSha: github?.commitSha ?? null,
    contentDigest: github?.contentDigest ?? null,
    status: b.status ?? '',
    risk: b.risk.level ?? null,
    scope,
    agents: [...new Set([...(previous?.agents ?? []), ...result.touched])],
    items: mergeItems(previous?.items ?? [], result.items),
    vars: recipeVars(original),
    ...(telemetry ? { telemetry } : previous?.telemetry ? { telemetry: previous.telemetry } : {}),
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    cliVersion: VERSION,
  }
  await writeLock(lockFile, lock)
  for (const note of new Set(result.notes)) ctx.out(note)
  const missingEnv = [...result.requiredEnvRefs].filter((n) => !ctx.env[n])
  if (missingEnv.length) ctx.out(envHint(ctx, missingEnv))
  await sendEvents(ctx, installEvents(key, result, previous ? 'update' : 'add'))
  ctx.out(tr(ctx, `Готово: ${key}`, `Done: ${key}`))
  return 0
}
