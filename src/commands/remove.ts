import { lstat, rm } from 'node:fs/promises'

import type { Scope } from '../agents'
import type { Command } from '../cli'
import { Backup, ConfigEditError, readKey, writeKey } from '../config-file'
import { contained, lockItemTarget, writeBase } from '../contain'
import { CliError, findOnPath, tr, type Ctx } from '../context'
import { clean, confirm } from '../io'
import { sameConfig, writeLock, type LockItem } from '../lock'
import { uninstallCommand } from '../plan'
import type { AgentId } from '../shared'
import { skillState } from '../skill-place'
import { sendEvents } from '../telemetry'
import { findInstalled } from './target'

export type RemoveInput = { items: LockItem[]; scope: Scope; root: string; force: boolean; yes: boolean; backup: Backup }
export type RemoveResult = { removed: LockItem[]; kept: LockItem[]; notes: string[] }

export const describeItem = (ctx: Ctx, i: LockItem): string =>
  i.kind === 'mcp' ? `${i.file}: ${i.key.join(' > ')}`
  : i.kind === 'skill' ? i.path
  : i.kind === 'cli' ? `${i.ecosystem} ${clean(i.package)}`
  : i.kind === 'plugin' ? tr(ctx, `плагин ${clean(i.plugin)}@${clean(i.marketplaceName)}`, `plugin ${clean(i.plugin)}@${clean(i.marketplaceName)}`)
  : tr(ctx, `вручную: ${clean(i.component)}`, `by hand: ${clean(i.component)}`)

const allowed = async (ctx: Ctx, p: RemoveInput, question: string) => p.force || (ctx.tty && !p.yes && (await confirm(ctx, question, false)))

/**
 * Путь элемента lock, который можно трогать: ровно тот, что CLI записал бы сам (lockItemTarget), и без
 * выхода за проект или папку агента через символические ссылки. Иначе null, элемент остается в lock.
 */
const safeTarget = async (ctx: Ctx, p: RemoveInput, item: Extract<LockItem, { kind: 'mcp' | 'skill' }>): Promise<string | null> => {
  const abs = lockItemTarget(ctx, p.scope, p.root, item)
  return abs && (await contained(abs, writeBase(p.scope, p.root, abs, item.kind))) ? abs : null
}

