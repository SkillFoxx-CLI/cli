import { randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { findNodeAtLocation, parse as parseJsonc, parseTree, type Node, type ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'
import { isMap, isScalar, parseDocument, YAMLMap, type Document, type ScalarTag, type Tags } from 'yaml'

import type { Format } from './agents'
import type { Ctx } from './context'
import { canonicalJSON } from './shared'

export class ConfigEditError extends Error {
  constructor(
    readonly ru: string,
    readonly en: string,
  ) {
    super(ru)
  }
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length

const STR_TAG = 'tag:yaml.org,2002:str'
const BOM = '\ufeff'

/**
 * Скаляр из файла пишется обратно ровно как был (on, 0755, 1:20, 0x1F), а не пересобирается из значения:
 * библиотека печатает 1:20 как 01:20, а это уже строка для PyYAML. Новые узлы (без source) и строки
 * печатаются как обычно.
 */
const verbatimTags = (tags: Tags): Tags =>
  tags.map((tag) => {
    if (typeof tag === 'string' || tag.collection || tag.tag === STR_TAG || !tag.stringify) return tag
    const own = tag.stringify
    const verbatim: ScalarTag = { ...tag, stringify: (item, ctx, onComment, onChompKeep) => (item.type === 'PLAIN' && item.source ? item.source : own(item, ctx, onComment, onChompKeep)) }
    return verbatim
  })

/**
 * YAML агента. Hermes читает config.yaml через PyYAML, а это YAML 1.1: yes, no, on, off там логические,
 * 0755 восьмеричное, 1:20 шестидесятеричное. Для него файл разбирается и пишется по 1.1, тогда строка
 * "yes" в env попадет в файл в кавычках. Целые читаются как BigInt, чтобы длинные числа не теряли разряды.
 */
const parseYaml = (format: Format, text: string): Document =>
  parseDocument(text, { ...(format === 'yaml-1.1' ? { version: '1.1' as const } : {}), intAsBigInt: true, customTags: verbatimTags })

// Целые в пределах точности снова обычные числа: сравнение с записанной конфигурацией идет по значению.
const safeNumbers = (value: unknown): unknown => {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value
  if (Array.isArray(value)) return value.map(safeNumbers)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeNumbers(v)]))
  }
  return value
}

export const parseConfig = (format: Format, text: string): { ok: true; data: unknown } | { ok: false; error: string } => {
  try {
    if (format === 'json') return { ok: true, data: text.trim() ? JSON.parse(text) : {} }
    if (format === 'jsonc') {
      const errors: ParseError[] = []
      const data = parseJsonc(text || '{}', errors, { allowTrailingComma: true, disallowComments: false })
      return errors.length ? { ok: false, error: `строка ${lineOf(text, errors[0].offset)}` } : { ok: true, data: data ?? {} }
    }
    if (format === 'toml') return { ok: true, data: parseToml(text) }
    const doc = parseYaml(format, text)
    if (doc.errors.length) return { ok: false, error: doc.errors[0].message }
    return { ok: true, data: safeNumbers(doc.toJS() ?? {}) }
  } catch (error) {
    return { ok: false, error: (error as Error).message.split('\n')[0] }
  }
}

const indentOf = (text: string) => /^([ \t]+)"/m.exec(text)?.[1] ?? '  '

// Отступ строки, на которой лежит offset: свой для каждой правки, а не единый для всего файла, чтобы
// вложенные объекты сохраняли собственный уровень вложенности.
const lineIndent = (text: string, offset: number): string => {
  let start = offset
  while (start > 0 && text[start - 1] !== '\n') start--
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? ''
}

// value с отступом indentUnit, первая строка без отступа (продолжает "key": ), остальные со сдвигом baseIndent.
const prettyValue = (value: unknown, indentUnit: string, baseIndent: string): string =>
  JSON.stringify(value, null, indentUnit)
    .split('\n')
    .map((line, i) => (i === 0 ? line : baseIndent + line))
    .join('\n')

const objChildren = (n: Node | undefined): Node[] | undefined => (n?.type === 'object' ? n.children : undefined)
const propName = (p: Node): string | undefined => p.children?.[0]?.value as string | undefined

/**
 * Вставка ключа без порчи соседей: правится только место вставки, а не вся строка. jsonc-parser.modify()
 * форматирует весь задетый диапазон текста (includes соседние однострочные объекты на той же строке), поэтому
 * для правки чужих конфигов используется точечная вставка по дереву разбора, а не встроенный форматтер.
 */
