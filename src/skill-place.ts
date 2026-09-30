import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { agentDef, skillsDir, type Scope } from './agents'
import type { Backup } from './config-file'
import { contained, SKILL_NAME, writeBase } from './contain'
import { CliError, tr, type Ctx } from './context'
import { clean } from './io'
import { toLockPath, type LockItem } from './lock'
import type { AgentId } from './shared'
import { gitBlobSha, type SkillFile } from './skill-fetch'

export { SKILL_NAME }
export const MARKER = '.skillfoxx.json'
export type Marker = { entry: string; commitSha: string; contentDigest: string; files: { path: string; sha: string }[] }
export type PlaceInput = { scope: Scope; root: string; name: string; files: SkillFile[]; agents: AgentId[]; force: boolean; backup: Backup; owned: Set<string>; marker: Omit<Marker, 'files'> }
export type PlaceResult = { items: LockItem[]; created: string[]; warnings: string[]; agents: AgentId[] }

export const canonicalBase = (ctx: Ctx, scope: Scope, root: string): string =>
  scope === 'project' ? path.join(root, '.agents', 'skills') : path.join(ctx.home, '.agents', 'skills')

const lstatOrNull = (p: string) => lstat(p).catch(() => null)

/** Цель за границей проекта или папки агента (через символическую ссылку на пути): запись не делается. */
export const outside = (ctx: Ctx, target: string, skipped = false): CliError =>
  new CliError(
    1,
    skipped
      ? tr(ctx, `путь ${clean(target)} через символическую ссылку ведет за пределы проекта или папки агента, пропущено.`, `${clean(target)} leads outside the project or the agent folder through a symbolic link, skipped.`)
      : tr(ctx, `Путь ${clean(target)} через символическую ссылку ведет за пределы проекта или папки агента, запись остановлена.`, `${clean(target)} leads outside the project or the agent folder through a symbolic link, nothing was written.`),
  )

/**
 * Относительная ссылка строится между настоящими путями обеих папок: если папка агента сама ссылка
 * (~/.hermes на другой диск), путь от ее имени увел бы ссылку мимо канонической копии.
 */
