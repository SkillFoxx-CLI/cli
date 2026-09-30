import { fetchRecipe } from '../api'
import type { Command } from '../cli'
import { Backup } from '../config-file'
import { chooseTelemetry, disclosureLines, optOuts, withOptOut } from '../disclosures'
import { CliError, tr } from '../context'
import { gate, riskConsent } from '../gate'
import { install, installEvents, itemKey } from '../install'
import { confirm } from '../io'
import { recipeVars, writeLock } from '../lock'
import { buildPlan } from '../plan'
import { sendEvents } from '../telemetry'
import { VERSION } from '../version'
import { removeItems } from './remove'
import { findInstalled, lockScopes } from './target'

/**
 * Обновление только до рецепта, который сейчас отдает SkillFoxx: новый хеш появляется на сервере после
 * еженедельной сверки этапа 1, поэтому непроверенная ветка репозитория сюда не попадает.
 */
export const runUpdate: Command = async (ctx, args, flags) => {
  const targets = args[0]
    ? [await findInstalled(ctx, args[0], flags)]
    : (await lockScopes(ctx, flags)).flatMap((s) => Object.keys(s.lock.entries).map((key) => ({ ...s, key })))
  if (!targets.length) {
    ctx.out(tr(ctx, 'Обновлять нечего: установленных записей нет.', 'Nothing to update: no installed entries.'))
    return 0
  }
  // Самый значимый код среди записей: 5 (нужно согласие на риск) важнее 4 (не поддерживается), 4 важнее
  // 3 (снята или заблокирована), любой из них важнее общего сбоя 1. Скрипт видит, что делать дальше.
  let code = 0
  const fail = (c: number) => (code = Math.max(code, c))
  for (const t of targets) {
    const entry = t.lock.entries[t.key]
    try {
      const body = await fetchRecipe(ctx, entry.section, entry.slug)
      const g = gate(ctx, body)
      if (!g.ok) {
        ctx.err(`${t.key}: ${g.message}${g.code === 3 ? tr(ctx, ` Удалить: npx skillfoxx remove ${t.key}`, ` Remove: npx skillfoxx remove ${t.key}`) : ''}`)
        fail(g.code)
        continue
      }
      if (body!.hash === entry.recipeHash) {
        ctx.out(tr(ctx, `${t.key}: актуально`, `${t.key}: up to date`))
        continue
      }
      const original = body!.recipe!
      const github = original.source.kind === 'github' ? original.source : null
      ctx.out(tr(ctx, `${t.key}: есть сверенная версия, коммит ${entry.commitSha?.slice(0, 7) ?? 'нет'} на ${github?.commitSha.slice(0, 7) ?? 'нет'}`, `${t.key}: a rechecked version is available, commit ${entry.commitSha?.slice(0, 7) ?? 'none'} to ${github?.commitSha.slice(0, 7) ?? 'none'}`))
      for (const w of g.warnings) ctx.err(w)
      await riskConsent(ctx, g, Boolean(flags.yes))
      if (!flags.yes && !(await confirm(ctx, tr(ctx, `Обновить ${t.key}?`, `Update ${t.key}?`), true))) continue
      // Область берется из места lock-файла, а не из записи: проектный lock не может заставить писать в
      // пользовательские конфиги (readLock к тому же отвергает запись с чужим scope).
      const planned = await buildPlan(ctx, original, entry.agents, t.scope, t.root)
      // Выбор по телеметрии из lock повторяется молча; новый вопрос только если рецепт впервые назвал
      // переменную отключения, и тогда раскрытие печатается перед вопросом.
      const offList = optOuts(original, planned)
      if (offList.length && !entry.telemetry && !flags.allowTelemetry) for (const line of disclosureLines(ctx, original)) ctx.out(line)
      const telemetry = await chooseTelemetry(ctx, offList, flags, entry.telemetry)
      const recipe = telemetry === 'off' ? withOptOut(original, offList) : original
      const actions = recipe === original ? planned : await buildPlan(ctx, recipe, entry.agents, t.scope, t.root)
      const result = await install(ctx, { recipe, entryKey: t.key, entryUrl: body!.entry.url, actions, agents: entry.agents, scope: t.scope, root: t.root, force: Boolean(flags.force), yes: Boolean(flags.yes), previous: entry })
      const fresh = new Set(result.items.map(itemKey))
      const stale = entry.items.filter((i) => !fresh.has(itemKey(i)) && (i.kind === 'mcp' || i.kind === 'skill'))
      if (stale.length) await removeItems(ctx, { items: stale, scope: t.scope, root: t.root, force: false, yes: true, backup: new Backup(ctx) })
      t.lock.entries[t.key] = {
        ...entry,
        recipeHash: body!.hash ?? '',
        commitSha: github?.commitSha ?? null,
        contentDigest: github?.contentDigest ?? null,
        status: body!.status ?? '',
        risk: body!.risk.level ?? null,
        agents: [...result.touched],
        items: result.items,
        vars: recipeVars(original),
        ...(telemetry ? { telemetry } : {}),
        updatedAt: ctx.now().toISOString(),
        cliVersion: VERSION,
      }
      await writeLock(t.lockFile, t.lock)
      for (const note of new Set(result.notes)) ctx.out(note)
      await sendEvents(ctx, installEvents(t.key, result, 'update'))
      ctx.out(tr(ctx, `${t.key}: обновлено`, `${t.key}: updated`))
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      ctx.err(`${t.key}: ${error.message}`)
      fail(error.code || 1)
    }
  }
  return code
}
