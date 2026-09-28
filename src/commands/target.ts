import type { Scope } from '../agents'
import { resolveSlug } from '../api'
import type { Flags } from '../cli'
import { CliError, tr, type Ctx } from '../context'
import { clean } from '../io'
import { lockFileFor, pickScope, readLock, rootFor, type Lock } from '../lock'

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/

export const resolveTarget = async (ctx: Ctx, input: string): Promise<{ section: string; slug: string }> => {
  const full = /^([a-z]+)\/([A-Za-z0-9][A-Za-z0-9._-]{0,150})$/.exec(input)
  if (full) return { section: full[1], slug: full[2] }
  if (!SLUG.test(input)) throw new CliError(64, tr(ctx, 'Укажите запись как <раздел>/<slug>, например mcp/vv-mcp-server', 'Name the entry as <section>/<slug>, for example mcp/vv-mcp-server'))
  const matches = await resolveSlug(ctx, input)
  if (!matches.length) throw new CliError(3, tr(ctx, 'Записи нет в каталоге или она снята.', 'The entry is not in the catalog or was removed.'))
  if (matches.length === 1) return matches[0]
  const list = matches.map((m) => `${m.section}/${m.slug}`).join(', ')
  if (!ctx.tty) throw new CliError(64, tr(ctx, `${clean(input)} есть в нескольких разделах: ${list}. Укажите раздел.`, `${clean(input)} is in several sections: ${list}. Name the section.`))
  matches.forEach((m, i) => ctx.out(`  ${i + 1}. ${m.section}/${m.slug}  ${clean(m.title)}`))
  const picked = matches[Number(await ctx.prompt(tr(ctx, 'Номер: ', 'Number: '), false)) - 1]
  if (!picked) throw new CliError(64, tr(ctx, 'Запись не выбрана.', 'No entry selected.'))
  return picked
}

export type Installed = { scope: Scope; root: string; lockFile: string; lock: Lock }

/** Lock-файлы, которые смотрят list, doctor, update и remove: проект (если мы в нем) и пользователь. */
export const lockScopes = async (ctx: Ctx, flags: Pick<Flags, 'global' | 'project'>): Promise<Installed[]> => {
  const scopes: Scope[] = flags.global ? ['global'] : flags.project ? ['project'] : (await pickScope(ctx, {})) === 'project' ? ['project', 'global'] : ['global']
  const out: Installed[] = []
  for (const scope of scopes) {
    const root = await rootFor(ctx, scope)
    const lockFile = lockFileFor(ctx, scope, root)
    out.push({ scope, root, lockFile, lock: await readLock(lockFile, scope) })
  }
  return out
}

export const findInstalled = async (ctx: Ctx, input: string, flags: Pick<Flags, 'global' | 'project'>): Promise<Installed & { key: string }> => {
  for (const s of await lockScopes(ctx, flags)) {
    const keys = Object.keys(s.lock.entries)
    const key = keys.includes(input) ? input : keys.filter((k) => k.endsWith(`/${input}`)).length === 1 ? keys.find((k) => k.endsWith(`/${input}`)) : undefined
    if (key) return { ...s, key }
  }
  throw new CliError(64, tr(ctx, `Запись не установлена: ${clean(input)}. Список: npx skillfoxx list`, `Not installed: ${clean(input)}. List: npx skillfoxx list`))
}
