import { searchCatalog } from '../api'
import type { Command } from '../cli'
import { CliError, tr } from '../context'
import { clean, printJson } from '../io'

export const targetOf = (href: string): string => href.replace(/^\/(?:en\/)?/, '').replace(/\/+$/, '')

export const runSearch: Command = async (ctx, args, flags) => {
  const query = args.join(' ').trim()
  if (query.length < 2) throw new CliError(64, tr(ctx, 'Запрос от двух символов: npx skillfoxx search postgres', 'The query needs two characters or more: npx skillfoxx search postgres'))
  const hits = await searchCatalog(ctx, query)
  if (flags.json) {
    printJson(ctx, hits.map((h) => ({ ...h, target: targetOf(h.href) })))
    return 0
  }
  if (!hits.length) {
    ctx.out(tr(ctx, 'Ничего не нашлось. Попробуйте другое слово.', 'Nothing found. Try another word.'))
    return 0
  }
  for (const h of hits) {
    ctx.out(`${targetOf(h.href)}  ${clean(h.title)}`)
    if (h.tagline) ctx.out(`  ${clean(h.tagline)}`)
  }
  ctx.out(tr(ctx, 'Поставить: npx skillfoxx add <раздел>/<slug>', 'Install: npx skillfoxx add <section>/<slug>'))
  return 0
}
