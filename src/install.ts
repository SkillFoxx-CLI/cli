import { rm } from 'node:fs/promises'

import { agentDef, type Scope } from './agents'
import { Backup, ConfigEditError, pruneBackups, readKey, writeKey } from './config-file'
import { contained, lockItemTarget, writeBase } from './contain'
import { CliError, findOnPath, tr, type Ctx } from './context'
import { clean, confirm } from './io'
import { extractSecrets, sameConfig, toLockPath, type LockEntry, type LockItem } from './lock'
import { componentName, ecosystemCommand, manualNote, type Action } from './plan'
import { collectValues, resolverFor } from './secrets'
import { serverEntry, type AgentId, type InstallRecipe, type McpComponent } from './shared'
import { downloadSkill, loadTree, type LoadedTree } from './skill-fetch'
import { outside, placeSkill } from './skill-place'
import type { InstallEvent } from './telemetry'

export type InstallInput = { recipe: InstallRecipe; entryKey: string; entryUrl: string; actions: Action[]; agents: AgentId[]; scope: Scope; root: string; force: boolean; yes: boolean; previous?: LockEntry }
// requiredEnvRefs: обязательные секреты, которые в итоге легли в конфиг проекта ссылкой на переменную
// окружения (а не значением). GUI-агент, запущенный не из терминала, эту переменную может не увидеть
// (см. add.ts): по этому набору после установки решается, нужна ли подсказка про launchctl setenv.
export type InstallResult = { items: LockItem[]; notes: string[]; touched: Set<AgentId>; cliInstalled: boolean; requiredEnvRefs: Set<string> }

export const itemKey = (i: LockItem): string =>
  i.kind === 'mcp' ? `mcp|${i.file}|${i.key.join('\u0000')}` : i.kind === 'skill' ? `skill|${i.path}` : i.kind === 'cli' ? `cli|${i.ecosystem}|${i.package}` : i.kind === 'plugin' ? `plugin|${i.plugin}@${i.marketplaceName}` : `instructions|${i.agent}|${i.component}`

/** Повторный add с другими агентами дополняет запись lock, а не забывает прошлые элементы. */
export const mergeItems = (old: LockItem[], fresh: LockItem[]): LockItem[] => {
  const keys = new Set(fresh.map(itemKey))
  return [...old.filter((i) => !keys.has(itemKey(i))), ...fresh]
}

export const installEvents = (key: string, result: InstallResult, event: InstallEvent['event']): InstallEvent[] => {
  const agents: InstallEvent['agent'][] = [...result.touched]
  if (!agents.length && result.cliInstalled) agents.push('none')
  return agents.map((agent) => ({ entry: key, agent, event }))
}

const sameKey = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Значения секретов из прошлой установки, чтобы update не спрашивал их снова. Lock это недоверенный ввод,
 * поэтому только в пользовательской области (в проектной секретов в файлах нет), только из ключа, который
 * этот запуск сам перезапишет (тот же агент, файл и ключ), и только для переменных, которые новый рецепт
 * объявляет секретными. Иначе lock мог бы перенести чужой токен в адрес другого сервера.
 */
const knownSecrets = async (ctx: Ctx, p: InstallInput): Promise<Map<string, string>> => {
  const known = new Map<string, string>()
  if (p.scope !== 'global') return known
  for (const item of p.previous?.items ?? []) {
    if (item.kind !== 'mcp' || !item.secrets.length) continue
    const abs = lockItemTarget(ctx, p.scope, p.root, item)
    const action = p.actions.find((a): a is Extract<Action, { type: 'mcp' }> => a.type === 'mcp' && a.agent === item.agent && a.target.file === abs && a.target.format === item.format && sameKey(a.target.key, item.key))
    if (!abs || !action) continue
    const declared = new Set(action.component.env.filter((e) => e.secret).map((e) => e.name))
    const names = item.secrets.filter((n) => declared.has(n))
    if (!names.length) continue
    const current = await readKey(action.target).catch(() => ({ exists: false }) as { exists: boolean; value?: unknown })
    if (current.exists) for (const [n, v] of extractSecrets(current.value, item.config, names)) if (!known.has(n)) known.set(n, v)
  }
  return known
}

