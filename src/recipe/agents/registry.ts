import type { AgentId } from './types'

export type McpSupport = { stdio: boolean; http: boolean; sse: boolean }

export type AgentSpec = {
  id: AgentId
  label: string
  siteSlug: string
  mcp: McpSupport | null
  /** Проектная папка скиллов; null: скиллы у агента не подтверждены. */
  skillsDir: string | null
  /** Имя агента для npx skills -a; null: утилита агента не знает, остается git-путь. */
  skillsCli: string | null
  plugin: boolean
  rules: readonly ('agents-md' | 'cursor-mdc')[]
}

const ALL: McpSupport = { stdio: true, http: true, sse: true }

// Источник: docs/research/installer/agent-configs.md (сверка 24.09.2026) и сверка задачи 1 плана этапа 2.
// Порядок строк задает порядок вкладок на карточке.
//
// сверено 2026-09-24: https://raw.githubusercontent.com/vercel-labs/skills/main/src/agents.ts,
// https://github.com/vercel-labs/skills/blob/main/README.md: имена для -a подтверждены буквально
// (claude-code, cursor, github-copilot, codex, gemini-cli, cline, roo, opencode); флаг `-s, --skill <skills...>`
// повторяемый и принимает несколько имен; `-y, --yes` пропускает все подтверждения.
export const AGENTS: readonly AgentSpec[] = [
  // сверено 2026-09-24: https://code.claude.com/docs/en/mcp: claude mcp add поддерживает
  // --transport, --env (перед именем сервера, перед --), --header (после url/имени у http и sse).
  { id: 'claude-code', label: 'Claude Code', siteSlug: 'claude-code', mcp: ALL, skillsDir: '.claude/skills', skillsCli: 'claude-code', plugin: true, rules: ['agents-md'] },
  { id: 'cursor', label: 'Cursor', siteSlug: 'cursor', mcp: ALL, skillsDir: '.agents/skills', skillsCli: 'cursor', plugin: false, rules: ['cursor-mdc'] },
  { id: 'vscode', label: 'VS Code', siteSlug: 'vs-code', mcp: ALL, skillsDir: '.github/skills', skillsCli: 'github-copilot', plugin: false, rules: [] },
  // сверено 2026-09-24: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (редирект с
  // https://developers.openai.com/codex/mcp): [mcp_servers.<имя>] поддерживает http_headers и
  // env_http_headers для streamable http, SSE как транспорт не описан нигде в документации.
  { id: 'codex', label: 'Codex', siteSlug: 'codex', mcp: { stdio: true, http: true, sse: false }, skillsDir: '.agents/skills', skillsCli: 'codex', plugin: false, rules: ['agents-md'] },
  // сверено 2026-09-24: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md:
  // `gemini mcp add [-s user] [-e K=V] <имя> <команда|url> [аргументы]`, `-t http|sse|stdio`, `-H` для заголовков.
  { id: 'gemini-cli', label: 'Gemini CLI', siteSlug: 'gemini-cli', mcp: ALL, skillsDir: '.agents/skills', skillsCli: 'gemini-cli', plugin: false, rules: [] },
  // сверено 2026-09-24: https://docs.devin.ai/desktop/cascade/mcp: удаленный MCP через поле serverUrl
  // (плюс headers), путь конфига ~/.config/devin/mcp_config.json подтвержден.
  { id: 'devin', label: 'Devin Desktop', siteSlug: 'windsurf', mcp: ALL, skillsDir: '.devin/skills', skillsCli: null, plugin: false, rules: ['agents-md'] },
  // сверено 2026-09-24: https://docs.cline.bot/mcp/configuring-mcp-servers: удаленный сервер
  // {"type":"streamableHttp","url","headers"} (легаси {"type":"sse"}); формат подтвержден для http и sse.
  { id: 'cline', label: 'Cline', siteSlug: 'cline', mcp: ALL, skillsDir: '.cline/skills', skillsCli: 'cline', plugin: false, rules: [] },
  // сверено 2026-09-24: https://docs.roocode.com/features/mcp/server-transports,
  // https://docs.zoocode.dev/features/mcp/using-mcp-in-roo: .roo/mcp.json,
  // {"type":"streamable-http"|"sse","url","headers"} подтвержден.
  { id: 'zoo-code', label: 'Zoo Code', siteSlug: 'roo-code', mcp: ALL, skillsDir: '.roo/skills', skillsCli: 'roo', plugin: false, rules: [] },
  // сверено 2026-09-24: https://opencode.ai/docs/mcp-servers: {"type":"local","command":[...],"environment"}
  // и {"type":"remote","url","headers"} подтверждены буквально.
  { id: 'opencode', label: 'OpenCode', siteSlug: 'opencode', mcp: ALL, skillsDir: '.agents/skills', skillsCli: 'opencode', plugin: false, rules: ['agents-md'] },
  // сверено 2026-09-24: https://zed.dev/docs/ai/mcp: context_servers, локальный {command,args,env},
  // удаленный {url,headers} подтверждены; отдельного формата SSE в документации нет, поэтому sse: false.
  { id: 'zed', label: 'Zed', siteSlug: 'zed', mcp: { stdio: true, http: true, sse: false }, skillsDir: '.agents/skills', skillsCli: null, plugin: false, rules: [] },
  // сверено 2026-09-30: sourcecraft.dev, Code Assistant, agent skills: проектные скиллы в .codeassistant/skills
  // (пользовательские ~/.codeassistant/skills), общую .agents/skills агент тоже читает.
  { id: 'sourcecraft', label: 'SourceCraft', siteSlug: 'sourcecraft', mcp: { stdio: true, http: false, sse: false }, skillsDir: '.codeassistant/skills', skillsCli: null, plugin: false, rules: [] },
  // сверено 2026-09-30: github.com/coddy-project/coddy-agent: проектные скиллы только из .coddy/skills,
  // проектную .agents/skills Coddy не читает (пользовательскую ~/.agents/skills читает).
  { id: 'coddy', label: 'Coddy', siteSlug: 'coddy', mcp: null, skillsDir: '.coddy/skills', skillsCli: null, plugin: false, rules: [] },
]

export const agentById = (id: string): AgentSpec | undefined => AGENTS.find((agent) => agent.id === id)
