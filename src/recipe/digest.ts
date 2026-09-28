import { createHash } from 'node:crypto'

import type { RecipeComponent } from './schema'

/** Файл дерева GitHub на коммите: путь и sha блоба (sha меняется при любой правке содержимого). */
export type TreeBlob = { path: string; sha: string }

// Служебные папки git и CI и артефакты сборки: агент их вместе со скиллом не загружает.
const ROOT_EXCLUDED = /(^|\/)(\.git|\.github|node_modules|dist|build)\//

/**
 * Файл репозитория входит в папку скилла dir (пустая строка: скилл в корне репозитория). Для корня
 * это только грубая граница (без служебных папок): точный набор файлов корневого скилла с учетом
 * ссылок SKILL.md дает skillFiles.
 */
export const inSkillDir = (dir: string, filePath: string): boolean => {
  const clean = dir.replace(/^\/+|\/+$/g, '')
  return clean ? filePath.startsWith(`${clean}/`) : !ROOT_EXCLUDED.test(filePath)
}

// Папки ресурсов скилла по спецификации Agent Skills: у скилла в корне репозитория они лежат в корне.
const ROOT_SKILL_DIRS = ['scripts', 'references', 'assets', 'templates']

/**
 * Относительные ссылки SKILL.md на файлы и папки репозитория: markdown [текст](путь), картинки,
 * ссылки-сноски [id]: путь и атрибуты href/src. Внешние адреса (со схемой), якоря, абсолютные пути и
 * пути, выходящие за корень через .., отбрасываются. Путь нормализуется: без ./, якоря и query.
 */
// Предел разбираемого текста SKILL.md: ссылки дальше него не учитываются, разбор не растет без границы.
const SKILL_TEXT_LIMIT = 50_000

export const skillLinks = (fullText: string): string[] => {
  const text = fullText.slice(0, SKILL_TEXT_LIMIT)
  const raw: string[] = []
  // Классы без скобок: перебор не уходит за следующую ссылку, строка из "](" без ")" разбирается линейно.
  for (const m of text.matchAll(/\]\(\s*<?([^()[\]\s<>]+)>?(?:\s+["'(][^()[\]]*)?\)/g)) raw.push(m[1])
  for (const m of text.matchAll(/^[ \t]{0,3}\[[^[\]\n]+\]:[ \t]*<?([^\s<>]+)>?/gm)) raw.push(m[1])
  for (const m of text.matchAll(/\b(?:href|src)\s*=\s*["']([^"'\n]+)["']/gi)) raw.push(m[1])
  const out = new Set<string>()
  for (const link of raw) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('#') || link.startsWith('/')) continue
    let path = link.replace(/[#?].*$/, '')
    try {
      path = decodeURIComponent(path)
    } catch {
      continue
    }
    const parts: string[] = []
    let escaped = false
    for (const seg of path.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') {
        if (!parts.length) escaped = true
        parts.pop()
        continue
      }
      parts.push(seg)
    }
    if (!escaped && parts.length) out.add(parts.join('/'))
  }
  return [...out]
}

/**
 * Файлы скилла в корне репозитория: сам SKILL.md, папки ресурсов из ROOT_SKILL_DIRS, если они есть,
 * и файлы или папки, на которые SKILL.md ссылается относительными ссылками. Не все дерево: иначе
 * любая правка README или кода рядом со скиллом меняла бы отпечаток и отправляла проверенный рецепт
 * на проверку. Без текста SKILL.md (не прочитан) ссылки не учитываются, остаются SKILL.md и папки ресурсов.
 */
const rootSkillFiles = <T extends { path: string }>(blobs: T[], skillText: string | null | undefined): T[] => {
  const prefixes = [...ROOT_SKILL_DIRS]
  const exact = new Set(['SKILL.md'])
  for (const link of skillText ? skillLinks(skillText) : []) {
    exact.add(link)
    prefixes.push(link)
  }
  return blobs.filter((b) => !ROOT_EXCLUDED.test(b.path) && (exact.has(b.path) || prefixes.some((dir) => b.path.startsWith(`${dir}/`))))
}

/**
 * Файлы одного скилла: все под его папкой, для скилла в корне см. rootSkillFiles (нужен текст корневого
 * SKILL.md). Один выбор для отпечатка на сервере и для загрузки в CLI: CLI скачивает ровно тот набор,
 * по которому считан отпечаток рецепта.
 */
export const skillFiles = <T extends { path: string }>(blobs: T[], component: { path: string }, rootSkillText?: string | null): T[] => {
  const dir = component.path.replace(/^\/+|\/+$/g, '')
  return dir ? blobs.filter((b) => inSkillDir(dir, b.path)) : rootSkillFiles(blobs, rootSkillText)
}

/** Скилл в корне репозитория: отпечатку и загрузке нужен текст его SKILL.md. */
export const isRootSkill = (component: { path: string }): boolean => !component.path.replace(/^\/+|\/+$/g, '')

/**
 * Отпечаток содержимого, которое агент получит вместе с компонентами: sha256 по отсортированным строкам
 * "путь\tsha блоба". Скилл в папке: все файлы под ней (скрипты и ресурсы рядом с SKILL.md, а не только
 * он сам). Скилл в корне: см. rootSkillFiles, для него нужен текст корневого SKILL.md (rootSkillText).
 * Правила: сам файл правил. Для остальных видов компонентов отпечатка нет (undefined): их содержимое
 * проверяется через реестры пакетов и команды.
 */
export const contentDigest = (blobs: TreeBlob[], components: RecipeComponent[], opts: { rootSkillText?: string | null } = {}): string | undefined => {
  const selected = new Map<string, string>()
  let covered = false
  for (const c of components) {
    if (c.kind === 'skill') {
      covered = true
      for (const b of skillFiles(blobs, c, opts.rootSkillText)) selected.set(b.path, b.sha)
    } else if (c.kind === 'rules') {
      covered = true
      for (const b of blobs) if (b.path === c.path) selected.set(b.path, b.sha)
    }
  }
  if (!covered) return undefined
  // Сортировка по кодовым единицам, без локали: отпечаток не должен зависеть от окружения.
  const lines = [...selected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, sha]) => `${path}\t${sha}`)
  return `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`
}
