import { isSafeGithubOwner, isSafeGithubRepo, type InstallRecipe, type RecipeComponent } from '../schema'
import type { AgentSpec } from './registry'
import { isSafePath, shellJoin, shellQuote } from './shell'
import { TEXTS } from './texts'
import type { Lang, Step } from './types'

type Of<K extends RecipeComponent['kind']> = Extract<RecipeComponent, { kind: K }>
type Source = InstallRecipe['source']

// Имя папки скилла: без "." и ".." — иначе `cp -R ... .devin/skills/..` уходит на уровень выше папки скиллов.
const SAFE_DIR = /^[A-Za-z0-9._-]+$/
const isSafeDir = (value: string): boolean => SAFE_DIR.test(value) && value !== '.' && value !== '..'
// Больше десяти папок в одной ручной команде никто не наберет без ошибки: для крупных наборов только утилита.
const MAX_PINNED_SKILLS = 10

/** Имя папки скилла: имя из frontmatter, если оно годится для папки, иначе последняя часть пути. */
export const skillDir = (s: Of<'skill'>): string => (isSafeDir(s.name) ? s.name : s.path.split('/').pop() || 'skill')

export const skillSteps = (skills: Of<'skill'>[], source: Source, agent: AgentSpec, lang: Lang): Step[] | null => {
  // Защита в глубину: owner/repo уже проверены схемой (schema.ts), но команда git clone/raw.githubusercontent.com
  // собирается здесь — тот же класс входа проверяется еще раз перед тем, как попасть в shell-команду.
  if (source.kind !== 'github' || !agent.skillsDir || !isSafeGithubOwner(source.owner) || !isSafeGithubRepo(source.repo)) return null
  const t = TEXTS[lang]
  const repo = `${source.owner}/${source.repo}`
  const steps: Step[] = []
  if (agent.skillsCli) {
    steps.push({
      role: 'main',
      kind: 'command',
      where: 'terminal',
      title: t.runInProject,
      lang: 'shell',
      code: shellJoin(['npx', 'skills', 'add', repo, '--skill', ...skills.map((s) => s.name), '-a', agent.skillsCli, '-y']),
      note: t.skillsCliNote,
    })
  }
  // Git-путь ставит ровно тот коммит, который сверила SkillFoxx; нужен известный путь каждого скилла.
  const pinnable = skills.length <= MAX_PINNED_SKILLS && skills.every((s) => s.path !== '' && isSafePath(s.path))
  if (pinnable) {
    const lines = [
      'tmp=$(mktemp -d)',
      `git clone --filter=blob:none --no-checkout https://github.com/${repo}.git "$tmp"`,
      `git -C "$tmp" sparse-checkout set --no-cone ${skills.map((s) => shellQuote(`/${s.path}/`)).join(' ')}`,
      `git -C "$tmp" checkout ${source.commitSha}`,
      `mkdir -p ${agent.skillsDir}`,
      ...skills.map((s) => `cp -R "$tmp/${s.path}" ${agent.skillsDir}/${skillDir(s)}`),
    ]
    const fallback = steps.length > 0
    steps.push({
      role: fallback ? 'fallback' : 'main',
      kind: 'command',
      where: 'terminal',
      title: fallback ? t.gitFallback(source.commitSha.slice(0, 7)) : t.runInProject,
      lang: 'shell',
      code: lines.join('\n'),
      note: t.gitNote,
    })
  }
  return steps.length ? steps : null
}

// Пробел или управляющий символ (включая перевод строки) в значении, которое идет прямо в команду
// чата без экранирования, добавил бы в код лишнюю строку — по сути еще одну слэш-команду.
const hasWhitespaceOrControl = (value: string): boolean => /[\s\x00-\x1f\x7f]/.test(value)

export const pluginStep = (plugins: Of<'plugin'>[], agent: AgentSpec, lang: Lang): Step | null => {
  if (!agent.plugin) return null
  if (plugins.some((p) => hasWhitespaceOrControl(p.marketplace) || hasWhitespaceOrControl(p.marketplaceName) || hasWhitespaceOrControl(p.plugin))) return null
  const markets = [...new Set(plugins.map((p) => p.marketplace))]
  const code = [...markets.map((m) => `/plugin marketplace add ${m}`), ...plugins.map((p) => `/plugin install ${p.plugin}@${p.marketplaceName}`)].join('\n')
  return { role: 'main', kind: 'command', where: 'chat', title: TEXTS[lang].runInChat, lang: 'text', code }
}

export const cliStep = (c: Of<'cli'>, lang: Lang): Step => {
  const t = TEXTS[lang]
  const pkg = shellQuote(c.package)
  const code = {
    npm: `npm install -g ${pkg}`,
    pip: `pipx install ${pkg}`,
    brew: `brew install ${pkg}`,
    cargo: `cargo install ${pkg}`,
    go: `go install ${c.package.includes('@') ? pkg : shellQuote(`${c.package}@latest`)}`,
  }[c.ecosystem]
  // pip получает свою подсказку про pipx; brew, cargo и go — команды POSIX-shell, на Windows нужен Git Bash.
  const note = c.ecosystem === 'pip' ? t.pipNote(c.package) : c.ecosystem === 'npm' ? undefined : t.gitNote
  return { role: 'main', kind: 'command', where: 'terminal', title: t.installCli, lang: 'shell', code, ...(note ? { note } : {}) }
}

export const rulesStep = (c: Of<'rules'>, source: Source, agent: AgentSpec, lang: Lang): Step | null => {
  // Защита в глубину: тот же класс входа (owner/repo) перепроверяется здесь же, перед сборкой raw.githubusercontent.com.
  if (source.kind !== 'github' || !agent.rules.includes(c.format) || !isSafePath(c.path) || !isSafeGithubOwner(source.owner) || !isSafeGithubRepo(source.repo)) return null
  const t = TEXTS[lang]
  const raw = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.commitSha}/${c.path}`
  if (c.format === 'agents-md') {
    // Дописываем, а не перезаписываем: чужой AGENTS.md проекта не теряется.
    return { role: 'main', kind: 'command', where: 'terminal', title: t.rulesAppend, lang: 'shell', code: `curl -fsSL ${raw} >> AGENTS.md`, note: `${t.rulesAppendNote} ${t.gitNote}` }
  }
  const base = c.path.split('/').pop() ?? 'rule'
  const file = /\.mdc$/i.test(base) ? base : `${base.replace(/\.md$/i, '')}.mdc`
  return { role: 'main', kind: 'command', where: 'terminal', title: t.rulesMdc, lang: 'shell', code: `mkdir -p .cursor/rules\ncurl -fsSL ${raw} -o .cursor/rules/${file}`, note: t.gitNote }
}
