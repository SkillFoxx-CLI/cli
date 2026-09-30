import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import type { Format, Scope } from './agents'
import type { Flags } from './cli'
import { writeAtomic } from './config-file'
import { CliError, tr, type Ctx } from './context'
import { validPackage } from './plan'
import { AGENT_IDS, sortKeys, type AgentId, type InstallRecipe } from './shared'
import { safeRelative } from './skill-fetch'

export type LockItem =
  | { kind: 'mcp'; agent: AgentId; file: string; format: Format; key: string[]; config: unknown; secrets: string[] }
  | { kind: 'skill'; agent: AgentId | '*'; path: string; link: 'canonical' | 'symlink' | 'copy' }
  | { kind: 'cli'; ecosystem: string; package: string }
  | { kind: 'plugin'; marketplace: string; marketplaceName: string; plugin: string }
  | { kind: 'instructions'; agent: AgentId | null; component: string }

/** Переменная окружения, на которую ссылается рецепт записи: только форма, без значения и описания. */
export type LockVar = { name: string; required: boolean; secret: boolean }

export type LockEntry = {
  section: string
  slug: string
  recipeHash: string
  commitSha: string | null
  contentDigest: string | null
  status: string
  risk: string | null
  scope: Scope
  agents: AgentId[]
  items: LockItem[]
  // Необязательное поле: у lock-записей, поставленных до этой версии CLI, его нет, и doctor тогда
  // просто не проверяет переменные окружения записи (до первого add/update, который его допишет).
  vars?: LockVar[]
  // Выбор по телеметрии инструмента (см. disclosures.ts): off, переменная отключения записана в конфиг
  // сервера; on, отправка оставлена. Есть только у записей, чей рецепт называет переменную отключения;
  // update повторяет выбор без вопроса. CLI 0.3 этого поля не знает и не проверяет.
  telemetry?: 'off' | 'on'
  installedAt: string
  updatedAt: string
  cliVersion: string
}
export type Lock = { lockfileVersion: 1; entries: Record<string, LockEntry> }

/** Переменные окружения, на которые ссылается рецепт: сведение по всем MCP-компонентам, без повтора имени. */
export const recipeVars = (recipe: Pick<InstallRecipe, 'components'>): LockVar[] => {
  const out = new Map<string, LockVar>()
  for (const c of recipe.components) {
    if (c.kind !== 'mcp-stdio' && c.kind !== 'mcp-http') continue
    for (const e of c.env) if (!out.has(e.name)) out.set(e.name, { name: e.name, required: e.required, secret: e.secret })
  }
  return [...out.values()]
}

export const LOCK_FILE = 'skillfoxx-lock.json'

const exists = async (p: string) => Boolean(await stat(p).catch(() => null))

