import type { Flags } from './cli'
import { tr, type Ctx } from './context'
import { clean, confirm } from './io'
import type { Action } from './plan'
import type { InstallRecipe } from './shared'

/**
 * Раскрытия рецепта в CLI: что инструмент отправляет автору и переменная, которая это отключает. Строки
 * печатаются в плане до подтверждения; переменную CLI добавляет в env сервера в конфиге агента, если
 * пользователь согласен (по умолчанию да, с -y тоже да, --allow-telemetry оставляет отправку).
 */

export type OptOut = { env: string; value: string; components: string[] }
/** Решение, записанное в lock: off, переменная отключения в конфиге; on, отправка оставлена. */
export type TelemetryChoice = 'off' | 'on'

export const disclosureLines = (ctx: Pick<Ctx, 'lang'>, recipe: InstallRecipe): string[] =>
  (recipe.disclosures ?? []).flatMap((d) => {
    const text = clean(ctx.lang === 'ru' ? d.text.ru : d.text.en)
    const lines = [tr(ctx, `Что отправляет автору: ${text}`, `What it sends to the author: ${text}`)]
    if (d.optOut) lines.push(tr(ctx, `  Отключается переменной ${d.optOut.env}=${d.optOut.value}.`, `  Turned off with ${d.optOut.env}=${d.optOut.value}.`))
    return lines
  })

/**
 * Переменные отключения, которые CLI может записать сам: только у локальных MCP-серверов (mcp-stdio), для
 * которых план пишет конфиг агента. У удаленного сервера env конфига не доходит до процесса автора.
 */
export const optOuts = (recipe: InstallRecipe, actions: Action[]): OptOut[] => {
  const written = new Set(actions.flatMap((a) => (a.type === 'mcp' && a.component.kind === 'mcp-stdio' ? [a.component.name] : [])))
  const out: OptOut[] = []
  for (const d of recipe.disclosures ?? []) {
    if (!d.optOut) continue
    const components = [...written].filter((name) => d.component === undefined || d.component === name)
    if (components.length) out.push({ env: d.optOut.env, value: d.optOut.value, components })
  }
  return out
}

/**
 * Рецепт с переменными отключения в env серверов: несекретная переменная с фиксированным значением, как
 * NPM_CONFIG_IGNORE_SCRIPTS=true. Объявленная автором переменная с тем же именем заменяется.
 */
export const withOptOut = (recipe: InstallRecipe, list: OptOut[]): InstallRecipe => {
  if (!list.length) return recipe
  return {
    ...recipe,
    components: recipe.components.map((c) => {
      if (c.kind !== 'mcp-stdio') return c
      const mine = list.filter((o) => o.components.includes(c.name))
      if (!mine.length) return c
      const names = new Set(mine.map((o) => o.env))
      const added = mine.map((o) => ({ name: o.env, required: false, secret: false, description: 'telemetry off', value: o.value }))
      return { ...c, env: [...c.env.filter((e) => !names.has(e.name)), ...added] }
    }),
  }
}

/**
 * Выбор по телеметрии для add и update. Прошлый выбор из lock повторяется без вопроса; --allow-telemetry
 * оставляет отправку; -y отключает ее; в терминале CLI спрашивает (по умолчанию отключить).
 */
export const chooseTelemetry = async (
  ctx: Ctx,
  list: OptOut[],
  flags: Pick<Flags, 'yes' | 'allowTelemetry'>,
  previous?: TelemetryChoice,
): Promise<TelemetryChoice | undefined> => {
  if (!list.length) return undefined
  if (flags.allowTelemetry) return 'on'
  if (previous) return previous
  const pairs = [...new Set(list.map((o) => `${o.env}=${o.value}`))].join(', ')
  if (flags.yes) {
    ctx.out(tr(ctx, `CLI добавит ${pairs} в конфиг сервера и отключит отправку. Оставить ее: --allow-telemetry`, `The CLI adds ${pairs} to the server config to turn sending off. Keep it on: --allow-telemetry`))
    return 'off'
  }
  return (await confirm(ctx, tr(ctx, `Добавить ${pairs} в конфиг сервера, чтобы отключить отправку?`, `Add ${pairs} to the server config to turn sending off?`), true)) ? 'off' : 'on'
}
