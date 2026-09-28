import path from 'node:path'

import { agentDef, mcpTarget, type Scope } from './agents'
import type { Target } from './config-file'
import { tr, type Ctx } from './context'
import { clean } from './io'
import { serverEntry, templateVars, type AgentId, type InstallRecipe, type McpComponent, type RecipeComponent } from './shared'

type Of<K extends RecipeComponent['kind']> = Extract<RecipeComponent, { kind: K }>
export type SkillComponent = Of<'skill'>
export type PluginComponent = Of<'plugin'>
export type CliComponent = Of<'cli'>
type Reason = { ru: string; en: string }

export type Action =
  | { type: 'skill'; component: SkillComponent }
  | { type: 'mcp'; agent: AgentId; component: McpComponent; target: Target }
  | { type: 'plugin'; component: PluginComponent }
  | { type: 'cli'; component: CliComponent }
  | { type: 'manual'; agent: AgentId | null; component: RecipeComponent; reason: Reason }

export const componentName = (c: RecipeComponent): string =>
  c.kind === 'plugin' ? c.plugin : c.kind === 'cli' ? c.package : c.kind === 'rules' ? c.path : c.name

const PACKAGE: Record<CliComponent['ecosystem'], RegExp> = {
  npm: /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*(@[A-Za-z0-9._^~<>=|-]+)?$/,
  pip: /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?(==[A-Za-z0-9.*+!-]+)?$/,
  brew: /^[a-z0-9][a-z0-9@+._/-]*$/,
  cargo: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  go: /^[a-z0-9][a-z0-9.-]*(\/[A-Za-z0-9._~-]+)+(@[A-Za-z0-9._+-]+)?$/,
}

/** Имя пакета проходит шаблон своей экосистемы: без ведущего дефиса, пробелов и прочего, что execFile принял бы за флаг. */
export const validPackage = (ecosystem: string, pkg: unknown): boolean =>
  Object.hasOwn(PACKAGE, ecosystem) && typeof pkg === 'string' && PACKAGE[ecosystem as CliComponent['ecosystem']].test(pkg)

export const ecosystemCommand = (c: CliComponent): [string, string[]] | null => {
  if (!validPackage(c.ecosystem, c.package)) return null
  switch (c.ecosystem) {
    case 'npm':
      return ['npm', ['install', '--global', c.package]]
    case 'pip':
      return ['pipx', ['install', c.package]]
    case 'brew':
      return ['brew', ['install', c.package]]
    case 'cargo':
      return ['cargo', ['install', '--locked', c.package]]
    case 'go':
      return ['go', ['install', c.package.includes('@') ? c.package : `${c.package}@latest`]]
  }
}

