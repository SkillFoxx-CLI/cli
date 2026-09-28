// Аргумент без кавычек: только символы, которые оболочка не трактует особо.
const SAFE_ARG = /^[A-Za-z0-9_/.:=@%+,-]+$/
// Символы, разрешенные в пути репозитория. Сам по себе набор символов не запрещает "..": это
// проверяется отдельно, по сегментам, иначе `../../../../etc` проходит как безобидная строка.
const SAFE_PATH_CHARS = /^[A-Za-z0-9._/-]+$/

/**
 * Путь в репозитории, который можно вставить в команду или URL без экранирования и без выхода
 * за пределы репозитория: разрешенные символы, без сегментов "." и "..", не начинается с "/" или
 * "-", без "//". Пустая строка не считается безопасным путем здесь: вызывающий код сам решает,
 * что для него означает пустой путь.
 */
export const isSafePath = (path: string): boolean => {
  if (!SAFE_PATH_CHARS.test(path)) return false
  if (path.startsWith('/') || path.startsWith('-') || path.includes('//')) return false
  return path.split('/').every((segment) => segment !== '.' && segment !== '..')
}

export const shellQuote = (value: string): string => (SAFE_ARG.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`)
export const shellJoin = (parts: string[]): string => parts.map(shellQuote).join(' ')

export const tomlKey = (key: string): string => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key))
// Экранирование JSON совместимо с базовыми строками TOML.
export const tomlString = (value: string): string => JSON.stringify(value)
export const tomlInlineTable = (table: Record<string, string>): string =>
  `{ ${Object.entries(table)
    .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`)
    .join(', ')} }`

export const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2)
