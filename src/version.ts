declare const __CLI_VERSION__: string | undefined

/** Версия подставляется esbuild из package.json; в тестах без сборки это 0.0.0-dev. */
export const VERSION: string = typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-dev'
