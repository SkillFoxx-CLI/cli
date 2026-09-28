import { CliError, tr, type Ctx } from './context'
import { parseRecipe, SIGNATURE_HEADER, verifyBody, type InstallRecipe, type RecipeResponseBody } from './shared'
import { VERSION } from './version'

export type RecipeBody = Omit<RecipeResponseBody, 'entry' | 'recipe'> & {
  entry: RecipeResponseBody['entry'] & { section: string }
  recipe: InstallRecipe | null
  blocked: { severity: string; title: string } | null
  issuedAt: string
}
export type Match = { section: string; slug: string; title: string }
export type Hit = { title: string; tagline?: string; type: string; href: string }

const DAY = 24 * 3600_000
const SKEW = 5 * 60_000

export const userAgent = (): string => `skillfoxx-cli/${VERSION}`

const get = async (ctx: Ctx, url: string): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await ctx.fetch(url, { headers: { 'user-agent': userAgent(), accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      if (res.status >= 500 && attempt === 0) {
        await ctx.sleep(1000)
        continue
      }
      return res
    } catch (error) {
      if (attempt === 0) {
        await ctx.sleep(1000)
        continue
      }
      const reason = (error as Error).message
      throw new CliError(1, tr(ctx, `Нет связи с ${ctx.api}: ${reason}`, `Cannot reach ${ctx.api}: ${reason}`))
    }
  }
}

const failStatus = (ctx: Ctx, res: Response): never => {
  if (res.status === 429) throw new CliError(1, tr(ctx, 'Слишком много запросов, повторите через минуту.', 'Too many requests, try again in a minute.'))
  throw new CliError(1, tr(ctx, `Сервер ответил ${res.status}, повторите позже.`, `The server responded ${res.status}, try again later.`))
}

const SIGNATURE_TEXT = {
  missing: ['Рецепт пришел без подписи, установка остановлена.', 'The recipe has no signature, installation stopped.'],
  malformed: ['Подпись рецепта повреждена, установка остановлена.', 'The recipe signature is damaged, installation stopped.'],
  unknown_key: ['Рецепт подписан неизвестным ключом. Обновите CLI: npx skillfoxx@latest', 'The recipe is signed with an unknown key. Update the CLI: npx skillfoxx@latest'],
  bad_signature: ['Подпись рецепта не сходится, установка остановлена.', 'The recipe signature does not match, installation stopped.'],
} as const

/** Рецепт записи: подпись, запись, свежесть и локальная схема проверяются до того, как им кто-то воспользуется. */
export const fetchRecipe = async (ctx: Ctx, section: string, slug: string): Promise<RecipeBody | null> => {
  if (!Object.keys(ctx.keys).length) {
    throw new CliError(1, tr(ctx, 'В этой сборке нет ключей проверки подписи. Обновите CLI: npx skillfoxx@latest', 'This build has no signature keys. Update the CLI: npx skillfoxx@latest'))
  }
  const res = await get(ctx, `${ctx.api}/api/v1/recipe/${encodeURIComponent(section)}/${encodeURIComponent(slug)}`)
  if (res.status === 404) return null
  if (!res.ok) failStatus(ctx, res)
  const text = await res.text()
  const check = verifyBody(text, res.headers.get(SIGNATURE_HEADER), ctx.keys)
  if (!check.ok) {
    const [ru, en] = SIGNATURE_TEXT[check.reason]
    throw new CliError(1, tr(ctx, ru, en))
  }
  const body = JSON.parse(text) as RecipeBody
  if (body.entry?.section !== section || body.entry?.slug !== slug) {
    throw new CliError(1, tr(ctx, 'Ответ сервера относится к другой записи, установка остановлена.', 'The server response is for another entry, installation stopped.'))
  }
  const issued = Date.parse(body.issuedAt)
  const now = ctx.now().getTime()
  if (!Number.isFinite(issued) || now - issued > DAY || issued - now > SKEW) {
    throw new CliError(1, tr(ctx, 'Подпись рецепта просрочена. Проверьте часы компьютера и повторите.', 'The recipe signature has expired. Check the computer clock and retry.'))
  }
  if (body.recipe) {
    const parsed = parseRecipe(body.recipe)
    if (!parsed.ok) throw new CliError(1, tr(ctx, 'Рецепт не прошел проверку схемы, установка остановлена.', 'The recipe failed schema validation, installation stopped.'))
    body.recipe = parsed.recipe
  }
  return body
}

export const resolveSlug = async (ctx: Ctx, slug: string): Promise<Match[]> => {
  const res = await get(ctx, `${ctx.api}/api/v1/recipe/${encodeURIComponent(slug)}`)
  if (res.status === 404) return []
  if (!res.ok) failStatus(ctx, res)
  const data = (await res.json()) as { matches?: Match[] }
  return (data.matches ?? []).filter((m) => typeof m.section === 'string' && typeof m.slug === 'string')
}

export const searchCatalog = async (ctx: Ctx, query: string, limit = 10): Promise<Hit[]> => {
  const res = await get(ctx, `${ctx.api}/api/v1/search?q=${encodeURIComponent(query)}&lang=${ctx.lang}&limit=${limit}`)
  if (!res.ok) failStatus(ctx, res)
  const data = (await res.json()) as { hits?: Hit[] }
  return (data.hits ?? []).filter((h) => typeof h.href === 'string')
}
