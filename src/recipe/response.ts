import { createHash } from 'node:crypto'

import { parseRecipe } from './schema'

export type EntryLike = {
  slug: string
  type: string
  canonicalSource?: string | null
  installRecipe?: unknown
  installRecipeStatus?: string | null
  installRecipeReason?: string | null
  installRecipeCheckedAt?: string | null
  installRecipeHash?: string | null
  riskLevel?: string | null
  riskReasons?: { text?: string | null }[] | null
  officialVendor?: boolean | null
}

/** Ответ REST и MCP о рецепте записи. Рецепт, не прошедший схему, не отдается. */
export const recipeResponse = (entry: EntryLike, url: string) => {
  const parsed = entry.installRecipe ? parseRecipe(entry.installRecipe) : null
  const broken = Boolean(entry.installRecipe) && !parsed?.ok
  const status = broken ? 'unsupported' : (entry.installRecipeStatus ?? null)
  // Причина есть только у unsupported и review. У рабочего рецепта (auto, ai, verified) в колонке может
  // остаться служебный текст сверки (сбой проверки и т.п.), наружу он не отдается.
  const reason = status === 'unsupported' || status === 'review' ? (broken ? 'рецепт не прошел проверку схемы' : (entry.installRecipeReason ?? null)) : null
  return {
    entry: { slug: entry.slug, type: entry.type, url, canonicalSource: entry.canonicalSource ?? null },
    recipe: parsed?.ok ? parsed.recipe : null,
    status,
    reason,
    risk: { level: entry.riskLevel ?? null, reasons: (entry.riskReasons ?? []).map((r) => r.text ?? '').filter(Boolean) },
    officialVendor: Boolean(entry.officialVendor),
    checkedAt: entry.installRecipeCheckedAt ?? null,
    hash: parsed?.ok ? (entry.installRecipeHash ?? null) : null,
  }
}

export type RecipeResponseBody = ReturnType<typeof recipeResponse>

/** ETag ответа: хеш от всего тела, а не только от hash+status - любое изменение полей меняет ETag. */
export const recipeEtag = (body: RecipeResponseBody): string =>
  `"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)}"`