const linkOrCopy = async (ctx: Ctx, canonical: string, target: string): Promise<'symlink' | 'copy'> => {
  await mkdir(path.dirname(target), { recursive: true })
  if (ctx.platform !== 'win32') {
    try {
      const [from, to] = await Promise.all([realpath(path.dirname(target)), realpath(canonical)])
      await symlink(path.relative(from, to), target, 'dir')
      return 'symlink'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  }
  await cp(canonical, target, { recursive: true })
  return 'copy'
}

export const placeSkill = async (ctx: Ctx, p: PlaceInput): Promise<PlaceResult> => {
  if (!SKILL_NAME.test(p.name)) throw new CliError(1, tr(ctx, `Недопустимое имя скилла: ${clean(p.name)}`, `Invalid skill name: ${clean(p.name)}`))
  const base = canonicalBase(ctx, p.scope, p.root)
  const canonical = path.join(base, p.name)
  const result: PlaceResult = { items: [], created: [], warnings: [], agents: [] }
  const inside = (target: string) => contained(target, writeBase(p.scope, p.root, target, 'skill'))
  if (!(await inside(canonical))) throw outside(ctx, canonical)

  if (await lstatOrNull(canonical)) {
    if (!p.owned.has(canonical) && !p.force) {
      throw new CliError(1, tr(ctx, `Папка ${canonical} уже есть и поставлена не SkillFoxx. Запустите с --force, старая уйдет в резервную копию.`, `${canonical} already exists and was not installed by SkillFoxx. Run with --force, the old one goes to a backup.`))
    }
    if (!p.force && (await skillState(canonical)) === 'modified') {
      throw new CliError(1, tr(ctx, `Папка скилла ${canonical} изменена руками. Замена: --force, старая уйдет в резервную копию.`, `The skill folder ${canonical} was edited by hand. Replace: --force, the old one goes to a backup.`))
    }
    await p.backup.saveDir(canonical)
  }
  const staging = `${canonical}.skillfoxx-staging-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  for (const file of p.files) {
    const target = path.join(staging, ...file.path.split('/'))
    if (path.relative(staging, target).startsWith('..')) throw new CliError(1, tr(ctx, `Путь вне папки скилла: ${clean(file.path)}`, `Path outside the skill folder: ${clean(file.path)}`))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, file.data, { mode: file.executable ? 0o755 : 0o644 })
  }
  const marker: Marker = { ...p.marker, files: p.files.map((f) => ({ path: f.path, sha: f.sha })) }
  await writeFile(path.join(staging, MARKER), `${JSON.stringify(marker, null, 2)}\n`)
  await mkdir(base, { recursive: true })
  await rename(staging, canonical)
  result.created.push(canonical)
  result.items.push({ kind: 'skill', agent: '*', path: toLockPath(ctx, p.scope, p.root, canonical), link: 'canonical' })

  const linked = new Map<string, 'symlink' | 'copy'>()
  for (const agent of p.agents) {
    const title = agentDef(agent).title
    const dir = skillsDir(ctx, agentDef(agent), p.scope, p.root)
    if (!dir) {
      result.warnings.push(tr(ctx, `${title}: скиллы в этой области не поддерживаются.`, `${title}: skills are not supported in this scope.`))
      continue
    }
    if (path.resolve(dir) === path.resolve(base)) {
      result.agents.push(agent)
      continue
    }
    const target = path.join(dir, p.name)
    const done = linked.get(target)
    if (done) {
      result.items.push({ kind: 'skill', agent, path: toLockPath(ctx, p.scope, p.root, target), link: done })
      result.agents.push(agent)
      continue
    }
    if (!(await inside(target))) {
      result.warnings.push(`${title}: ${outside(ctx, target, true).message}`)
      continue
    }
    const existing = await lstatOrNull(target)
    if (existing) {
      if (existing.isSymbolicLink() && (await realpath(target).catch(() => null)) === (await realpath(canonical))) {
        linked.set(target, 'symlink')
        result.items.push({ kind: 'skill', agent, path: toLockPath(ctx, p.scope, p.root, target), link: 'symlink' })
        result.agents.push(agent)
        continue
      }
      if (!p.owned.has(target) && !p.force) {
        result.warnings.push(tr(ctx, `${title}: папка ${target} уже есть и поставлена не SkillFoxx, пропущено. Замена: --force`, `${title}: ${target} already exists and was not installed by SkillFoxx, skipped. Replace: --force`))
        continue
      }
      await p.backup.saveDir(target)
    }
    const link = await linkOrCopy(ctx, canonical, target)
    linked.set(target, link)
    result.created.push(target)
    result.items.push({ kind: 'skill', agent, path: toLockPath(ctx, p.scope, p.root, target), link })
    result.agents.push(agent)
  }
  return result
}

/** Состояние папки скилла против метки установки: sha блобов всех файлов, кроме самой метки. */
export const skillState = async (dir: string): Promise<'unchanged' | 'modified' | 'missing'> => {
  let marker: Marker
  try {
    marker = JSON.parse(await readFile(path.join(dir, MARKER), 'utf8')) as Marker
  } catch {
    return (await lstatOrNull(dir)) ? 'modified' : 'missing'
  }
  const actual = new Map<string, string>()
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (rel === MARKER) continue
      if (e.isDirectory()) await walk(path.join(d, e.name), rel)
      else actual.set(rel, gitBlobSha(await readFile(path.join(d, e.name))))
    }
  }
  await walk(dir, '')
  if (actual.size !== marker.files.length) return 'modified'
  return marker.files.every((f) => actual.get(f.path) === f.sha) ? 'unchanged' : 'modified'
}
