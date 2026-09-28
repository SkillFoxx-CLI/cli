import { createHash } from 'node:crypto'

import { z } from 'zod'

/** Рецепт установки записи каталога: см. docs/superpowers/specs/2026-09-24-install-recipes-design.md. */

export const RECIPE_STATUSES = ['auto', 'ai', 'verified', 'unsupported', 'review'] as const
export const RECIPE_ORIGINS = [
  'server-json',
  'plugin-manifest',
  'skill-tree',
  'package-manifest',
  'card-commands',
  'card-mcp-fields',
  'ai',
  'manual',
] as const
export type RecipeStatus = (typeof RECIPE_STATUSES)[number]
export type RecipeOrigin = (typeof RECIPE_ORIGINS)[number]

const name = z.string().min(1).max(120)

/** Имена переменных вида ${ИМЯ} в строке: в args, адресе и значениях заголовков это места подстановки. */
const TEMPLATE_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
export const templateVars = (text: string): string[] => [...text.matchAll(TEMPLATE_VAR)].map((m) => m[1])

/** Системные переменные окружения (${HOME}/data): их знает сама система, у пользователя они не спрашиваются. */
export const SYSTEM_VARS: ReadonlySet<string> = new Set(['HOME', 'PWD', 'USER', 'TMPDIR'])

// Значение value допустимо только у несекретной переменной: это фиксированная настройка из конфига
// (NPM_CONFIG_IGNORE_SCRIPTS=true), а не данные пользователя. Секрет не хранится никогда.
const envVar = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    required: z.boolean(),
    secret: z.boolean(),
    description: z.string().max(300),
    value: z.string().max(300).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.value !== undefined && v.secret) ctx.addIssue({ code: 'custom', path: ['value'], message: 'у секретной переменной не может быть значения' })
  })

// Заголовок HTTP: имя как есть, значение это шаблон с ${ИМЯ} (Bearer ${TOKEN}, OAuth ${WIKI_TOKEN}, ${ORG_ID}).
const header = z.object({
  name: z.string().regex(/^[A-Za-z0-9-]+$/).max(100),
  value: z.string().max(500),
  secret: z.boolean(),
})

// Каждая ${ИМЯ} в местах подстановки должна быть объявлена в env того же компонента, иначе установщику
// неоткуда взять значение и нечего спросить у пользователя.
const requireDeclared = (texts: { path: (string | number)[]; text: string }[], env: { name: string }[], ctx: z.RefinementCtx) => {
  const declared = new Set(env.map((e) => e.name))
  for (const { path, text } of texts) {
    for (const v of templateVars(text)) {
      if (!declared.has(v) && !SYSTEM_VARS.has(v)) ctx.addIssue({ code: 'custom', path, message: `переменная ${v} не объявлена в env` })
    }
  }
}

// Путь в репозитории: без выхода за его пределы. Пустая строка у skill.path остается годной
// (означает корень репозитория) — проверка ловит только сегмент ".." и ведущий "/", а не пустоту.
// Это защита в глубину: тот же класс путей заново и независимо проверяет isSafePath в
// src/lib/install-recipe/agents/shell.ts перед тем, как путь попадает в команду или URL.
const noPathTraversal = (path: string): boolean => !path.startsWith('/') && !path.split('/').includes('..')

// owner/repo (маркетплейс на GitHub) или https-адрес без пробелов: то, что реально идет в
// `/plugin marketplace add <это>` без экранирования — перевод строки в значении иначе добавляет
// в команду лишнюю слэш-команду.
const MARKETPLACE = /^(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|https:\/\/\S+)$/

// owner и repo источника github идут прямо в shell-команды (git clone URL) и в raw.githubusercontent.com
// без экранирования: правила имени пользователя и репозитория GitHub, а не общий "безопасный путь".
// Экспортированы для components.ts — тот же класс входа проверяется еще раз перед сборкой команды
// (защита в глубину, см. GITHUB_OWNER_RE/GITHUB_REPO_RE ниже).
export const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
export const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
export const isSafeGithubOwner = (owner: string): boolean => GITHUB_OWNER_RE.test(owner)
export const isSafeGithubRepo = (repo: string): boolean => GITHUB_REPO_RE.test(repo) && repo !== '.' && repo !== '..'