/** Команда удаления по lock-файлу: имя пакета из lock проверяется заново, lock мог прийти с чужим коммитом. */
export const uninstallCommand = (ecosystem: string, pkg: string): [string, string[]] | null => {
  if (!validPackage(ecosystem, pkg)) return null
  if (ecosystem === 'npm') return ['npm', ['uninstall', '--global', pkg.replace(/^(@?[^@]+)@.*$/, '$1')]]
  if (ecosystem === 'pip') return ['pipx', ['uninstall', pkg.replace(/\[.*$|[=<>!~].*$/, '')]]
  if (ecosystem === 'brew') return ['brew', ['uninstall', pkg]]
  if (ecosystem === 'cargo') return ['cargo', ['uninstall', pkg]]
  return null
}

export const SERVER_NAME = /^[A-Za-z0-9._-]{1,64}$/

export const buildPlan = async (ctx: Ctx, recipe: InstallRecipe, agents: AgentId[], scope: Scope, root: string): Promise<Action[]> => {
  const actions: Action[] = []
  const tail: Action[] = []
  for (const c of recipe.components) {
    if (c.kind === 'skill') actions.push({ type: 'skill', component: c })
    else if (c.kind === 'rules') actions.push({ type: 'manual', agent: null, component: c, reason: { ru: 'правила проекта ставятся вручную из файла в репозитории', en: 'project rules are added by hand from the repository file' } })
    else if (c.kind === 'plugin') actions.push({ type: 'plugin', component: c })
    else if (c.kind === 'cli') {
      if (ctx.platform === 'win32') tail.push({ type: 'manual', agent: null, component: c, reason: { ru: 'на Windows команду экосистемы выполните сами', en: 'on Windows run the ecosystem command yourself' } })
      else if (!ecosystemCommand(c)) tail.push({ type: 'manual', agent: null, component: c, reason: { ru: 'имя пакета не прошло проверку', en: 'the package name failed validation' } })
      else tail.push({ type: 'cli', component: c })
    } else {
      for (const agent of agents) {
        const target = await mcpTarget(ctx, agentDef(agent), scope, root, c.name)
        if (!target) {
          const reason = scope === 'project' ? { ru: 'агент не поддерживает запись в проект, попробуйте --global', en: 'the agent has no project config, try --global' } : { ru: 'пользовательский конфиг агента не подтвержден', en: 'the user config of this agent is not confirmed' }
          actions.push({ type: 'manual', agent, component: c, reason })
        } else if (!SERVER_NAME.test(c.name)) actions.push({ type: 'manual', agent, component: c, reason: { ru: 'недопустимое имя сервера', en: 'invalid server name' } })
        else if (serverEntry(agent, c, (n) => `\${${n}}`) === null) actions.push({ type: 'manual', agent, component: c, reason: { ru: 'этот транспорт у агента не подтвержден', en: 'this transport is not confirmed for the agent' } })
        else actions.push({ type: 'mcp', agent, component: c, target })
      }
    }
  }
  return [...actions, ...tail]
}

const shown = (ctx: Ctx, root: string, file: string) => {
  const rel = path.relative(root, file)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel
  const home = path.relative(ctx.home, file)
  return !home.startsWith('..') && !path.isAbsolute(home) ? `~/${home}` : file
}

export const describePlan = (ctx: Ctx, actions: Action[], root: string): string[] =>
  actions.map((a) => {
    switch (a.type) {
      case 'skill':
        return tr(ctx, `скилл ${clean(a.component.name)}: папка .agents/skills и папки агентов`, `skill ${clean(a.component.name)}: .agents/skills and agent folders`)
      case 'mcp':
        return `${agentDef(a.agent).title}: ${shown(ctx, root, a.target.file)}, ${tr(ctx, 'ключ', 'key')} ${a.target.key.join(' > ')}`
      case 'plugin':
        return tr(ctx, `Claude Code: плагин ${clean(a.component.plugin)}, команды для установки будут напечатаны`, `Claude Code: plugin ${clean(a.component.plugin)}, install commands will be printed`)
      case 'cli': {
        const [cmd, args] = ecosystemCommand(a.component)!
        return tr(ctx, `команда: ${cmd} ${args.join(' ')}`, `command: ${cmd} ${args.join(' ')}`)
      }
      case 'manual':
        return `${a.agent ? agentDef(a.agent).title : tr(ctx, 'вручную', 'by hand')}: ${clean(componentName(a.component))}, ${tr(ctx, a.reason.ru, a.reason.en)}`
    }
  })

export const planJson = (actions: Action[], root: string): unknown[] =>
  actions.map((a) =>
    a.type === 'mcp'
      ? { type: a.type, agent: a.agent, component: a.component.name, file: path.relative(root, a.target.file), key: a.target.key }
      : { type: a.type, agent: 'agent' in a ? a.agent : null, component: componentName(a.component), ...(a.type === 'manual' ? { reason: a.reason.en } : {}) },
  )

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

/** Адрес на этой же машине: явный локальный хост или порт без DNS-имени, вроде dev-сервера для отладки. */
const isLocalHost = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/**
 * Предупреждение по одному лишь рецепту, без попытки установки: http-сервер не на этой машине, у него
 * заявлен секретный заголовок (авторизация), а переменная для него сейчас не задана в окружении. Значит
 * сервер либо не поставится (нет значения для подстановки), либо, если переменную все же найдут позже,
 * запрос до этого момента уйдет без авторизации. Для stdio-серверов формат env не позволяет так же
 * однозначно судить об авторизации, поэтому они не проверяются.
 */
export const remoteAuthWarnings = (ctx: Pick<Ctx, 'lang' | 'env'>, recipe: InstallRecipe): string[] => {
  const warnings: string[] = []
  for (const c of recipe.components) {
    if (c.kind !== 'mcp-http' || isLocalHost(c.url)) continue
    const authVars = new Set(c.headers.filter((h) => h.secret).flatMap((h) => templateVars(h.value)))
    const missing = [...authVars].filter((name) => !ctx.env[name])
    if (missing.length) {
      warnings.push(
        tr(
          ctx,
          `${clean(c.name)}: сервер ${clean(c.url)} будет вызван без авторизации, пока не задана переменная окружения ${missing.join(', ')}.`,
          `${clean(c.name)}: the server ${clean(c.url)} will be called without authorization until the environment variable ${missing.join(', ')} is set.`,
        ),
      )
    }
  }
  return warnings
}

/** Инструкция для ручной установки: готовый фрагмент конфига с плейсхолдерами, без значений секретов. */
export const manualNote = (ctx: Ctx, action: Extract<Action, { type: 'manual' }>, entryUrl: string): string => {
  const c = action.component
  const who = action.agent ? agentDef(action.agent).title : tr(ctx, 'Вручную', 'By hand')
  const reason = tr(ctx, action.reason.ru, action.reason.en)
  if ((c.kind === 'mcp-stdio' || c.kind === 'mcp-http') && action.agent) {
    const snippet = serverEntry(action.agent, c, (n) => `\${${n}}`)
    if (snippet) return `${who}: ${reason}. ${tr(ctx, 'Добавьте в конфиг агента', 'Add to the agent config')} "${c.name}": ${JSON.stringify(snippet)}`
  }
  if (c.kind === 'cli') {
    const cmd = ecosystemCommand(c)
    if (cmd) return `${who}: ${reason}. ${cmd[0]} ${cmd[1].join(' ')}`
  }
  return `${who}: ${clean(componentName(c))}, ${reason}. ${tr(ctx, 'Инструкция', 'Instructions')}: ${entryUrl}`
}
