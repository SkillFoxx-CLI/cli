import type { RecipeComponent } from '../schema'
import { cursorDeeplink, vscodeDeeplink } from './deeplinks'
import type { AgentSpec } from './registry'
import { prettyJson, shellJoin, tomlInlineTable, tomlKey, tomlString } from './shell'
import { TEXTS } from './texts'
import type { AgentId, Deeplink, Lang, Step } from './types'
import { envTable, fillTemplate } from './vars'

export type McpComponent = Extract<RecipeComponent, { kind: 'mcp-stdio' | 'mcp-http' }>

export type ResolvedStdio = { kind: 'stdio'; name: string; command: string; args: string[]; env: Record<string, string> }
export type ResolvedHttp = { kind: 'http'; name: string; sse: boolean; url: string; headers: Record<string, string> }
export type Resolved = ResolvedStdio | ResolvedHttp

const RUNTIME_COMMAND = { npx: 'npx', uvx: 'uvx', docker: 'docker', node: 'node', python: 'python' } as const

/** Компонент рецепта с подставленными плейсхолдерами: общая основа всех форматов. */
export const resolveMcp = (c: McpComponent, lang: Lang): Resolved => {
  if (c.kind === 'mcp-stdio') {
    const args = c.args.map((arg) => fillTemplate(arg, c.env, lang))
    // У binary исполняемый файл первым аргументом.
    const command = c.runtime === 'binary' ? (args.shift() ?? c.name) : RUNTIME_COMMAND[c.runtime]
    return { kind: 'stdio', name: c.name, command, args, env: envTable(c.env, lang) }
  }
  return {
    kind: 'http',
    name: c.name,
    sse: c.transport === 'sse',
    url: fillTemplate(c.url, c.env, lang),
    headers: Object.fromEntries(c.headers.map((h) => [h.name, fillTemplate(h.value, c.env, lang)])),
  }
}

const optional = (key: string, table: Record<string, string>): Record<string, Record<string, string>> => (Object.keys(table).length ? { [key]: table } : {})

type Format = {
  path: string
  scope: 'project' | 'user'
  key: string
  stdio: (s: ResolvedStdio) => Record<string, unknown>
  http?: (h: ResolvedHttp) => Record<string, unknown>
}

const plain = (s: ResolvedStdio) => ({ command: s.command, args: s.args, ...optional('env', s.env) })

// Форматы по docs/research/installer/agent-configs.md и сверке задачи 1 плана этапа 2.
const FORMATS: Partial<Record<AgentId, Format>> = {
  'claude-code': { path: '.mcp.json', scope: 'project', key: 'mcpServers', stdio: plain, http: (h) => ({ type: h.sse ? 'sse' : 'http', url: h.url, ...optional('headers', h.headers) }) },
  cursor: { path: '~/.cursor/mcp.json', scope: 'user', key: 'mcpServers', stdio: plain, http: (h) => ({ url: h.url, ...optional('headers', h.headers) }) },
  vscode: {
    path: '.vscode/mcp.json',
    scope: 'project',
    key: 'servers',
    stdio: (s) => ({ type: 'stdio', ...plain(s) }),
    http: (h) => ({ type: h.sse ? 'sse' : 'http', url: h.url, ...optional('headers', h.headers) }),
  },
  'gemini-cli': { path: '~/.gemini/settings.json', scope: 'user', key: 'mcpServers', stdio: plain, http: (h) => ({ [h.sse ? 'url' : 'httpUrl']: h.url, ...optional('headers', h.headers) }) },
  devin: { path: '~/.config/devin/mcp_config.json', scope: 'user', key: 'mcpServers', stdio: plain, http: (h) => ({ serverUrl: h.url, ...optional('headers', h.headers) }) },
  cline: { path: 'cline_mcp_settings.json', scope: 'user', key: 'mcpServers', stdio: plain, http: (h) => ({ type: h.sse ? 'sse' : 'streamableHttp', url: h.url, ...optional('headers', h.headers) }) },
  'zoo-code': { path: '.roo/mcp.json', scope: 'project', key: 'mcpServers', stdio: plain, http: (h) => ({ type: h.sse ? 'sse' : 'streamable-http', url: h.url, ...optional('headers', h.headers) }) },
  opencode: {
    path: 'opencode.json',
    scope: 'project',
    key: 'mcp',
    stdio: (s) => ({ type: 'local', command: [s.command, ...s.args], ...optional('environment', s.env) }),
    http: (h) => ({ type: 'remote', url: h.url, ...optional('headers', h.headers) }),
  },
  zed: { path: '~/.config/zed/settings.json', scope: 'user', key: 'context_servers', stdio: plain, http: (h) => ({ url: h.url, ...optional('headers', h.headers) }) },
  sourcecraft: { path: '.codeassistant/mcp.json', scope: 'project', key: 'mcpServers', stdio: plain },
}

/** Объект сервера в формате агента (без обертки ключом и именем); его же берут ссылки установки. */
export const serverObject = (agent: AgentId, r: Resolved): Record<string, unknown> | null => {
  const format = FORMATS[agent]
  if (!format) return null
  return r.kind === 'stdio' ? format.stdio(r) : (format.http?.(r) ?? null)
}

