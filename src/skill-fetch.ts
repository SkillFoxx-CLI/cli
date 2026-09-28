import { createHash } from 'node:crypto'

import { userAgent } from './api'
import { CliError, tr, type Ctx } from './context'
import { clean } from './io'
import { contentDigest, isRootSkill, skillFiles, type InstallRecipe, type RecipeComponent } from './shared'

export type TreeItem = { path: string; mode: string; type: string; sha: string; size?: number }
export type GithubSource = Extract<InstallRecipe['source'], { kind: 'github' }>
export type SkillComponent = Extract<RecipeComponent, { kind: 'skill' }>
export type SkillFile = { path: string; data: Buffer; sha: string; executable: boolean }
/** Дерево коммита и текст корневого SKILL.md: по нему выбираются файлы скилла в корне (как в отпечатке сервера). */
export type LoadedTree = { tree: TreeItem[]; rootSkillText: string | null; prefetched: Map<string, Buffer> }

export const LIMITS = { files: 1000, fileBytes: 5 * 1024 * 1024, totalBytes: 30 * 1024 * 1024 }

/** sha блоба git: sha1("blob <длина>\0" + содержимое). Его же отдает GitHub в дереве коммита. */
export const gitBlobSha = (data: Buffer): string => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')

export const safeRelative = (p: string): boolean =>
  Boolean(p) && !p.startsWith('/') && !p.includes('\\') && !/^[A-Za-z]:/.test(p) && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')

const fail = (ctx: Ctx, ru: string, en: string): never => {
  throw new CliError(1, tr(ctx, ru, en))
}

const rawUrl = (source: GithubSource, filePath: string) =>
  `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.commitSha}/${filePath.split('/').map(encodeURIComponent).join('/')}`

/** Файл на коммите: размер и sha блоба сверяются с деревом, иначе отказ. */
const fetchBlob = async (ctx: Ctx, source: GithubSource, item: TreeItem, shown: string): Promise<Buffer> => {
  const res = await ctx.fetch(rawUrl(source, item.path), { headers: { 'user-agent': userAgent() }, signal: AbortSignal.timeout(30_000) }).catch((e: Error) => fail(ctx, `Не удалось скачать ${shown}: ${e.message}`, `Failed to download ${shown}: ${e.message}`))
  if (!res.ok) fail(ctx, `Не удалось скачать ${shown} (${res.status}).`, `Failed to download ${shown} (${res.status}).`)
  const data = Buffer.from(await res.arrayBuffer())
  if (data.length > LIMITS.fileBytes) fail(ctx, `Файл ${shown} больше 5 МБ.`, `File ${shown} is larger than 5 MB.`)
  if (gitBlobSha(data) !== item.sha) fail(ctx, `Файл ${shown} не совпадает с проверенным SkillFoxx, установка остановлена.`, `File ${shown} does not match the one SkillFoxx checked, installation stopped.`)
  return data
}

/**
 * Текст корневого SKILL.md для скилла в корне репозитория: сервер считает отпечаток по файлам, на которые
 * он ссылается, поэтому файл скачивается и сверяется по sha до проверки отпечатка. Декодирование как у
 * Response.text() на сервере (UTF-8 без BOM), тот же предел длины.
 */
const rootSkill = async (ctx: Ctx, source: GithubSource, tree: TreeItem[]): Promise<{ text: string; data: Buffer } | null> => {
  const item = tree.find((i) => i.path === 'SKILL.md' && i.type === 'blob')
  if (!item) return null
  if (item.mode === '120000') fail(ctx, 'В скилле символическая ссылка SKILL.md, установка остановлена.', 'The skill has a symbolic link SKILL.md, installation stopped.')
  if ((item.size ?? 0) > LIMITS.fileBytes) fail(ctx, 'Файл SKILL.md больше 5 МБ.', 'File SKILL.md is larger than 5 MB.')
  const data = await fetchBlob(ctx, source, item, 'SKILL.md')
  return { text: new TextDecoder().decode(data).slice(0, 200_000), data }
}

