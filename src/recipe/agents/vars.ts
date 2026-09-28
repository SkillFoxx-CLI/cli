import { SYSTEM_VARS, type EnvVar } from '../schema'
import { TEXTS } from './texts'
import type { Lang, VariableHint } from './types'

const TEMPLATE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export const placeholder = (v: { name: string; secret: boolean }, lang: Lang): string =>
  v.secret ? TEXTS[lang].secretPlaceholder(v.name) : TEXTS[lang].valuePlaceholder(v.name)

// Фиксированное несекретное значение как есть, обязательная переменная плейсхолдером,
// необязательная без значения в конфиг не идет (она есть в списке переменных).
const envValue = (v: EnvVar, lang: Lang): string | undefined => (v.value !== undefined ? v.value : v.required ? placeholder(v, lang) : undefined)

export const envTable = (env: EnvVar[], lang: Lang): Record<string, string> =>
  Object.fromEntries(
    env.flatMap((v): [string, string][] => {
      const value = envValue(v, lang)
      return value === undefined ? [] : [[v.name, value]]
    }),
  )

// Системные ${HOME} и подобные в JSON-конфигах и в одинарных кавычках не раскрываются: понятная заглушка.
export const fillTemplate = (text: string, env: EnvVar[], lang: Lang): string =>
  text.replace(TEMPLATE, (match, name: string) => {
    const v = env.find((e) => e.name === name)
    if (v) return v.value ?? placeholder(v, lang)
    if (SYSTEM_VARS.has(name)) return TEXTS[lang].systemVars[name] ?? match
    return match
  })

export const variableHints = (env: EnvVar[], lang: Lang): VariableHint[] =>
  env
    .filter((v) => v.value === undefined)
    .map((v) => ({ name: v.name, required: v.required, secret: v.secret, description: v.description, placeholder: placeholder(v, lang) }))
