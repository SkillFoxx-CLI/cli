import type { InstallRecipe, RecipeComponent } from '../schema'
import { cliStep, pluginStep, rulesStep, skillSteps } from './components'
import { mcpSteps } from './mcp'
import { AGENTS, type AgentSpec } from './registry'
import { TEXTS } from './texts'
import type { AgentPlan, Deeplink, Lang, PlanTarget, Step, VariableHint } from './types'
import { variableHints } from './vars'

type Of<K extends RecipeComponent['kind']> = Extract<RecipeComponent, { kind: K }>

const uniqueByName = (list: VariableHint[]): VariableHint[] => [...new Map(list.map((v) => [v.name, v])).values()]

/**
 * allowDeeplinks: тот же хук уровня страницы, что у mcpSteps (задачи 6/7). Сам модуль риск записи не знает,
 * только пробрасывает флаг дальше; по умолчанию ссылки остаются.
 */
export type PlanOptions = { allowDeeplinks?: boolean }

/** План одного агента. null, если агент не умеет хотя бы один компонент: полуинструкция хуже никакой. */
export const planFor = (recipe: InstallRecipe, agent: AgentSpec, lang: Lang, options: PlanOptions = {}): AgentPlan | null => {
  const allowDeeplinks = options.allowDeeplinks ?? true
  const steps: Step[] = []
  const deeplinks: Deeplink[] = []
  const variables: VariableHint[] = []

  const skills = recipe.components.filter((c): c is Of<'skill'> => c.kind === 'skill')
  if (skills.length) {
    const found = skillSteps(skills, recipe.source, agent, lang)
    if (!found) return null
    steps.push(...found)
  }
  const plugins = recipe.components.filter((c): c is Of<'plugin'> => c.kind === 'plugin')
  if (plugins.length) {
    const found = pluginStep(plugins, agent, lang)
    if (!found) return null
    steps.push(found)
  }
  for (const c of recipe.components) {
    if (c.kind === 'cli') steps.push(cliStep(c, lang))
    else if (c.kind === 'rules') {
      const found = rulesStep(c, recipe.source, agent, lang)
      if (!found) return null
      steps.push(found)
    } else if (c.kind === 'mcp-stdio' || c.kind === 'mcp-http') {
      const found = mcpSteps(c, agent, lang, allowDeeplinks)
      if (!found) return null
      steps.push(...found.steps)
      deeplinks.push(...found.deeplinks)
      variables.push(...variableHints(c.env, lang))
    }
  }
  const note = TEXTS[lang].agentNote[agent.id]
  return { target: agent.id, label: agent.label, siteSlug: agent.siteSlug, steps, deeplinks, variables: uniqueByName(variables), ...(note ? { note } : {}) }
}

export const terminalPlan = (recipe: InstallRecipe, lang: Lang): AgentPlan => ({
  target: 'terminal',
  label: TEXTS[lang].terminal,
  siteSlug: 'terminal',
  steps: recipe.components.filter((c): c is Of<'cli'> => c.kind === 'cli').map((c) => cliStep(c, lang)),
  deeplinks: [],
  variables: [],
})

/** Планы по агентам в порядке реестра. Рецепт только из CLI от агента не зависит: одна вкладка «Терминал». */
export const buildPlans = (recipe: InstallRecipe, lang: Lang, options: PlanOptions = {}): AgentPlan[] => {
  if (recipe.components.every((c) => c.kind === 'cli')) return [terminalPlan(recipe, lang)]
  return AGENTS.map((agent) => planFor(recipe, agent, lang, options)).filter((plan): plan is AgentPlan => plan !== null)
}

export const pickPlan = (plans: AgentPlan[], target: PlanTarget): AgentPlan | null =>
  plans.length === 1 && plans[0].target === 'terminal' ? plans[0] : (plans.find((plan) => plan.target === target) ?? null)

const RUNTIME_LABELS: Record<string, string> = {
  'node>=18': 'Node.js 18+',
  'node>=20': 'Node.js 20+',
  'python>=3.10': 'Python 3.10+',
  'python>=3.11': 'Python 3.11+',
  docker: 'Docker',
  bun: 'Bun',
  go: 'Go',
  deno: 'Deno',
}
const MCP_RUNTIME: Record<string, string> = { npx: 'Node.js', node: 'Node.js', uvx: 'uv', python: 'Python', docker: 'Docker' }
const CLI_ECOSYSTEM: Record<string, string> = { npm: 'Node.js', pip: 'pipx', brew: 'Homebrew', cargo: 'Rust', go: 'Go' }

/** «Понадобится»: требования рецепта плюс то, что следует из самих шагов; Node.js 20+ поглощает Node.js. */
export const requirementLabels = (recipe: InstallRecipe): string[] => {
  const out = (recipe.requirements?.runtimes ?? []).map((runtime) => RUNTIME_LABELS[runtime]).filter(Boolean)
  const add = (label: string | undefined) => {
    if (label && !out.some((existing) => existing.split(' ')[0] === label.split(' ')[0])) out.push(label)
  }
  for (const c of recipe.components) {
    if (c.kind === 'mcp-stdio') add(MCP_RUNTIME[c.runtime])
    if (c.kind === 'cli') add(CLI_ECOSYSTEM[c.ecosystem])
    // Установка скилла через утилиту всегда идет командой `npx skills`, даже когда у выбранного
    // агента она не единственный шаг: требование следует из самого рецепта, а не из плана агента.
    if (c.kind === 'skill') add('Node.js')
  }
  return out
}