const codexToml = (r: Resolved): string => {
  const lines = [`[mcp_servers.${tomlKey(r.name)}]`]
  if (r.kind === 'stdio') {
    lines.push(`command = ${tomlString(r.command)}`, `args = [${r.args.map(tomlString).join(', ')}]`)
    if (Object.keys(r.env).length) lines.push(`env = ${tomlInlineTable(r.env)}`)
  } else {
    lines.push(`url = ${tomlString(r.url)}`)
    if (Object.keys(r.headers).length) lines.push(`http_headers = ${tomlInlineTable(r.headers)}`)
  }
  return lines.join('\n')
}

const envFlags = (flag: string, env: Record<string, string>) => Object.entries(env).flatMap(([key, value]) => [flag, `${key}=${value}`])
const headerFlags = (flag: string, headers: Record<string, string>) => Object.entries(headers).flatMap(([key, value]) => [flag, `${key}: ${value}`])
const hasHeaders = (r: ResolvedHttp) => Object.keys(r.headers).length > 0

/** Команда добавления сервера; null, если у агента ее нет или она ненадежна для этого сервера. */
const command = (agent: AgentId, r: Resolved): string | null => {
  switch (agent) {
    case 'claude-code':
      return r.kind === 'stdio'
        ? shellJoin(['claude', 'mcp', 'add', '--transport', 'stdio', ...envFlags('--env', r.env), r.name, '--', r.command, ...r.args])
        // сверено 2026-09-24 (docs/task-1-report): --header у claude mcp add в официальной
        // документации идет после url/имени сервера у http и sse, а не перед именем.
        : shellJoin(['claude', 'mcp', 'add', '--transport', r.sse ? 'sse' : 'http', r.name, r.url, ...headerFlags('--header', r.headers)])
    case 'codex':
      if (r.kind === 'stdio') return shellJoin(['codex', 'mcp', 'add', r.name, ...envFlags('--env', r.env), '--', r.command, ...r.args])
      return hasHeaders(r) ? null : shellJoin(['codex', 'mcp', 'add', r.name, '--url', r.url])
    case 'gemini-cli':
      // Аргументы с дефисом парсер gemini забирает себе как флаги: тогда только файл.
      if (r.kind === 'stdio') return r.args.some((arg) => arg.startsWith('-')) ? null : shellJoin(['gemini', 'mcp', 'add', '-s', 'user', ...envFlags('-e', r.env), r.name, r.command, ...r.args])
      return hasHeaders(r) ? null : shellJoin(['gemini', 'mcp', 'add', '-s', 'user', '-t', r.sse ? 'sse' : 'http', r.name, r.url])
    case 'vscode': {
      const server = serverObject('vscode', r)
      return server ? shellJoin(['code', '--add-mcp', JSON.stringify({ name: r.name, ...server })]) : null
    }
    default:
      return null
  }
}

const supported = (agent: AgentSpec, r: Resolved): boolean => {
  if (!agent.mcp) return false
  if (r.kind === 'stdio') return agent.mcp.stdio
  return r.sse ? agent.mcp.sse : agent.mcp.http
}

/**
 * allowDeeplinks: хук для уровня страницы (задачи 6/7), где известен риск записи из каталога, а этот модуль
 * его не видит. При риске high страница передает false, чтобы остались только шаги копирования конфига.
 */
export const mcpSteps = (c: McpComponent, agent: AgentSpec, lang: Lang, allowDeeplinks = true): { steps: Step[]; deeplinks: Deeplink[] } | null => {
  const t = TEXTS[lang]
  const r = resolveMcp(c, lang)
  if (!supported(agent, r)) return null
  const extra = t.mcpNote[agent.id]
  let file: Step
  if (agent.id === 'codex') {
    file = { role: 'main', kind: 'file', title: t.addToFile, path: '~/.codex/config.toml', scope: 'user', lang: 'toml', code: codexToml(r), note: t.fileMergeToml }
  } else {
    const format = FORMATS[agent.id]
    const server = serverObject(agent.id, r)
    if (!format || !server) return null
    file = {
      role: 'main',
      kind: 'file',
      title: t.addToFile,
      path: format.path,
      scope: format.scope,
      lang: 'json',
      code: prettyJson({ [format.key]: { [r.name]: server } }),
      note: extra ? `${t.fileMerge(format.key)} ${extra}` : t.fileMerge(format.key),
    }
  }
  const cmd = command(agent.id, r)
  const steps: Step[] = cmd
    ? [{ role: 'main', kind: 'command', where: 'terminal', title: t.runInTerminal, lang: 'shell', code: cmd }, { ...file, role: 'or', title: t.orFile }]
    : [file]
  const deeplinks: Deeplink[] = []
  if (allowDeeplinks && (agent.id === 'cursor' || agent.id === 'vscode')) {
    const server = serverObject(agent.id, r)
    if (server) deeplinks.push({ target: agent.id, server: r.name, href: agent.id === 'cursor' ? cursorDeeplink(r.name, server) : vscodeDeeplink(r.name, server) })
  }
  return { steps, deeplinks }
}