const insertJson = (text: string, root: Node, key: string[], value: unknown, indentUnit: string, eol: string): string => {
  let node = root
  let idx = 0
  while (idx < key.length - 1) {
    const next = objChildren(node)?.find((p) => propName(p) === key[idx])?.children?.[1]
    if (!next) break
    node = next
    idx++
  }
  const remaining = key.slice(idx)
  const name = remaining[0]
  if (remaining.length === 1) {
    const existing = objChildren(node)?.find((p) => propName(p) === name)?.children?.[1]
    if (existing) {
      const childIndent = lineIndent(text, existing.offset)
      return text.slice(0, existing.offset) + prettyValue(value, indentUnit, childIndent) + text.slice(existing.offset + existing.length)
    }
  }
  let effectiveValue = value
  for (let i = remaining.length - 1; i >= 1; i--) effectiveValue = { [remaining[i]]: effectiveValue }
  const closeOffset = node.offset + node.length - 1
  const children = objChildren(node) ?? []
  if (!children.length) {
    const parentIndent = lineIndent(text, node.offset)
    const childIndent = parentIndent + indentUnit
    const insert = `${eol}${childIndent}${JSON.stringify(name)}: ${prettyValue(effectiveValue, indentUnit, childIndent)}${eol}${parentIndent}`
    return text.slice(0, node.offset + 1) + insert + text.slice(closeOffset)
  }
  const last = children[children.length - 1]
  const childIndent = lineIndent(text, last.offset)
  const commaOffset = last.offset + last.length
  const insert = `${eol}${childIndent}${JSON.stringify(name)}: ${prettyValue(effectiveValue, indentUnit, childIndent)}`
  return text.slice(0, commaOffset) + ',' + text.slice(commaOffset, closeOffset) + insert + text.slice(closeOffset)
}

/** Удаление ключа: минимальная правка (себя и одну соседнюю запятую), без форматирования остального текста. */
const deleteJson = (text: string, root: Node, key: string[]): string => {
  const parent = findNodeAtLocation(root, key.slice(0, -1))
  const children = objChildren(parent)
  if (!children) return text
  const name = key[key.length - 1]
  const idx = children.findIndex((p) => propName(p) === name)
  if (idx < 0) return text
  const prop = children[idx]
  let removeBegin: number
  let removeEnd = prop.offset + prop.length
  if (idx > 0) {
    removeBegin = children[idx - 1].offset + children[idx - 1].length
  } else {
    removeBegin = parent!.offset + 1
    if (children.length > 1) removeEnd = children[1].offset
  }
  return text.slice(0, removeBegin) + text.slice(removeEnd)
}

const editJson = (text: string, key: string[], value: unknown) => {
  const base = text.trim() ? text : '{}\n'
  const indent = indentOf(base)
  const indentUnit = indent.includes('\t') ? '\t' : indent
  const eol = base.includes('\r\n') ? '\r\n' : '\n'
  const root = parseTree(base)
  if (!root) return base
  return value === undefined ? deleteJson(base, root, key) : insertJson(base, root, key, value, indentUnit, eol)
}

const BARE = /^[A-Za-z0-9_-]+$/
const tomlKey = (k: string) => (BARE.test(k) ? k : JSON.stringify(k))
const tomlValue = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(', ')} }`
  throw new ConfigEditError('значение нельзя записать в TOML', 'the value cannot be written to TOML')
}
const isTable = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

const tomlBlock = (key: string[], value: Record<string, unknown>): string[] => {
  const header = key.map(tomlKey).join('.')
  const lines = [`[${header}]`]
  for (const [k, v] of Object.entries(value)) if (!isTable(v)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`)
  for (const [k, v] of Object.entries(value)) {
    if (!isTable(v)) continue
    lines.push('', `[${header}.${tomlKey(k)}]`)
    for (const [kk, vv] of Object.entries(v)) lines.push(`${tomlKey(kk)} = ${tomlValue(vv)}`)
  }
  return lines
}

/**
 * Базовая строка TOML в заголовке таблицы. Экранирование \U (8 цифр) и прочее, чего нет в JSON, CLI не
 * разбирает: это ошибка правки ConfigEditError, а не падение на JSON.parse.
 */
const basicString = (raw: string): string => {
  const refuse = () => new ConfigEditError('заголовок таблицы TOML с экранированием, которое CLI не разбирает, правьте вручную', 'a TOML table header uses an escape the CLI does not parse, edit it by hand')
  if (/(?:^|[^\\])(?:\\\\)*\\U/.test(raw)) throw refuse()
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    throw refuse()
  }
}

const headerPath = (line: string): string[] | null => {
  const m = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)
  if (!m) return null
  const parts: string[] = []
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y
  let pos = 0
  while (pos < m[1].length) {
    re.lastIndex = pos
    const p = re.exec(m[1])
    if (!p || re.lastIndex === pos) return null
    parts.push(p[1] !== undefined ? basicString(p[1]) : (p[2] ?? p[3]))
    pos = re.lastIndex
  }
  return parts
}
const startsWith = (a: string[], prefix: string[]) => prefix.every((x, i) => a[i] === x)

