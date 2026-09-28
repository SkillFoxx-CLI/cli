// Единственная точка, через которую CLI берет код сайта (граница: tests/cli/boundary.test.ts). Здесь же
// генератор этапа 2 сводится к контракту CLI (спецификация этапа 3, раздел 3): значения вместо плейсхолдеров
// карточки и объекты Codex, Goose и Amp, которых нет в генераторе карточек.
import { serverObject, type McpComponent, type Resolved } from './recipe/agents/mcp'
import { agentById } from './recipe/agents/registry'
import { AGENT_IDS as SITE_AGENT_IDS, type AgentId as SiteAgentId } from './recipe/agents/types'

export { canonicalHash, canonicalJSON, parseRecipe, sortKeys, SYSTEM_VARS, templateVars } from './recipe/schema'
export type { EnvVar, InstallRecipe, RecipeComponent } from './recipe/schema'
export { contentDigest, inSkillDir, isRootSkill, skillFiles, type TreeBlob } from './recipe/digest'
export type { RecipeResponseBody } from './recipe/response'
export { SIGNATURE_HEADER, keyId, verifyBody } from './recipe/sign'
export { TRUSTED_RECIPE_KEYS } from './recipe/keys'
export type { McpComponent, Resolved }

/** Агенты CLI: все агенты карточек плюс Goose и Amp, у которых нет вкладки на карточке. */
export const AGENT_IDS = [...SITE_AGENT_IDS, 'goose', 'amp'] as const
export type AgentId = SiteAgentId | 'goose' | 'amp'

type Resolve = (name: string) => string
const TEMPLATE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const fill = (text: string, resolve: Resolve) => text.replace(TEMPLATE, (_, n: string) => resolve(n))
// Как в генераторе этапа 2 (agents/mcp.ts), чтобы карточка и CLI писали одну и ту же команду.
const RUNTIME_COMMAND = { npx: 'npx', uvx: 'uvx', docker: 'docker', node: 'node', python: 'python' } as const

/** Компонент с подставленными значениями: у генератора карточек на этих местах плейсхолдеры. */
export const resolveWith = (c: McpComponent, resolve: Resolve): Resolved => {
  if (c.kind === 'mcp-stdio') {
    const args = c.args.map((a) => fill(a, resolve))
    const command = c.runtime === 'binary' ? (args.shift() ?? c.name) : RUNTIME_COMMAND[c.runtime]
    return { kind: 'stdio', name: c.name, command, args, env: Object.fromEntries(c.env.map((e) => [e.name, e.value ?? resolve(e.name)])) }
  }
  return { kind: 'http', name: c.name, sse: c.transport === 'sse', url: fill(c.url, resolve), headers: Object.fromEntries(c.headers.map((h) => [h.name, fill(h.value, resolve)])) }
}

const optional = (key: string, table: Record<string, string>) => (Object.keys(table).length ? { [key]: table } : {})

// Codex: TOML-таблица [mcp_servers.<имя>] (этап 2 печатает ее строкой). Goose: YAML extensions.<имя>. Amp: JSON amp.mcpServers.
const cliOnly = (agent: 'codex' | 'goose' | 'amp', r: Resolved): Record<string, unknown> | null => {
  if (agent === 'codex') {
    if (r.kind === 'stdio') return { command: r.command, args: r.args, ...optional('env', r.env) }
    return r.sse ? null : { url: r.url, ...optional('http_headers', r.headers) }
  }
  if (agent === 'goose') {
    if (r.kind === 'stdio') return { name: r.name, type: 'stdio', cmd: r.command, args: r.args, ...optional('envs', r.env), enabled: true, timeout: 300 }
    return r.sse ? null : { name: r.name, type: 'streamable_http', uri: r.url, ...optional('headers', r.headers), enabled: true, timeout: 300 }
  }
  return r.kind === 'stdio' ? { command: r.command, args: r.args, ...optional('env', r.env) } : { url: r.url, ...optional('headers', r.headers) }
}

/** Объект сервера MCP в формате агента; null: сочетание агента и транспорта не подтверждено. */
export const serverEntry = (agent: AgentId, c: McpComponent, resolve: Resolve): Record<string, unknown> | null => {
  const r = resolveWith(c, resolve)
  if (agent === 'codex' || agent === 'goose' || agent === 'amp') return cliOnly(agent, r)
  const spec = agentById(agent)
  if (!spec?.mcp) return null
  const supported = r.kind === 'stdio' ? spec.mcp.stdio : r.sse ? spec.mcp.sse : spec.mcp.http
  return supported ? serverObject(agent, r) : null
}

/** Ссылка на переменную окружения в синтаксисе агента; null, если поддержка не подтверждена документацией. */
export const envReference = (agent: AgentId, name: string): string | null => {
  switch (agent) {
    case 'claude-code':
    case 'gemini-cli':
      return `\${${name}}`
    case 'cursor':
    case 'vscode':
    case 'zoo-code':
      return `\${env:${name}}`
    case 'opencode':
      return `{env:${name}}`
    default:
      return null
  }
}

/** Проектная папка скиллов агента: из реестра этапа 2, для Goose и Amp общая .agents/skills. */
export const siteSkillsDir = (agent: AgentId): string | null =>
  agent === 'goose' || agent === 'amp' ? '.agents/skills' : (agentById(agent)?.skillsDir ?? null)
