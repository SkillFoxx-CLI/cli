import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { Ctx } from './context'
import type { AgentId } from './shared'

export type Scope = 'project' | 'global'
export type Format = 'json' | 'jsonc' | 'toml' | 'yaml'
export type McpSpot = { file: string; format: Format; key: string; legacyFile?: string } | null
export type AgentDef = {
  id: AgentId
  title: string
  mcp: Record<Scope, McpSpot>
  skills: Record<Scope, string | null>
  detect: { paths: string[]; bins: string[]; vscodeExt?: string }
}

const json = (file: string, key = 'mcpServers'): McpSpot => ({ file, format: 'json', key })

/**
 * Пути по docs/research/installer/agent-configs.md (сверка 24.09.2026). Проектные пути относительно корня
 * проекта; пользовательские начинаются с ~/, {claude}, {codex} или {vscode}. null: запись не подтверждена,
 * CLI печатает инструкцию.
 */
export const AGENTS: AgentDef[] = [
  { id: 'claude-code', title: 'Claude Code', mcp: { project: json('.mcp.json'), global: json('~/.claude.json') }, skills: { project: '.claude/skills', global: '{claude}/skills' }, detect: { paths: ['~/.claude', '~/.claude.json'], bins: ['claude'] } },
  { id: 'cursor', title: 'Cursor', mcp: { project: json('.cursor/mcp.json'), global: json('~/.cursor/mcp.json') }, skills: { project: '.agents/skills', global: '~/.cursor/skills' }, detect: { paths: ['~/.cursor'], bins: ['cursor-agent'] } },
  { id: 'vscode', title: 'VS Code', mcp: { project: { file: '.vscode/mcp.json', format: 'jsonc', key: 'servers' }, global: { file: '{vscode}/mcp.json', format: 'jsonc', key: 'servers' } }, skills: { project: '.github/skills', global: '~/.copilot/skills' }, detect: { paths: [], bins: ['code'], vscodeExt: 'github.copilot-chat' } },
  { id: 'codex', title: 'Codex CLI', mcp: { project: { file: '.codex/config.toml', format: 'toml', key: 'mcp_servers' }, global: { file: '{codex}/config.toml', format: 'toml', key: 'mcp_servers' } }, skills: { project: '.agents/skills', global: '{codex}/skills' }, detect: { paths: ['~/.codex'], bins: ['codex'] } },
  { id: 'gemini-cli', title: 'Gemini CLI', mcp: { project: json('.gemini/settings.json'), global: json('~/.gemini/settings.json') }, skills: { project: '.agents/skills', global: '~/.gemini/skills' }, detect: { paths: ['~/.gemini'], bins: ['gemini'] } },
  { id: 'devin', title: 'Devin Desktop', mcp: { project: json('.devin/mcp_config.json'), global: { ...json('~/.config/devin/mcp_config.json')!, legacyFile: '~/.codeium/windsurf/mcp_config.json' } }, skills: { project: '.devin/skills', global: '~/.config/devin/skills' }, detect: { paths: ['~/.config/devin', '~/.codeium/windsurf'], bins: [] } },
  { id: 'cline', title: 'Cline', mcp: { project: null, global: json('{vscode}/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json') }, skills: { project: '.cline/skills', global: '~/.cline/skills' }, detect: { paths: ['~/.cline'], bins: ['cline'], vscodeExt: 'saoudrizwan.claude-dev' } },
  { id: 'zoo-code', title: 'Zoo Code', mcp: { project: json('.roo/mcp.json'), global: null }, skills: { project: '.roo/skills', global: '~/.roo/skills' }, detect: { paths: ['~/.roo'], bins: [], vscodeExt: 'zoocodeorganization.zoo-code' } },
  { id: 'opencode', title: 'OpenCode', mcp: { project: json('opencode.json', 'mcp'), global: json('~/.config/opencode/opencode.json', 'mcp') }, skills: { project: '.agents/skills', global: '~/.config/opencode/skills' }, detect: { paths: ['~/.config/opencode'], bins: ['opencode'] } },
  { id: 'zed', title: 'Zed', mcp: { project: { file: '.zed/settings.json', format: 'jsonc', key: 'context_servers' }, global: { file: '~/.config/zed/settings.json', format: 'jsonc', key: 'context_servers' } }, skills: { project: '.agents/skills', global: null }, detect: { paths: ['~/.config/zed'], bins: ['zed'] } },
  { id: 'goose', title: 'Goose', mcp: { project: null, global: { file: '~/.config/goose/config.yaml', format: 'yaml', key: 'extensions' } }, skills: { project: '.agents/skills', global: '~/.agents/skills' }, detect: { paths: ['~/.config/goose'], bins: ['goose'] } },
  { id: 'amp', title: 'Amp', mcp: { project: json('.amp/settings.json', 'amp.mcpServers'), global: json('~/.config/amp/settings.json', 'amp.mcpServers') }, skills: { project: '.agents/skills', global: '~/.agents/skills' }, detect: { paths: ['~/.config/amp'], bins: ['amp'] } },
  { id: 'sourcecraft', title: 'SourceCraft Code Assistant', mcp: { project: json('.codeassistant/mcp.json'), global: null }, skills: { project: null, global: null }, detect: { paths: [], bins: [], vscodeExt: 'yandex-cloud.sourcecraft-code-assist' } },
  { id: 'coddy', title: 'Coddy', mcp: { project: null, global: null }, skills: { project: '.agents/skills', global: '~/.agents/skills' }, detect: { paths: ['~/.coddy'], bins: ['coddy'] } },
]

export const agentDef = (id: AgentId): AgentDef => AGENTS.find((a) => a.id === id)!

const vscodeUserDir = (ctx: Pick<Ctx, 'home' | 'env' | 'platform'>): string => {
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library/Application Support/Code/User')
  if (ctx.platform === 'win32') return path.join(ctx.env.APPDATA ?? path.join(ctx.home, 'AppData/Roaming'), 'Code/User')
  return path.join(ctx.env.XDG_CONFIG_HOME ?? path.join(ctx.home, '.config'), 'Code/User')
}

export const expandGlobal = (ctx: Pick<Ctx, 'home' | 'env' | 'platform'>, p: string): string => {
  const [head, ...rest] = p.split('/')
  const base =
    head === '~' ? ctx.home
    : head === '{claude}' ? (ctx.env.CLAUDE_CONFIG_DIR ?? path.join(ctx.home, '.claude'))
    : head === '{codex}' ? (ctx.env.CODEX_HOME ?? path.join(ctx.home, '.codex'))
    : head === '{vscode}' ? vscodeUserDir(ctx)
    : null
  if (base === null) throw new Error(`путь пользователя без корня: ${p}`)
  return path.join(base, ...rest)
}

const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false

export const mcpTarget = async (ctx: Ctx, def: AgentDef, scope: Scope, root: string, name: string) => {
  const spot = def.mcp[scope]
  if (!spot) return null
  let file = scope === 'project' ? path.join(root, spot.file) : expandGlobal(ctx, spot.file)
  if (scope === 'global' && spot.legacyFile && !(await isDir(path.dirname(file)))) {
    const legacy = expandGlobal(ctx, spot.legacyFile)
    if (await isDir(path.dirname(legacy))) file = legacy
  }
  return { file, format: spot.format, key: [spot.key, name] }
}

export const skillsDir = (ctx: Ctx, def: AgentDef, scope: Scope, root: string): string | null => {
  const dir = def.skills[scope]
  if (!dir) return null
  return scope === 'project' ? path.join(root, dir) : expandGlobal(ctx, dir)
}