/**
 * Правка TOML текстом: таблица [key] и ее подтаблицы [key.*] заменяются или дописываются в конец, все
 * остальное остается как было. Встроенные таблицы и точечные ключи не распознаются: результат проверяет
 * checkedEdit, и такая правка отвергается, а не портит файл.
 */
const editToml = (text: string, key: string[], value: unknown) => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const p = headerPath(lines[i])
    if (!p) continue
    if (start < 0 && startsWith(p, key)) start = i
    else if (start >= 0 && !startsWith(p, key)) {
      end = i
      break
    }
  }
  const block = value === undefined ? [] : tomlBlock(key, value as Record<string, unknown>)
  if (start < 0) {
    if (!block.length) return text
    const base = text.replace(/\s*$/, '')
    return `${base ? base + eol + eol : ''}${block.join(eol)}${eol}`
  }
  let blockEnd = end
  while (blockEnd > start + 1 && /^\s*(#.*)?$/.test(lines[blockEnd - 1])) blockEnd--
  return [...lines.slice(0, start), ...block, ...lines.slice(blockEnd)].join(eol)
}

/**
 * Правка YAML через дерево документа (библиотека yaml): комментарии и соседние ключи остаются на месте.
 * Пустой контейнер на пути (mcp_servers: без значения, ~ или {}) становится блочной таблицей: иначе
 * setIn отказывает, а пустой {} превратил бы весь новый сервер в одну строку. Длинные строки не
 * переносятся, окончания строк CRLF и метка BOM остаются, если были в файле.
 */
const editYaml = (format: Format, text: string, key: string[], value: unknown) => {
  const doc = parseYaml(format, text)
  const print = () => {
    let out = doc.toString({ lineWidth: 0 })
    if (text.includes('\r\n')) out = out.replace(/\r?\n/g, '\r\n')
    return text.startsWith(BOM) && !out.startsWith(BOM) ? BOM + out : out
  }
  if (value === undefined) {
    if (doc.getIn(key, true) === undefined) return text
    doc.deleteIn(key)
    return print()
  }
  // Недостающие таблицы на пути создаются явно: сам setIn в схеме 1.1 создал бы их как !!omap.
  if (doc.contents === null) doc.contents = new YAMLMap()
  for (let i = 1; i < key.length; i++) {
    const node = doc.getIn(key.slice(0, i), true)
    if (node === undefined || (isScalar(node) && (node.value === null || node.value === undefined))) doc.setIn(key.slice(0, i), new YAMLMap())
    else if (isMap(node) && node.flow && !node.items.length) node.flow = false
  }
  try {
    doc.setIn(key, doc.createNode(value))
  } catch {
    throw new ConfigEditError(`на пути ${key.join(' > ')} не таблица, правьте вручную`, `${key.join(' > ')} is not a mapping, edit it by hand`)
  }
  return print()
}

export const editConfig = (format: Format, text: string, key: string[], value: unknown): string =>
  format === 'toml' ? editToml(text, key, value) : format === 'yaml' || format === 'yaml-1.1' ? editYaml(format, text, key, value) : editJson(text, key, value)

const getIn = (data: unknown, key: string[]): unknown => key.reduce<unknown>((node, k) => (isTable(node) ? node[k] : undefined), data)

// Копия без ключа и без пустых таблиц по пути к нему: так «до» и «после» сравнимы, даже если контейнер
// mcpServers создан этой правкой.
const withoutKey = (data: unknown, key: string[]): unknown => {
  // Круг через canonicalJSON, а не JSON.stringify: в YAML бывают BigInt, их обычный JSON не пишет.
  const copy = JSON.parse(canonicalJSON(data ?? {})) as Record<string, unknown>
  const trail: Record<string, unknown>[] = [copy]
  for (const k of key.slice(0, -1)) {
    const parent = trail[trail.length - 1]
    // Ключ-контейнер без значения (mcp_servers: в YAML) равен пустой таблице: правка его заполняет.
    if (parent[k] === null) parent[k] = {}
    const next = parent[k]
    if (!isTable(next)) return copy
    trail.push(next)
  }
  delete trail[trail.length - 1][key[key.length - 1]]
  for (let i = trail.length - 1; i > 0; i--) if (!Object.keys(trail[i]).length) delete trail[i - 1][key[i - 1]]
  return copy
}

export const checkedEdit = (format: Format, before: string, key: string[], value: unknown): string => {
  const pb = parseConfig(format, before)
  if (!pb.ok) throw new ConfigEditError(`файл не разбирается (${pb.error}), правьте вручную`, `the file does not parse (${pb.error}), edit it by hand`)
  const after = editConfig(format, before, key, value)
  const pa = parseConfig(format, after)
  if (!pa.ok) throw new ConfigEditError('после правки файл перестал разбираться, изменения не записаны', 'the file stopped parsing after the edit, nothing was written')
  if (canonicalJSON(getIn(pa.data, key)) !== canonicalJSON(value)) throw new ConfigEditError('не удалось безопасно записать ключ, добавьте вручную', 'could not write the key safely, add it by hand')
  if (canonicalJSON(withoutKey(pb.data, key)) !== canonicalJSON(withoutKey(pa.data, key))) throw new ConfigEditError('правка задела другие настройки, изменения не записаны', 'the edit touched other settings, nothing was written')
  return after
}

export type Target = { file: string; format: Format; key: string[] }

const readText = async (file: string): Promise<string | null> => {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export const readKey = async (t: Target): Promise<{ exists: boolean; value?: unknown }> => {
  const text = await readText(t.file)
  if (text === null) return { exists: false }
  const parsed = parseConfig(t.format, text)
  if (!parsed.ok) throw new ConfigEditError(`файл ${t.file} не разбирается (${parsed.error})`, `${t.file} does not parse (${parsed.error})`)
  const value = getIn(parsed.data, t.key)
  return value === undefined ? { exists: false } : { exists: true, value }
}

export const writeAtomic = async (file: string, text: string, mode = 0o644): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.skillfoxx-${process.pid}-${Date.now()}.tmp`
  await writeFile(tmp, text, { mode })
  await rename(tmp, file)
}

/** Правка одного ключа: повторное чтение, если файл изменился между чтением и записью (агент пишет сам). */
export const writeKey = async (backup: Backup, t: Target, value: unknown, newFileMode = 0o644): Promise<void> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const info = await stat(t.file).catch(() => null)
    const text = (await readText(t.file)) ?? ''
    if (!info && value === undefined) return
    const after = checkedEdit(t.format, text, t.key, value)
    const again = await stat(t.file).catch(() => null)
    if (attempt === 0 && (again?.mtimeMs ?? 0) !== (info?.mtimeMs ?? 0)) continue
    await backup.save(t.file)
    await writeAtomic(t.file, after, info ? info.mode & 0o777 : newFileMode)
    return
  }
  throw new ConfigEditError(`файл ${t.file} меняется прямо сейчас, повторите позже`, `${t.file} is being changed right now, retry later`)
}

const encode = (p: string) => p.replace(/[:\\/]+/g, '_')

/** Резервные копии одного запуска: файлы копией, папки переносом; restore возвращает все в обратном порядке. */
export class Backup {
  readonly dir: string
  private readonly steps: (() => Promise<void>)[] = []
  private readonly seen = new Set<string>()

  constructor(ctx: Ctx) {
    // Суффикс отличает бэкапы двух команд, выполненных в одну и ту же миллисекунду (частый случай при
    // фиксированных часах в тестах): без него saveDir второй команды падает ENOTEMPTY при rename в ту же папку.
    this.dir = path.join(ctx.sfHome, 'backups', `${ctx.now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  }

  async save(file: string): Promise<void> {
    if (this.seen.has(file)) return
    this.seen.add(file)
    const text = await readFile(file).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)))
    if (text === null) {
      this.steps.push(() => rm(file, { force: true }))
      return
    }
    const copy = path.join(this.dir, 'files', encode(file))
    await mkdir(path.dirname(copy), { recursive: true })
    await writeFile(copy, text, { mode: 0o600 })
    this.steps.push(() => copyFile(copy, file))
  }

  async saveDir(dir: string): Promise<void> {
    if (this.seen.has(dir)) return
    this.seen.add(dir)
    const moved = path.join(this.dir, 'dirs', encode(dir))
    await mkdir(path.dirname(moved), { recursive: true })
    await rename(dir, moved).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EXDEV') throw e
      await cp(dir, moved, { recursive: true, verbatimSymlinks: true })
      await rm(dir, { recursive: true, force: true })
    })
    this.steps.push(async () => {
      await rm(dir, { recursive: true, force: true })
      await rename(moved, dir).catch(async () => cp(moved, dir, { recursive: true, verbatimSymlinks: true }))
    })
  }

  async restore(): Promise<void> {
    for (const step of this.steps.reverse()) await step()
    this.steps.length = 0
  }
}

export const pruneBackups = async (ctx: Ctx, keep = 20): Promise<void> => {
  const root = path.join(ctx.sfHome, 'backups')
  const sets = (await readdir(root).catch(() => [] as string[])).sort()
  for (const name of sets.slice(0, Math.max(0, sets.length - keep))) await rm(path.join(root, name), { recursive: true, force: true })
}