const component = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('skill'), name, path: z.string().max(300).refine(noPathTraversal, 'путь не должен выходить за пределы репозитория') }),
  z
    .object({
      kind: z.literal('mcp-stdio'),
      name,
      runtime: z.enum(['npx', 'uvx', 'docker', 'node', 'python', 'binary']),
      package: z
        .object({ registry: z.enum(['npm', 'pypi', 'oci']), identifier: z.string().min(1).max(200), version: z.string().max(60).optional() })
        .optional(),
      args: z.array(z.string().max(400)).max(40),
      env: z.array(envVar).max(40),
    })
    .superRefine((c, ctx) => requireDeclared(c.args.map((text, i) => ({ path: ['args', i], text })), c.env, ctx)),
  z
    .object({
      kind: z.literal('mcp-http'),
      name,
      transport: z.enum(['streamable-http', 'sse']),
      url: z.string().url().max(500),
      headers: z.array(header).max(20),
      env: z.array(envVar).max(40),
    })
    .superRefine((c, ctx) =>
      requireDeclared([{ path: ['url'], text: c.url }, ...c.headers.map((h, i) => ({ path: ['headers', i, 'value'], text: h.value }))], c.env, ctx),
    ),
  // marketplace: откуда ставить (owner/repo или адрес); marketplaceName: имя из marketplace.json, оно идет в /plugin install x@имя.
  z.object({
    kind: z.literal('plugin'),
    ecosystem: z.literal('claude-code'),
    marketplace: z.string().min(1).max(300).regex(MARKETPLACE),
    // Только то, что реально встречается в именах маркетплейсов (owner/repo, package-имя): без пробелов
    // и без отображаемого названия вроде "Agentic Plugin Marketplace".
    marketplaceName: z.string().regex(/^[A-Za-z0-9._-]+$/).max(120),
    plugin: name,
  }),
  z.object({ kind: z.literal('cli'), ecosystem: z.enum(['npm', 'pip', 'brew', 'cargo', 'go']), package: z.string().min(1).max(200), bin: z.string().max(80).optional() }),
  z.object({ kind: z.literal('rules'), format: z.enum(['agents-md', 'cursor-mdc']), path: z.string().max(300).refine(noPathTraversal, 'путь не должен выходить за пределы репозитория') }),
])

export const RecipeSchema = z.object({
  schema: z.literal(1),
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('github'),
      owner: z.string().regex(GITHUB_OWNER_RE, 'owner не похож на имя пользователя GitHub'),
      repo: z.string().regex(GITHUB_REPO_RE, 'repo не похож на имя репозитория GitHub').refine(isSafeGithubRepo, 'repo не может быть "." или ".."'),
      ref: z.string().min(1).max(200),
      commitSha: z.string().regex(/^[0-9a-f]{40}$/),
      pinnedAt: z.string().datetime(),
      // Отпечаток файлов под папками скиллов и файлов правил на коммите (см. digest.ts): смена
      // содержимого скилла без смены SKILL.md видна сверке. Для прочих видов компонентов поля нет.
      contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
      // Отпечаток полей карточки, из которых собран рецепт (см. card-digest.ts): смена команды,
      // полей mcp или адресов в карточке видна сверке, даже если коммит репозитория не менялся.
      cardDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    }),
    z.object({
      kind: z.literal('remote'),
      vendorUrl: z.string().url().max(500),
      cardDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    }),
  ]),
  // Наборы скиллов ставятся целиком: в крупных репозиториях их десятки.
  components: z.array(component).min(1).max(200),
  requirements: z
    .object({
      runtimes: z.array(z.enum(['node>=18', 'node>=20', 'python>=3.10', 'python>=3.11', 'docker', 'bun', 'go', 'deno'])).optional(),
      os: z.array(z.enum(['macos', 'linux', 'windows'])).optional(),
      notes: z.string().max(300).optional(),
    })
    .optional(),
})

export type InstallRecipe = z.infer<typeof RecipeSchema>
export type RecipeComponent = InstallRecipe['components'][number]
export type EnvVar = z.infer<typeof envVar>
export type Header = z.infer<typeof header>

// Похожее на секрет: известные префиксы токенов, Bearer с токеном, длинные hex и base64 без плейсхолдера.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  // Slack: xoxa/b/p/r/s, а также xoxc (сессия браузера) и xoxe (ротация, в том числе xoxe.xoxp-).
  /\bxox[abprsce][.-][A-Za-z0-9.-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /Bearer\s+(?!\$\{)[A-Za-z0-9._~+/-]{16,}/i,
  /(?<![A-Za-z0-9])[0-9a-f]{40,}(?![A-Za-z0-9])/i,
  // base64 только со цифрой и заглавной: длинные пути вида plugins/marketplace/... не считаются секретом
  /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/])/,
]

const strings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out))
  return out
}

/** Строки рецепта, похожие на секреты. commitSha, contentDigest и cardDigest исключены: это hex по определению. */
export const findSecrets = (recipe: unknown): string[] => {
  const copy = JSON.parse(JSON.stringify(recipe ?? {}))
  if (copy?.source?.commitSha) delete copy.source.commitSha
  if (copy?.source?.contentDigest) delete copy.source.contentDigest
  if (copy?.source?.cardDigest) delete copy.source.cardDigest
  return strings(copy).filter((text) => SECRET_PATTERNS.some((pattern) => pattern.test(text.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ''))))
}

export const parseRecipe = (input: unknown): { ok: true; recipe: InstallRecipe } | { ok: false; errors: string[] } => {
  const parsed = RecipeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
  const secrets = findSecrets(parsed.data)
  if (secrets.length) return { ok: false, errors: [`похоже на секрет: ${secrets.length} знач.`] }
  return { ok: true, recipe: parsed.data }
}

// Ключи объектов сортируются, порядок массивов остается как есть: jsonb Postgres не хранит порядок
// ключей объекта (сортирует по длине, затем побайтово), поэтому один и тот же рецепт, прочитанный из
// БД и только что собранный zod, может отличаться порядком полей без единого смыслового отличия.
export const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]))
  }
  return value
}

/** Каноническая строка для сравнения значений независимо от порядка ключей исходного объекта. */
export const canonicalJSON = (value: unknown): string => JSON.stringify(sortKeys(value))

export const canonicalHash = (recipe: InstallRecipe): string => `sha256:${createHash('sha256').update(canonicalJSON(recipe)).digest('hex')}`