export const install = async (ctx: Ctx, p: InstallInput): Promise<InstallResult> => {
  const backup = new Backup(ctx)
  const created: string[] = []
  const res: InstallResult = { items: [], notes: [], touched: new Set(), cliInstalled: false, requiredEnvRefs: new Set() }
  const prev = p.previous?.items ?? []
  const owned = new Set(prev.flatMap((i) => (i.kind === 'skill' ? [lockItemTarget(ctx, p.scope, p.root, i)] : [])).filter((x): x is string => Boolean(x)))
  // Откат один на запуск: Ctrl+C во время вопроса запускает его и из обработчика SIGINT, и из catch.
  let rolledBack: Promise<void> | null = null
  const rollback = () =>
    (rolledBack ??= (async () => {
      for (const dir of created.splice(0).reverse()) await rm(dir, { recursive: true, force: true })
      await backup.restore()
    })())
  const onSigint = () => void rollback().finally(() => process.exit(130))
  process.once('SIGINT', onSigint)
  try {
    const mcp = new Map<string, McpComponent>()
    for (const a of p.actions) if (a.type === 'mcp') mcp.set(a.component.name, a.component)
    const values = await collectValues(ctx, [...mcp.values()], { needSecrets: p.scope === 'global', known: await knownSecrets(ctx, p) })
    let tree: LoadedTree | null = null
    for (const action of p.actions) {
      if (action.type === 'skill') {
        if (p.recipe.source.kind !== 'github') throw new CliError(4, tr(ctx, 'Скилл без репозитория GitHub поставить нельзя.', 'A skill without a GitHub repository cannot be installed.'))
        tree ??= await loadTree(ctx, p.recipe.source, p.recipe.components)
        const files = await downloadSkill(ctx, p.recipe.source, tree, action.component)
        const placed = await placeSkill(ctx, {
          scope: p.scope, root: p.root, name: action.component.name, files, agents: p.agents, force: p.force, backup, owned,
          marker: { entry: p.entryKey, commitSha: p.recipe.source.commitSha, contentDigest: p.recipe.source.contentDigest ?? '' },
        })
        created.push(...placed.created)
        res.items.push(...placed.items)
        res.notes.push(...placed.warnings)
        placed.agents.forEach((a) => res.touched.add(a))
        if (p.scope === 'project' && placed.agents.includes('hermes')) {
          res.notes.push(tr(ctx, 'Hermes Agent: скиллы проекта загружаются только в доверенном проекте. Выполните в корне проекта: hermes skills trust', 'Hermes Agent: project skills load only in a trusted project. Run in the project root: hermes skills trust'))
        }
      } else if (action.type === 'mcp') {
        await installMcp(ctx, p, action, values, backup, prev, res)
      } else if (action.type === 'plugin') {
        const c = action.component
        res.notes.push(tr(ctx, `Claude Code: выполните внутри Claude Code\n  /plugin marketplace add ${clean(c.marketplace)}\n  /plugin install ${clean(c.plugin)}@${clean(c.marketplaceName)}`, `Claude Code: run inside Claude Code\n  /plugin marketplace add ${clean(c.marketplace)}\n  /plugin install ${clean(c.plugin)}@${clean(c.marketplaceName)}`))
        res.items.push({ kind: 'plugin', marketplace: c.marketplace, marketplaceName: c.marketplaceName, plugin: c.plugin })
      } else if (action.type === 'cli') {
        await installCli(ctx, p, action, res)
      } else {
        res.notes.push(manualNote(ctx, action, p.entryUrl))
        res.items.push({ kind: 'instructions', agent: action.agent, component: componentName(action.component) })
      }
    }
    await pruneBackups(ctx)
    return res
  } catch (error) {
    await rollback()
    throw error
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

const installMcp = async (ctx: Ctx, p: InstallInput, action: Extract<Action, { type: 'mcp' }>, values: Map<string, string>, backup: Backup, prev: LockItem[], res: InstallResult) => {
  const title = agentDef(action.agent).title
  if (!(await contained(action.target.file, writeBase(p.scope, p.root, action.target.file, 'mcp')))) {
    res.notes.push(`${title}: ${outside(ctx, action.target.file, true).message}`)
    return
  }
  const r = resolverFor(ctx, action.agent, p.scope, action.component, values)
  if (!r.ok) {
    res.notes.push(`${title}: ${tr(ctx, r.reason.ru, r.reason.en)}`)
    res.items.push({ kind: 'instructions', agent: action.agent, component: action.component.name })
    return
  }
  const value = serverEntry(action.agent, r.component, r.resolve)
  const stored = serverEntry(action.agent, r.component, r.mask)
  const file = toLockPath(ctx, p.scope, p.root, action.target.file)
  let current: { exists: boolean; value?: unknown }
  try {
    current = await readKey(action.target)
  } catch (error) {
    if (!(error instanceof ConfigEditError)) throw error
    res.notes.push(`${title}: ${tr(ctx, error.ru, error.en)}`)
    return
  }
  if (current.exists && !p.force) {
    const mine = prev.find((i) => i.kind === 'mcp' && i.file === file && sameKey(i.key, action.target.key))
    const untouched = mine?.kind === 'mcp' && sameConfig(current.value, mine.config, mine.secrets)
    if (!untouched) {
      const question = tr(ctx, `${title}: в ${file} уже есть ${action.component.name}, и это не установка SkillFoxx или ее изменили. Заменить?`, `${title}: ${file} already has ${action.component.name}, not installed by SkillFoxx or edited. Replace?`)
      const replace = ctx.tty && !p.yes ? await confirm(ctx, question, false) : false
      if (!replace) {
        res.notes.push(tr(ctx, `${title}: ключ ${action.component.name} занят, пропущено. Замена: --force`, `${title}: key ${action.component.name} is taken, skipped. Replace: --force`))
        return
      }
    }
  }
  try {
    await writeKey(backup, action.target, value, p.scope === 'global' ? 0o600 : 0o644)
  } catch (error) {
    if (!(error instanceof ConfigEditError)) throw error
    res.notes.push(`${title}: ${tr(ctx, error.ru, error.en)}`)
    return
  }
  res.items.push({ kind: 'mcp', agent: action.agent, file, format: action.target.format, key: action.target.key, config: stored, secrets: r.secrets })
  res.touched.add(action.agent)
  if (p.scope === 'project' && action.agent === 'codex') res.notes.push(tr(ctx, 'Codex читает .codex/config.toml только в доверенных проектах.', 'Codex reads .codex/config.toml only in trusted projects.'))
  if (p.scope === 'project' && action.agent === 'amp') res.notes.push(tr(ctx, 'Amp: подтвердите сервер командой amp mcp approve.', 'Amp: approve the server with amp mcp approve.'))
  if (action.agent === 'hermes') res.notes.push(tr(ctx, 'Hermes Agent: сервер появится в новой сессии или после команды /reload-mcp.', 'Hermes Agent: the server shows up in a new session or after /reload-mcp.'))
  if (r.references.length) res.notes.push(tr(ctx, `Задайте переменные окружения перед запуском агента: ${r.references.join(', ')}`, `Set environment variables before starting the agent: ${r.references.join(', ')}`))
  for (const name of r.references) if (r.component.env.find((e) => e.name === name)?.required) res.requiredEnvRefs.add(name)
  if (r.secrets.length) res.notes.push(tr(ctx, `${title}: значения секретов записаны в ${file}.`, `${title}: secret values are stored in ${file}.`))
}

const installCli = async (ctx: Ctx, p: InstallInput, action: Extract<Action, { type: 'cli' }>, res: InstallResult) => {
  const [cmd, args] = ecosystemCommand(action.component)!
  const bin = await findOnPath(ctx, cmd)
  if (!bin) {
    res.notes.push(tr(ctx, `Не найден ${cmd}. Выполните сами: ${cmd} ${args.join(' ')}`, `${cmd} not found. Run it yourself: ${cmd} ${args.join(' ')}`))
    res.items.push({ kind: 'instructions', agent: null, component: action.component.package })
    return
  }
  if (!p.yes && !(await confirm(ctx, tr(ctx, `Выполнить: ${cmd} ${args.join(' ')}?`, `Run: ${cmd} ${args.join(' ')}?`), true))) {
    res.items.push({ kind: 'instructions', agent: null, component: action.component.package })
    return
  }
  const r = await ctx.exec(bin, args, 600_000)
  if (r.code !== 0) throw new CliError(1, tr(ctx, `${cmd} завершился с кодом ${r.code}: ${clean(r.stderr.slice(-400))}`, `${cmd} exited with code ${r.code}: ${clean(r.stderr.slice(-400))}`))
  res.items.push({ kind: 'cli', ecosystem: action.component.ecosystem, package: action.component.package })
  res.cliInstalled = true
}
