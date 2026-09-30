import { parseArgs } from 'node:util'

import { runAdd } from './commands/add'
import { runConnect } from './commands/connect'
import { runDoctor } from './commands/doctor'
import { runList } from './commands/list'
import { runRemove } from './commands/remove'
import { runSearch } from './commands/search'
import { runUpdate } from './commands/update'
import { CliError, DEFAULT_API, tr, type Ctx } from './context'
import { clean } from './io'
import { VERSION } from './version'

export type Flags = { agent?: string; global?: boolean; project?: boolean; yes?: boolean; force?: boolean; dryRun?: boolean; json?: boolean; allowTelemetry?: boolean }
export type Command = (ctx: Ctx, args: string[], flags: Flags) => Promise<number>

/** Команды регистрируются здесь; каждая задача плана добавляет свою строку. */
export const COMMANDS: Record<string, Command> = { add: runAdd, remove: runRemove, update: runUpdate, list: runList, doctor: runDoctor, search: runSearch, connect: runConnect }

const OPTIONS = {
  agent: { type: 'string' },
  global: { type: 'boolean' },
  project: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  force: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  'allow-telemetry': { type: 'boolean' },
  lang: { type: 'string' },
  api: { type: 'string' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const

export const parseCli = (argv: string[]) => {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
    const [command = '', ...args] = positionals
    return { command, args, values }
  } catch (error) {
    throw new CliError(64, (error as Error).message)
  }
}

const HELP_RU = `Использование: npx skillfoxx <команда> [параметры]

Команды:
  add <раздел>/<slug>   поставить запись каталога в агентов
  remove <запись>       удалить установленное SkillFoxx
  update [запись]       обновить до версии, сверенной SkillFoxx
  list                  что установлено
  doctor                проверить установленное: изменено, устарело, снято
  search <запрос>       найти запись в каталоге
  connect <агент>       подключить Claude Code, Codex, opencode или Cursor к SkillFoxx API

Параметры:
  --agent a,b   агенты (claude-code, cursor, vscode, codex, gemini-cli, devin, cline, zoo-code, opencode, zed, goose, amp, hermes, sourcecraft, coddy или all)
  --project     в проект (по умолчанию внутри проекта)
  --global      для пользователя
  -y, --yes     без вопросов
  --force       заменить то, что поставлено не SkillFoxx или изменено руками
  --dry-run     только показать план
  --json        вывод в JSON
  --allow-telemetry  не отключать отправку данных автору инструмента (по умолчанию CLI предлагает
                отключить ее, если автор называет переменную)
  --lang ru|en  язык вывода

Телеметрия анонимная, отключается DO_NOT_TRACK=1. Подробнее: https://skillfoxx.ru/developers`

const HELP_EN = `Usage: npx skillfoxx <command> [options]

Commands:
  add <section>/<slug>  install a catalog entry into your agents
  remove <entry>        remove what SkillFoxx installed
  update [entry]        update to the version SkillFoxx has rechecked
  list                  show what is installed
  doctor                check installs: modified, outdated, removed
  search <query>        find an entry in the catalog
  connect <agent>       connect Claude Code, Codex, opencode or Cursor to SkillFoxx API

Options:
  --agent a,b   agents (claude-code, cursor, vscode, codex, gemini-cli, devin, cline, zoo-code, opencode, zed, goose, amp, hermes, sourcecraft, coddy or all)
  --project     into the project (default inside a project)
  --global      for the user
  -y, --yes     no questions
  --force       replace what SkillFoxx did not install or what was edited by hand
  --dry-run     print the plan only
  --json        JSON output
  --allow-telemetry  keep the tool sending data to its author (by default the CLI offers to turn it
                off when the author names a variable for that)
  --lang ru|en  output language

Telemetry is anonymous, disable it with DO_NOT_TRACK=1. Details: https://skillfoxx.ru/developers`

export const main = async (argv: string[], ctx: Ctx): Promise<number> => {
  try {
    const { command, args, values } = parseCli(argv)
    if (values.lang === 'ru' || values.lang === 'en') ctx.lang = values.lang
    if (values.api) {
      ctx.api = values.api.replace(/\/+$/, '')
      if (ctx.api !== DEFAULT_API) ctx.err(tr(ctx, `Внимание: адрес API ${clean(ctx.api)}`, `Warning: API address ${clean(ctx.api)}`))
    }
    if (values.version) {
      ctx.out(VERSION)
      return 0
    }
    if (values.help || !command) {
      ctx.out(tr(ctx, HELP_RU, HELP_EN))
      return 0
    }
    const run = COMMANDS[command]
    if (!run) {
      ctx.err(tr(ctx, `Неизвестная команда: ${clean(command)}. Справка: npx skillfoxx --help`, `Unknown command: ${clean(command)}. Help: npx skillfoxx --help`))
      return 64
    }
    const flags: Flags = {
      agent: values.agent,
      global: values.global,
      project: values.project,
      yes: values.yes,
      force: values.force,
      dryRun: values['dry-run'],
      json: values.json,
      allowTelemetry: values['allow-telemetry'],
    }
    return await run(ctx, args, flags)
  } catch (error) {
    if (error instanceof CliError) {
      ctx.err(clean(error.message))
      return error.code
    }
    ctx.err(tr(ctx, 'Непредвиденная ошибка: ', 'Unexpected error: ') + clean(String((error as Error)?.message ?? error)))
    return 1
  }
}
