import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

import { agentDef, expandGlobal, legacySkillsDir, skillsDir, type Scope } from './agents'
import type { Ctx } from './context'
import { fromLockPath, type LockItem } from './lock'
import { SERVER_NAME } from './plan'
import type { AgentId } from './shared'

export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** p лежит внутри base или совпадает с ним (сравнение путей, без обращения к диску). */
export const within = (base: string, p: string): boolean => {
  const rel = path.relative(base, p)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * Настоящий путь с учетом символических ссылок, даже если хвоста пути еще нет: realpath ближайшей
 * существующей папки плюс несуществующий остаток. Висячая ссылка на пути: null, такой путь не проверить.
 */
export const realpathNearest = async (p: string): Promise<string | null> => {
  let cur = path.resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      return path.join(await realpath(cur), ...rest.reverse())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      if (await lstat(cur).catch(() => null)) return null
    }
    const parent = path.dirname(cur)
    if (parent === cur) return null
    rest.push(path.basename(cur))
    cur = parent
  }
}

/**
 * Граница записи (спецификация, раздел 13): цель лежит внутри base по пути, а ее родительская папка после
 * разворота символических ссылок лежит внутри настоящего base. Так закоммиченная ссылка .agents или
 * .cursor, ведущая за пределы проекта, не уводит запись наружу.
 */
export const contained = async (target: string, base: string): Promise<boolean> => {
  if (!within(base, target) || path.resolve(target) === path.resolve(base)) return false
  const [realBase, realParent] = await Promise.all([realpathNearest(base), realpathNearest(path.dirname(target))])
  return Boolean(realBase && realParent && within(realBase, realParent))
}

/**
 * Папка, внутри которой разрешена запись цели. Проект: корень проекта. Пользователь: папка агента, в
 * которой лежит его конфиг (~/.cursor для ~/.cursor/mcp.json) или папка скиллов (~/.claude для
 * ~/.claude/skills), чтобы ссылка ~/.claude как целиком перенесенная папка работала, а подмена
 * ~/.claude/skills ссылкой наружу нет.
 */
export const writeBase = (scope: Scope, root: string, target: string, kind: 'mcp' | 'skill'): string =>
  scope === 'project' ? root : kind === 'mcp' ? path.dirname(target) : path.dirname(path.dirname(target))

/** Файлы конфигов MCP, которые агент может иметь в этой области: основной и легаси (Devin). */
export const mcpFiles = (ctx: Ctx, agent: AgentId, scope: Scope, root: string): string[] => {
  const spot = agentDef(agent).mcp[scope]
  if (!spot) return []
  if (scope === 'project') return [path.join(root, spot.file)]
  return [spot.file, spot.legacyFile].filter((f): f is string => Boolean(f)).map((f) => expandGlobal(ctx, f))
}

/** Папка, в которой лежат папки скиллов агента ('*': каноническая .agents/skills). */
export const skillParent = (ctx: Ctx, agent: AgentId | '*', scope: Scope, root: string): string | null =>
  agent === '*' ? (scope === 'project' ? path.join(root, '.agents', 'skills') : path.join(ctx.home, '.agents', 'skills')) : skillsDir(ctx, agentDef(agent), scope, root)

/**
 * Абсолютный путь элемента lock, если он ровно тот, что CLI сам записал бы для этого агента в этой
 * области: файл конфига агента с его форматом и ключом или папка <папка скиллов>/<имя>. Иначе null:
 * lock с чужим путем не заставит удалить или прочитать постороннее.
 */
export const lockItemTarget = (ctx: Ctx, scope: Scope, root: string, item: LockItem): string | null => {
  if (item.kind === 'mcp') {
    const spot = agentDef(item.agent).mcp[scope]
    if (!spot || spot.format !== item.format || item.key.length !== 2 || item.key[0] !== spot.key || !SERVER_NAME.test(item.key[1])) return null
    const abs = path.resolve(fromLockPath(ctx, root, item.file))
    return mcpFiles(ctx, item.agent, scope, root).some((f) => path.resolve(f) === abs) ? abs : null
  }
  if (item.kind === 'skill') {
    // Прежняя папка агента тоже годится: lock, записанный ранней версией CLI, должен удаляться и обновляться.
    const parents = [skillParent(ctx, item.agent, scope, root), item.agent === '*' ? null : legacySkillsDir(ctx, agentDef(item.agent), scope, root)]
    const abs = path.resolve(fromLockPath(ctx, root, item.path))
    return parents.some((parent) => parent && path.dirname(abs) === path.resolve(parent)) && SKILL_NAME.test(path.basename(abs)) ? abs : null
  }
  return null
}
