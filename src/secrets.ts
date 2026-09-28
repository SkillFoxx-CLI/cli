import os from 'node:os'

import type { Scope } from './agents'
import { CliError, tr, type Ctx } from './context'
import { clean } from './io'
import { envReference, SYSTEM_VARS, templateVars, type AgentId, type EnvVar, type McpComponent } from './shared'

/**
 * Значения переменных для записи конфигов. Порядок: значение из прошлой установки, окружение, вопрос в TTY.
 * В проектной области секреты не нужны вовсе: в файл проекта пишется только ссылка на переменную.
 */
export const collectValues = async (ctx: Ctx, components: McpComponent[], p: { needSecrets: boolean; known?: Map<string, string> }): Promise<Map<string, string>> => {
  const values = new Map<string, string>()
  const vars = new Map<string, EnvVar>()
  for (const c of components) for (const e of c.env) if (!vars.has(e.name)) vars.set(e.name, e)
  for (const e of vars.values()) {
    if (e.value !== undefined) continue
    if (e.secret && !p.needSecrets) continue
    const known = p.known?.get(e.name) ?? ctx.env[e.name]
    if (known) {
      values.set(e.name, known)
      continue
    }
    if (!ctx.tty) {
      if (e.required) throw new CliError(64, tr(ctx, `Задайте переменную окружения ${e.name} (${clean(e.description)}) и повторите.`, `Set the environment variable ${e.name} (${clean(e.description)}) and retry.`))
      continue
    }
    const answer = await ctx.prompt(`${e.name} (${clean(e.description)})${e.required ? '' : tr(ctx, ', можно пропустить', ', optional')}: `, e.secret)
    if (answer) values.set(e.name, answer)
    else if (e.required) throw new CliError(64, tr(ctx, `Переменная ${e.name} обязательна.`, `${e.name} is required.`))
  }
  return values
}

export type Resolver =
  | { ok: true; component: McpComponent; resolve: (n: string) => string; mask: (n: string) => string; secrets: string[]; references: string[] }
  | { ok: false; reason: { ru: string; en: string } }

const systemValue = (ctx: Ctx, name: string): string =>
  name === 'HOME' ? ctx.home : name === 'PWD' ? ctx.cwd : name === 'TMPDIR' ? (ctx.env.TMPDIR ?? os.tmpdir()) : (ctx.env[name] ?? '')

export const resolverFor = (ctx: Ctx, agent: AgentId, scope: Scope, component: McpComponent, values: Map<string, string>): Resolver => {
  const declared = new Map(component.env.map((e) => [e.name, e]))
  const keep = component.env.filter((e) => e.value !== undefined || values.has(e.name) || (scope === 'project' && e.secret && (e.required || ctx.env[e.name])))
  const kept = new Set(keep.map((e) => e.name))
  const templated =
    component.kind === 'mcp-stdio' ? component.args.flatMap(templateVars) : [...templateVars(component.url), ...component.headers.flatMap((h) => templateVars(h.value))]
  for (const name of templated) {
    // Проектный файл коммитится: путь HOME, PWD, TMPDIR или имя пользователя этой машины в него не пишется.
    // Агент без ссылок на переменные окружения получает инструкцию вместо записи.
    if (SYSTEM_VARS.has(name) && scope === 'project' && !envReference(agent, name)) {
      return { ok: false, reason: { ru: `агент не понимает ссылки на переменные окружения, а значение ${name} этой машины нельзя писать в файл проекта. Поставьте с --global или добавьте вручную`, en: `the agent does not support environment variable references and the local value of ${name} must not go into a project file. Use --global or add it by hand` } }
    }
    if (SYSTEM_VARS.has(name) || kept.has(name)) continue
    return { ok: false, reason: { ru: `нет значения ${name}, задайте переменную окружения и повторите`, en: `no value for ${name}, set the environment variable and retry` } }
  }
  const references: string[] = []
  if (scope === 'project') {
    for (const e of keep) {
      if (!e.secret) continue
      if (!envReference(agent, e.name)) {
        return { ok: false, reason: { ru: `агент не понимает ссылки на переменные окружения, а секрет ${e.name} нельзя писать в файл проекта. Поставьте с --global или добавьте вручную`, en: `the agent does not support environment variable references and secret ${e.name} must not go into a project file. Use --global or add it by hand` } }
      }
      references.push(e.name)
    }
  }
  const resolve = (n: string): string => {
    if (SYSTEM_VARS.has(n)) return envReference(agent, n) ?? systemValue(ctx, n)
    const e = declared.get(n)
    if (e?.value !== undefined) return e.value
    if (e?.secret && scope === 'project') return envReference(agent, n) as string
    return values.get(n) ?? ''
  }
  const mask = (n: string): string => (declared.get(n)?.secret && scope === 'global' ? `\${${n}}` : resolve(n))
  const secrets = scope === 'global' ? keep.filter((e) => e.secret).map((e) => e.name) : []
  return { ok: true, component: { ...component, env: keep } as McpComponent, resolve, mask, secrets, references }
}
