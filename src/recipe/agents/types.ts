/**
 * Шаги установки записи под конкретный агент. Модуль без фреймворка: его же возьмет CLI этапа 3.
 * Спецификация: docs/superpowers/specs/2026-09-24-installer-stage2-design.md.
 */

export const AGENT_IDS = [
  'claude-code',
  'cursor',
  'vscode',
  'codex',
  'gemini-cli',
  'devin',
  'cline',
  'zoo-code',
  'opencode',
  'zed',
  'sourcecraft',
  'coddy',
] as const

export type AgentId = (typeof AGENT_IDS)[number]
/** terminal: рецепт только из CLI, одна вкладка вместо одинаковых по агентам. */
export type PlanTarget = AgentId | 'terminal'
export type Lang = 'ru' | 'en'

const AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS)

// Слаги таксономии агентов сайта (см. registry.ts siteSlug и components/entry/recipe-css.ts), которые
// не совпадают буквально с AgentId: тот же агент, другое написание. gemini добавлен на случай короткого
// имени в запросе MCP-клиента, отдельного siteSlug у него нет — сайт использует только gemini-cli.
const AGENT_ALIASES: Readonly<Record<string, AgentId>> = {
  windsurf: 'devin',
  'roo-code': 'zoo-code',
  'vs-code': 'vscode',
  'github-copilot': 'vscode',
  gemini: 'gemini-cli',
}

/** Слаг агента (id или алиас таксономии сайта) к AgentId инструмента plan_install; неизвестное значение — null. */
export const resolveAgentId = (value: string): AgentId | null => {
  if (AGENT_ID_SET.has(value)) return value as AgentId
  return AGENT_ALIASES[value] ?? null
}

export type Step = {
  /** main: основной шаг; or: альтернатива рядом; fallback: запасной путь под раскрытием. */
  role: 'main' | 'or' | 'fallback'
  kind: 'command' | 'file'
  /** chat: слэш-команды в чате Claude Code. */
  where?: 'terminal' | 'chat'
  title: string
  /** Ровно то, что копирует кнопка. */
  code: string
  lang: 'shell' | 'json' | 'toml' | 'text'
  path?: string
  scope?: 'project' | 'user'
  note?: string
}

export type Deeplink = { target: 'cursor' | 'vscode'; server: string; href: string }

export type VariableHint = { name: string; required: boolean; secret: boolean; description: string; placeholder: string }

export type AgentPlan = {
  target: PlanTarget
  label: string
  /** Значение для sf-agent в localStorage и data-sf-agent у html: совпадает со слагом таксономии агентов. */
  siteSlug: string
  steps: Step[]
  deeplinks: Deeplink[]
  variables: VariableHint[]
  note?: string
}