const upward = async (from: string, markers: string[]): Promise<string | null> => {
  let dir = path.resolve(from)
  for (;;) {
    for (const m of markers) if (await exists(path.join(dir, m))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export const projectRoot = async (cwd: string): Promise<string> => (await upward(cwd, ['.git'])) ?? path.resolve(cwd)

export const pickScope = async (ctx: Ctx, flags: Pick<Flags, 'global' | 'project'>): Promise<Scope> => {
  if (flags.global && flags.project) throw new CliError(64, tr(ctx, 'Укажите что-то одно: --global или --project.', 'Pick one: --global or --project.'))
  if (flags.global) return 'global'
  if (flags.project) return 'project'
  return (await upward(ctx.cwd, ['.git', 'package.json', LOCK_FILE])) ? 'project' : 'global'
}

export const rootFor = async (ctx: Ctx, scope: Scope): Promise<string> => (scope === 'project' ? projectRoot(ctx.cwd) : ctx.home)

export const lockFileFor = (ctx: Ctx, scope: Scope, root: string): string => (scope === 'project' ? path.join(root, LOCK_FILE) : path.join(ctx.sfHome, 'lock.json'))

const FORMATS: readonly string[] = ['json', 'jsonc', 'toml', 'yaml', 'yaml-1.1']
const LINKS: readonly string[] = ['canonical', 'symlink', 'copy']
const ENTRY_KEY = /^([a-z]+)\/([A-Za-z0-9][A-Za-z0-9._-]{0,150})$/
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const strOrNull = (v: unknown) => v === null || isStr(v)
const isAgent = (v: unknown): v is AgentId => isStr(v) && (AGENT_IDS as readonly string[]).includes(v)
const strList = (v: unknown, re?: RegExp) => Array.isArray(v) && v.every((x) => isStr(x) && (!re || re.test(x)))

/**
 * Путь из lock. Проект: только относительный путь внутри корня, без .., ~ и абсолютных путей (проектный
 * lock коммитится и может прийти от кого угодно). Пользователь: ~/ или абсолютный путь, тоже без ..
 */
export const lockPathOk = (scope: Scope, p: unknown): boolean => {
  if (!isStr(p) || /[\u0000-\u001f\u007f-\u009f]/.test(p)) return false
  if (scope === 'project') return safeRelative(p) && !p.startsWith('~')
  if (p.startsWith('~/')) return safeRelative(p.slice(2))
  const abs = p.replace(/^[A-Za-z]:/, '')
  return abs.startsWith('/') && safeRelative(abs.slice(1))
}

const varOk = (v: unknown): v is LockVar => isObj(v) && isStr(v.name) && VAR_NAME.test(v.name) && typeof v.required === 'boolean' && typeof v.secret === 'boolean'

const itemOk = (scope: Scope, i: unknown): boolean => {
  if (!isObj(i)) return false
  switch (i.kind) {
    case 'mcp':
      return isAgent(i.agent) && lockPathOk(scope, i.file) && isStr(i.format) && FORMATS.includes(i.format) && strList(i.key) && (i.key as string[]).length > 0 && (i.key as string[]).length <= 4 && strList(i.secrets, VAR_NAME)
    case 'skill':
      return (i.agent === '*' || isAgent(i.agent)) && lockPathOk(scope, i.path) && isStr(i.link) && LINKS.includes(i.link)
    case 'cli':
      return isStr(i.ecosystem) && validPackage(i.ecosystem, i.package)
    case 'plugin':
      return isStr(i.marketplace) && isStr(i.marketplaceName) && isStr(i.plugin)
    case 'instructions':
      return (i.agent === null || isAgent(i.agent)) && isStr(i.component)
    default:
      return false
  }
}

/** Запись lock проходит проверку формы; scope обязан совпадать с местом файла (проект или пользователь). */
export const entryOk = (scope: Scope, key: string, e: unknown): boolean => {
  const m = ENTRY_KEY.exec(key)
  if (!m || !isObj(e)) return false
  return (
    e.section === m[1] && e.slug === m[2] && e.scope === scope &&
    isStr(e.recipeHash) && strOrNull(e.commitSha) && strOrNull(e.contentDigest) && isStr(e.status) && strOrNull(e.risk) &&
    Array.isArray(e.agents) && e.agents.every(isAgent) &&
    Array.isArray(e.items) && e.items.every((i) => itemOk(scope, i)) &&
    (e.vars === undefined || (Array.isArray(e.vars) && e.vars.every(varOk))) &&
    (e.telemetry === undefined || e.telemetry === 'off' || e.telemetry === 'on') &&
    isStr(e.installedAt) && isStr(e.updatedAt) && isStr(e.cliVersion)
  )
}

/** Lock-файл это недоверенный ввод: любая запись не по форме делает файл поврежденным целиком. */
export const readLock = async (file: string, scope: Scope): Promise<Lock> => {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lockfileVersion: 1, entries: {} }
    throw error
  }
  let bad: string | undefined
  try {
    const data = JSON.parse(text) as Lock
    if (data.lockfileVersion !== 1 || !isObj(data.entries)) throw new Error('version')
    bad = Object.keys(data.entries).find((key) => !entryOk(scope, key, data.entries[key]))
    if (bad === undefined) return data
  } catch {}
  const where = bad ? ` (${bad.replace(/[^A-Za-z0-9._/-]/g, '?').slice(0, 160)})` : ''
  throw new CliError(1, `${file}: lock-файл поврежден${where}, исправьте или удалите его / lock file is damaged${where}, fix or delete it`)
}

export const serializeLock = (lock: Lock): string => `${JSON.stringify(sortKeys(lock), null, 2)}\n`
export const writeLock = (file: string, lock: Lock): Promise<void> => writeAtomic(file, serializeLock(lock))

const slash = (p: string) => p.split(path.sep).join('/')

export const toLockPath = (ctx: Ctx, scope: Scope, root: string, abs: string): string => {
  const base = scope === 'project' ? root : ctx.home
  const rel = path.relative(base, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return slash(abs)
  return scope === 'project' ? slash(rel) : `~/${slash(rel)}`
}

export const fromLockPath = (ctx: Ctx, root: string, p: string): string =>
  p.startsWith('~/') ? path.join(ctx.home, p.slice(2)) : path.isAbsolute(p) ? p : path.join(root, p)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const sameString = (actual: string, stored: string, secrets: Set<string>) => {
  if (actual === stored) return true
  let wildcard = false
  const pattern = stored
    .split(/(\$\{[A-Za-z_][A-Za-z0-9_]*\})/)
    .map((part) => {
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(part)
      if (m && secrets.has(m[1])) {
        wildcard = true
        return '[\\s\\S]*'
      }
      return escapeRe(part)
    })
    .join('')
  return wildcard && new RegExp(`^${pattern}$`).test(actual)
}

/** Текущее значение ключа совпадает с записанным SkillFoxx, если ${ИМЯ} секретов считать подстановками. */
export const sameConfig = (actual: unknown, stored: unknown, secrets: string[]): boolean => {
  const set = new Set(secrets)
  const walk = (a: unknown, s: unknown): boolean => {
    if (typeof s === 'string') return typeof a === 'string' && sameString(a, s, set)
    if (Array.isArray(s)) return Array.isArray(a) && a.length === s.length && s.every((x, i) => walk(a[i], x))
    if (s && typeof s === 'object') {
      if (!a || typeof a !== 'object' || Array.isArray(a)) return false
      const ka = Object.keys(a).sort()
      const ks = Object.keys(s).sort()
      return ka.length === ks.length && ks.every((k, i) => ka[i] === k && walk((a as Record<string, unknown>)[k], (s as Record<string, unknown>)[k]))
    }
    return a === s
  }
  return walk(actual, stored)
}

/** Значения секретов из текущего значения ключа по сохраненному шаблону: update не спрашивает их повторно. */
export const extractSecrets = (actual: unknown, stored: unknown, secrets: string[]): Map<string, string> => {
  const set = new Set(secrets)
  const out = new Map<string, string>()
  const walk = (a: unknown, s: unknown): void => {
    if (typeof s === 'string') {
      if (typeof a !== 'string') return
      const names: string[] = []
      const pattern = s
        .split(/(\$\{[A-Za-z_][A-Za-z0-9_]*\})/)
        .map((part) => {
          const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(part)
          if (m && set.has(m[1])) {
            names.push(m[1])
            return '([\\s\\S]*)'
          }
          return escapeRe(part)
        })
        .join('')
      if (!names.length) return
      const match = new RegExp(`^${pattern}$`).exec(a)
      if (match) names.forEach((n, i) => (out.has(n) ? undefined : out.set(n, match[i + 1])))
      return
    }
    if (Array.isArray(s)) {
      if (Array.isArray(a)) s.forEach((x, i) => walk(a[i], x))
      return
    }
    if (s && typeof s === 'object' && a && typeof a === 'object') for (const k of Object.keys(s)) walk((a as Record<string, unknown>)[k], (s as Record<string, unknown>)[k])
  }
  walk(actual, stored)
  return out
}
