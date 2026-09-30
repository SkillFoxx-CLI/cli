import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { Ctx } from './context'
import type { AgentId } from './shared'

export type Scope = 'project' | 'global'
// yaml-1.1: YAML, который агент читает по версии 1.1 (PyYAML у Hermes), см. config-file.ts.
export type Format = 'json' | 'jsonc' | 'toml' | 'yaml' | 'yaml-1.1'
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
 * проекта; пользовательские начинаются с ~/, {claude}, {codex}, {vscode} или {hermes}. null: запись не
 * подтверждена, CLI печатает инструкцию.
 *
 * Hermes Agent (сверка с NousResearch/hermes-agent 30.09.2026): конфига MCP в проекте нет, только
 * {hermes}/config.yaml. Скиллы проекта он читает из .agents/skills и .hermes/skills, но только после
 * hermes skills trust; CLI кладет их в общую .agents/skills, чтобы Hermes не видел два экземпляра.
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
  { id: 'hermes', title: 'Hermes Agent', mcp: { project: null, global: { file: '{hermes}/config.yaml', format: 'yaml-1.1', key: 'mcp_servers' } }, skills: { project: '.agents/skills', global: '{hermes}/skills' }, detect: { paths: ['{hermes}'], bins: ['hermes'] } },
  { id: 'coddy', title: 'Coddy', mcp: { project: null, global: null }, skills: { project: '.agents/skills', global: '~/.agents/skills' }, detect: { paths: ['~/.coddy'], bins: ['coddy'] } },
]

export const agentDef = (id: AgentId): AgentDef => AGENTS.find((a) => a.id === id)!

const vscodeUserDir = (ctx: Pick<Ctx, 'home' | 'env' | 'platform'>): string => {
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library/Application Support/Code/User')
  if (ctx.platform === 'win32') return path.join(ctx.env.APPDATA ?? path.join(ctx.home, 'AppData/Roaming'), 'Code/User')
  return path.join(ctx.env.XDG_CONFIG_HOME ?? path.join(ctx.home, '.config'), 'Code/User')
}

// os.path.expandvars из Python: $ИМЯ и ${ИМЯ} из окружения, неизвестные остаются как написаны; на Windows еще %ИМЯ%.
const expandVars = (ctx: Pick<Ctx, 'env' | 'platform'>, p: string): string => {
  const out = p.replace(/\$(\w+|\{[^}]*\})/g, (whole, name: string) => ctx.env[name.startsWith('{') ? name.slice(1, -1) : name] ?? whole)
  return ctx.platform === 'win32' ? out.replace(/%([^%]+)%/g, (whole, name: string) => ctx.env[name] ?? whole) : out
}

const expandUser = (ctx: Pick<Ctx, 'home' | 'platform'>, p: string): string =>
  p === '~' || p.startsWith('~/') || (ctx.platform === 'win32' && p.startsWith('~\\')) ? path.join(ctx.home, p.slice(1)) : p

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

const insideDir = (base: string, p: string): boolean => {
  const rel = path.relative(base, p)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

// Имя профиля и признаки живого профиля как в hermes_constants (PROFILE_ID_RE, named_profile_is_live).
const HERMES_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const PROFILE_MARKERS = ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db']

const liveProfile = (dir: string): boolean => {
  if (!(statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false)) return false
  if (existsSync(path.join(path.dirname(dir), '.deleted', path.basename(dir)))) return false
  return PROFILE_MARKERS.some((m) => existsSync(path.join(dir, m)) || (lstatSync(path.join(dir, m), { throwIfNoEntry: false })?.isSymbolicLink() ?? false))
}

const activeProfile = (root: string): string | null => {
  try {
    return readFileSync(path.join(root, 'active_profile'), 'utf8').replace(/^\ufeff/, '').trim() || null
  } catch {
    return null
  }
}

/**
 * Папка Hermes Agent, в которой он сам будет читать config.yaml и skills (сверка с hermes_constants и
 * hermes_cli/main.py _apply_profile_override, 30.09.2026):
 * - HERMES_HOME с раскрытием $ИМЯ, ${ИМЯ} и ~ в начале; указывает на <корень>/profiles/<имя>: берется как есть;
 * - иначе корень: HERMES_HOME или ~/.hermes (%LOCALAPPDATA%\hermes на Windows) с суффиксом HERMES_DATA_DIR_SUFFIX;
 * - в корне файл active_profile с именем не default и живой профиль <корень>/profiles/<имя>: папка профиля.
 * Если сохраненного профиля уже нет, Hermes не запустится сам; CLI тогда пишет в корень.
 */
const hermesHome = (ctx: Pick<Ctx, 'home' | 'env' | 'platform'>): string => {
  const raw = ctx.env.HERMES_HOME?.trim()
  const own = raw ? expandUser(ctx, expandVars(ctx, raw)) : null
  if (own && path.basename(path.dirname(own)) === 'profiles') return own
  const suffix = ctx.env.HERMES_DATA_DIR_SUFFIX ?? ''
  const native =
    ctx.platform === 'win32' ? path.join(ctx.env.LOCALAPPDATA?.trim() || path.join(ctx.home, 'AppData/Local'), `hermes${suffix}`) : path.join(ctx.home, `.hermes${suffix}`)
  const home = own ?? native
  // active_profile лежит в корне по умолчанию, если HERMES_HOME внутри него, иначе в самом HERMES_HOME.
  const activeRoot = own && !insideDir(realOrSelf(native), realOrSelf(own)) ? own : native
  const name = activeProfile(activeRoot)?.toLowerCase()
  if (!name || name === 'default' || !HERMES_PROFILE.test(name)) return home
  const dir = path.join(home, 'profiles', name)
  return liveProfile(dir) ? dir : home
}

export const expandGlobal = (ctx: Pick<Ctx, 'home' | 'env' | 'platform'>, p: string): string => {
  const [head, ...rest] = p.split('/')
  const base =
    head === '~' ? ctx.home
    : head === '{claude}' ? (ctx.env.CLAUDE_CONFIG_DIR ?? path.join(ctx.home, '.claude'))
    : head === '{codex}' ? (ctx.env.CODEX_HOME ?? path.join(ctx.home, '.codex'))
    : head === '{vscode}' ? vscodeUserDir(ctx)
    : head === '{hermes}' ? hermesHome(ctx)
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
