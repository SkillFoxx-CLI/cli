import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'))

// zod/v4 реэкспортирует локали всех языков одним пространством имен (export * as locales from
// "../locales/index.js"), поэтому esbuild не может выборочно стряхнуть неиспользуемые: в бандл целиком
// попадает полсотни файлов переводов сообщений валидации, которые CLI не показывает (свои тексты идут через
// tr()). Подменяем список локалей на один en, который реально использует zod/v4/classic/schemas.js.
const trimZodLocales = {
  name: 'trim-zod-locales',
  setup(b) {
    b.onLoad({ filter: /zod[\\/]v4[\\/]locales[\\/]index\.js$/ }, () => ({ contents: `export { default as en } from './en.js'\n`, loader: 'js' }))
  },
}

const result = await build({
  entryPoints: [path.join(here, 'src/bin.ts')],
  outfile: path.join(here, 'dist/cli.js'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  // jsonc-parser отдает в "main" UMD-сборку с require() внутри UMD-обертки, который esbuild не
  // разворачивает статически: в рантайме путь резолвится от dist/cli.js и падает. Поле "module" у него же
  // ESM-сборка без такой проблемы, поэтому она в приоритете.
  mainFields: ['module', 'main'],
  plugins: [trimZodLocales],
  // Бандл читают люди перед запуском чужого установщика: без минификации.
  minify: false,
  legalComments: 'eof',
  metafile: true,
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __sfxRequire } from "node:module";\nconst require = __sfxRequire(import.meta.url);' },
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
})

// Лицензии вшитых пакетов кладутся рядом с бандлом: MIT, BSD и ISC требуют сохранять текст лицензии.
const packages = new Set()
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)
  if (match) packages.add(match[1])
}
const root = here
const parts = []
for (const name of [...packages].sort()) {
  const dir = path.join(root, 'node_modules', name)
  const meta = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  let text = ''
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
    try {
      text = await readFile(path.join(dir, file), 'utf8')
      break
    } catch {}
  }
  parts.push(`${name}@${meta.version} (${meta.license})\n\n${text.trim()}\n`)
}
await writeFile(path.join(here, 'dist/THIRD_PARTY_LICENSES.txt'), parts.join('\n---\n\n'))