/** Дерево репозитория на зафиксированном коммите, сверенное с отпечатком рецепта до скачивания файлов. */
export const loadTree = async (ctx: Ctx, source: GithubSource, components: RecipeComponent[]): Promise<LoadedTree> => {
  if (!source.contentDigest) throw new CliError(4, tr(ctx, 'У рецепта нет отпечатка файлов скилла, установка невозможна.', 'The recipe has no skill file digest, cannot install.'))
  const url = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${source.commitSha}?recursive=1`
  const headers: Record<string, string> = { 'user-agent': userAgent(), accept: 'application/vnd.github+json' }
  if (ctx.env.GITHUB_TOKEN) headers.authorization = `Bearer ${ctx.env.GITHUB_TOKEN}`
  const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(30_000) }).catch((e: Error) => fail(ctx, `Нет связи с GitHub: ${e.message}`, `Cannot reach GitHub: ${e.message}`))
  if (res.status === 403 || res.status === 429) fail(ctx, 'GitHub ограничил запросы. Задайте GITHUB_TOKEN и повторите.', 'GitHub rate limit reached. Set GITHUB_TOKEN and retry.')
  if (!res.ok) fail(ctx, `Коммит ${source.commitSha.slice(0, 7)} в ${source.owner}/${source.repo} недоступен (${res.status}).`, `Commit ${source.commitSha.slice(0, 7)} in ${source.owner}/${source.repo} is unavailable (${res.status}).`)
  const data = (await res.json()) as { truncated?: boolean; tree?: TreeItem[] }
  if (data.truncated || !Array.isArray(data.tree)) fail(ctx, 'GitHub отдал неполное дерево репозитория, проверить файлы нельзя.', 'GitHub returned a truncated tree, files cannot be verified.')
  const tree = data.tree as TreeItem[]
  const blobs = tree.filter((i) => i.type === 'blob').map((i) => ({ path: i.path, sha: i.sha }))
  const prefetched = new Map<string, Buffer>()
  let rootSkillText: string | null = null
  if (components.some((c) => c.kind === 'skill' && isRootSkill(c))) {
    const root = await rootSkill(ctx, source, tree)
    if (root) {
      rootSkillText = root.text
      prefetched.set('SKILL.md', root.data)
    }
  }
  if (contentDigest(blobs, components, { rootSkillText }) !== source.contentDigest) {
    fail(ctx, 'Файлы в репозитории не совпадают с проверенными SkillFoxx, установка остановлена.', 'Repository files differ from the ones SkillFoxx checked, installation stopped.')
  }
  return { tree, rootSkillText, prefetched }
}

const pool = async <T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

/** Ровно тот набор файлов, по которому сервер считал отпечаток (skillFiles), каждый со сверкой sha. */
export const downloadSkill = async (ctx: Ctx, source: GithubSource, loaded: LoadedTree, component: SkillComponent): Promise<SkillFile[]> => {
  const dir = component.path.replace(/^\/+|\/+$/g, '')
  const items = skillFiles(loaded.tree.filter((i) => i.type !== 'tree'), component, loaded.rootSkillText)
  if (!items.length) fail(ctx, `В репозитории нет файлов скилла ${clean(component.name)}.`, `No files for skill ${clean(component.name)} in the repository.`)
  if (items.length > LIMITS.files) fail(ctx, `В скилле больше ${LIMITS.files} файлов, установка остановлена.`, `The skill has more than ${LIMITS.files} files, installation stopped.`)
  let total = 0
  const planned = items.map((item) => {
    const rel = dir ? item.path.slice(dir.length + 1) : item.path
    const shown = clean(rel)
    if (item.type === 'commit' || item.mode === '160000') fail(ctx, `В скилле подмодуль ${shown}, установка остановлена.`, `The skill has a submodule ${shown}, installation stopped.`)
    if (item.mode === '120000') fail(ctx, `В скилле символическая ссылка ${shown}, установка остановлена.`, `The skill has a symbolic link ${shown}, installation stopped.`)
    if (!safeRelative(rel)) fail(ctx, `Недопустимый путь в скилле: ${shown}`, `Invalid path in the skill: ${shown}`)
    if ((item.size ?? 0) > LIMITS.fileBytes) fail(ctx, `Файл ${shown} больше 5 МБ.`, `File ${shown} is larger than 5 MB.`)
    total += item.size ?? 0
    return { item, rel }
  })
  if (total > LIMITS.totalBytes) fail(ctx, 'Скилл больше 30 МБ, установка остановлена.', 'The skill is larger than 30 MB, installation stopped.')
  const files = await pool(planned, 6, async ({ item, rel }) => {
    const data = loaded.prefetched.get(item.path) ?? (await fetchBlob(ctx, source, item, clean(rel)))
    // Исполняемый бит из режима дерева git: скрипты скилла должны запускаться так же, как в репозитории.
    return { path: rel, data, sha: item.sha, executable: item.mode === '100755' }
  })
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