/** Удаляет элементы в обратном порядке установки: сначала ссылки агентов, потом каноническая папка. */
export const removeItems = async (ctx: Ctx, p: RemoveInput): Promise<RemoveResult> => {
  const res: RemoveResult = { removed: [], kept: [], notes: [] }
  const refuse = (item: LockItem, shown: string) => {
    res.notes.push(tr(ctx, `${clean(shown)}: путь не совпадает с папкой агента или ведет за пределы через символическую ссылку, оставлено.`, `${clean(shown)}: the path is not the agent folder or leads outside through a symbolic link, kept.`))
    res.kept.push(item)
  }
  for (const item of [...p.items].reverse()) {
    if (item.kind === 'mcp') {
      const file = await safeTarget(ctx, p, item)
      if (!file) {
        refuse(item, item.file)
        continue
      }
      const target = { file, format: item.format, key: item.key }
      let current: { exists: boolean; value?: unknown }
      try {
        current = await readKey(target)
      } catch (error) {
        if (!(error instanceof ConfigEditError)) throw error
        res.notes.push(`${item.file}: ${tr(ctx, error.ru, error.en)}`)
        res.kept.push(item)
        continue
      }
      if (current.exists && !sameConfig(current.value, item.config, item.secrets) && !(await allowed(ctx, p, tr(ctx, `${item.file}: ключ ${item.key.at(-1)} изменен вручную. Удалить?`, `${item.file}: key ${item.key.at(-1)} was edited by hand. Remove?`)))) {
        res.notes.push(tr(ctx, `${item.file}: ключ ${item.key.at(-1)} изменен вручную, оставлен. Удаление: --force`, `${item.file}: key ${item.key.at(-1)} was edited by hand, kept. Remove: --force`))
        res.kept.push(item)
        continue
      }
      if (current.exists) {
        try {
          await writeKey(p.backup, target, undefined)
        } catch (error) {
          if (!(error instanceof ConfigEditError)) throw error
          res.notes.push(`${item.file}: ${tr(ctx, error.ru, error.en)}`)
          res.kept.push(item)
          continue
        }
      }
      res.removed.push(item)
    } else if (item.kind === 'skill') {
      const abs = await safeTarget(ctx, p, item)
      if (!abs) {
        refuse(item, item.path)
        continue
      }
      const st = await lstat(abs).catch(() => null)
      if (!st) {
        res.removed.push(item)
      } else if (st.isSymbolicLink()) {
        await rm(abs, { force: true })
        res.removed.push(item)
      } else if ((await skillState(abs)) !== 'unchanged' && !(await allowed(ctx, p, tr(ctx, `${item.path}: в папке скилла есть изменения. Удалить?`, `${item.path}: the skill folder has changes. Remove?`)))) {
        res.notes.push(tr(ctx, `${item.path}: в папке есть изменения, оставлена. Удаление: --force`, `${item.path}: the folder has changes, kept. Remove: --force`))
        res.kept.push(item)
      } else {
        await p.backup.saveDir(abs)
        res.removed.push(item)
      }
    } else if (item.kind === 'cli') {
      const cmd = uninstallCommand(item.ecosystem, item.package)
      const bin = cmd && ctx.platform !== 'win32' ? await findOnPath(ctx, cmd[0]) : null
      if (!cmd || !bin) res.notes.push(tr(ctx, `Удалите CLI-инструмент ${clean(item.package)} вручную.`, `Remove the CLI tool ${clean(item.package)} by hand.`))
      else if (p.yes || (ctx.tty && (await confirm(ctx, tr(ctx, `Выполнить: ${cmd[0]} ${cmd[1].join(' ')}?`, `Run: ${cmd[0]} ${cmd[1].join(' ')}?`), true)))) {
        const r = await ctx.exec(bin, cmd[1], 600_000)
        if (r.code !== 0) res.notes.push(tr(ctx, `${cmd[0]} завершился с кодом ${r.code}, удалите вручную.`, `${cmd[0]} exited with code ${r.code}, remove by hand.`))
      } else res.notes.push(`${cmd[0]} ${cmd[1].join(' ')}`)
      res.removed.push(item)
    } else if (item.kind === 'plugin') {
      res.notes.push(tr(ctx, `Claude Code: выполните /plugin uninstall ${clean(item.plugin)}@${clean(item.marketplaceName)}`, `Claude Code: run /plugin uninstall ${clean(item.plugin)}@${clean(item.marketplaceName)}`))
      res.removed.push(item)
    } else {
      res.notes.push(tr(ctx, `${clean(item.component)} ставился вручную, удалите его так же.`, `${clean(item.component)} was added by hand, remove it the same way.`))
      res.removed.push(item)
    }
  }
  return res
}

export const runRemove: Command = async (ctx, args, flags) => {
  if (args.length !== 1) throw new CliError(64, tr(ctx, 'Укажите запись: npx skillfoxx remove <раздел>/<slug>', 'Name the entry: npx skillfoxx remove <section>/<slug>'))
  const found = await findInstalled(ctx, args[0], flags)
  const entry = found.lock.entries[found.key]
  ctx.out(tr(ctx, `Будет удалено (${found.key}):`, `To be removed (${found.key}):`))
  for (const item of entry.items) ctx.out(`  ${describeItem(ctx, item)}`)
  if (!flags.yes && !(await confirm(ctx, tr(ctx, 'Удалить?', 'Remove?'), true))) return 1
  const backup = new Backup(ctx)
  let result: RemoveResult
  try {
    result = await removeItems(ctx, { items: entry.items, scope: found.scope, root: found.root, force: Boolean(flags.force), yes: Boolean(flags.yes), backup })
  } catch (error) {
    await backup.restore()
    throw error
  }
  if (result.kept.length) found.lock.entries[found.key] = { ...entry, items: result.kept, updatedAt: ctx.now().toISOString() }
  else delete found.lock.entries[found.key]
  await writeLock(found.lockFile, found.lock)
  for (const note of new Set(result.notes)) ctx.out(note)
  const agents: AgentId[] = result.kept.length ? [...new Set(result.removed.flatMap((i) => (i.kind === 'mcp' ? [i.agent] : [])))] : entry.agents
  await sendEvents(ctx, agents.map((agent) => ({ entry: found.key, agent, event: 'remove' as const })))
  ctx.out(result.kept.length ? tr(ctx, `Удалено частично: ${found.key}. Что осталось: npx skillfoxx list`, `Partly removed: ${found.key}. What is left: npx skillfoxx list`) : tr(ctx, `Удалено: ${found.key}`, `Removed: ${found.key}`))
  return 0
}
