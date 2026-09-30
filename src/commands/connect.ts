import type { Command } from '../cli'
import { Backup, ConfigEditError, writeKey } from '../config-file'
import { CONNECT_AGENTS, connectEdits, GATEWAY_DEFAULT, type ConnectAgent } from '../connect-targets'
import { CliError, tr, type Ctx } from '../context'
import { clean, confirm, printJson } from '../io'

const KEY_RE = /^sfk_[0-9A-Za-z]{40}$/

const readKeyValue = async (ctx: Ctx): Promise<string> => {
  const fromEnv = ctx.env.SKILLFOXX_API_KEY?.trim()
  if (fromEnv) return fromEnv
  if (!ctx.tty) throw new CliError(64, tr(ctx, 'Нет ключа. Задайте переменную SKILLFOXX_API_KEY или запустите команду в терминале.', 'No key. Set SKILLFOXX_API_KEY or run the command in a terminal.'))
  return ctx.prompt(tr(ctx, 'Ключ SkillFoxx API (sfk_...): ', 'SkillFoxx API key (sfk_...): '), true)
}

/** Пробный запрос без затрат: список моделей проходит ту же проверку ключа, что и настоящий запрос. */
const verify = async (ctx: Ctx, gateway: string, key: string): Promise<string[]> => {
  let response: Response
  try {
    response = await ctx.fetch(`${gateway}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new CliError(4, tr(ctx, `Шлюз ${gateway} не ответил. Проверьте сеть и повторите.`, `The gateway ${gateway} did not respond. Check the network and retry.`))
  }
  if (response.status === 401 || response.status === 403) {
    throw new CliError(3, tr(ctx, 'Ключ не принят шлюзом. Создайте новый ключ в кабинете: https://skillfoxx.ru/account/keys', 'The gateway rejected the key. Create a new one: https://skillfoxx.ru/account/keys'))
  }
  if (!response.ok) {
    throw new CliError(4, tr(ctx, `Шлюз ответил ${response.status}. Повторите позже, статус: https://skillfoxx.ru/status`, `The gateway answered ${response.status}. Retry later, status: https://skillfoxx.ru/status`))
  }
  const body = (await response.json().catch(() => ({}))) as { data?: { id?: unknown }[] }
  return (body.data ?? []).map((m) => String(m.id ?? '')).filter((id) => id && !id.endsWith('--reserve'))
}

const cursorSteps = (ctx: Ctx, gateway: string, prefix: string) =>
  tr(
    ctx,
    `Cursor хранит настройки моделей у себя, CLI их не меняет. В Cursor: Settings, Models, OpenAI API Key: ваш ключ (${prefix}...), включите Override OpenAI Base URL: ${gateway}/v1, нажмите Verify.`,
    `Cursor keeps model settings internally, the CLI does not change them. In Cursor: Settings, Models, OpenAI API Key: your key (${prefix}...), enable Override OpenAI Base URL: ${gateway}/v1, press Verify.`,
  )

/** npx skillfoxx connect <агент>: проверить ключ на шлюзе и прописать адрес SkillFoxx API в настройки агента. */
export const runConnect: Command = async (ctx, args, flags) => {
  const agent = args[0] as ConnectAgent | undefined
  if (args.length !== 1 || !agent || !CONNECT_AGENTS.includes(agent)) {
    throw new CliError(64, tr(ctx, `Укажите агента: npx skillfoxx connect ${CONNECT_AGENTS.join('|')}`, `Name an agent: npx skillfoxx connect ${CONNECT_AGENTS.join('|')}`))
  }
  const gateway = (ctx.env.SKILLFOXX_GATEWAY || GATEWAY_DEFAULT).replace(/\/+$/, '')
  const key = await readKeyValue(ctx)
  if (!KEY_RE.test(key)) throw new CliError(64, tr(ctx, 'Это не ключ SkillFoxx: он начинается с sfk_ и содержит 44 символа.', 'This is not a SkillFoxx key: it starts with sfk_ and has 44 characters.'))
  const models = await verify(ctx, gateway, key)
  const edits = connectEdits(ctx, agent, gateway, key, models)
  const files = [...new Set(edits.map((e) => e.file))]

  if (flags.json) {
    printJson(ctx, { agent, gateway, files, models: models.length, dryRun: Boolean(flags.dryRun) })
  } else {
    ctx.out(tr(ctx, `Ключ принят шлюзом, моделей доступно: ${models.length}.`, `The gateway accepted the key, models available: ${models.length}.`))
    for (const f of files) ctx.out(tr(ctx, `Изменится файл: ${clean(f)}`, `Will change: ${clean(f)}`))
  }
  if (flags.dryRun) return 0

  if (agent === 'cursor') {
    ctx.out(cursorSteps(ctx, gateway, key.slice(0, 8)))
    return 0
  }
  if (!flags.yes && !(await confirm(ctx, tr(ctx, 'Записать настройки?', 'Write the settings?'), true))) return 1

  const backup = new Backup(ctx)
  try {
    for (const e of edits) await writeKey(backup, { file: e.file, format: e.format, key: e.key }, e.value, 0o600)
  } catch (error) {
    await backup.restore()
    if (error instanceof ConfigEditError) throw new CliError(2, tr(ctx, error.ru, error.en))
    throw error
  }

  if (agent === 'claude-code') {
    ctx.out(tr(ctx, 'Готово. Перезапустите Claude Code: запросы пойдут через SkillFoxx API.', 'Done. Restart Claude Code: requests will go through SkillFoxx API.'))
    if (ctx.env.ANTHROPIC_API_KEY) ctx.out(tr(ctx, 'В окружении задан ANTHROPIC_API_KEY. Уберите его, иначе Claude Code может пойти в Anthropic напрямую.', 'ANTHROPIC_API_KEY is set in your environment. Remove it, or Claude Code may go to Anthropic directly.'))
  } else {
    ctx.out(tr(ctx, 'Готово. Агенту нужна переменная SKILLFOXX_API_KEY с вашим ключом: добавьте в профиль оболочки строку export SKILLFOXX_API_KEY=ваш_ключ.', 'Done. The agent needs SKILLFOXX_API_KEY with your key: add export SKILLFOXX_API_KEY=your_key to your shell profile.'))
    if (agent === 'codex') ctx.out(tr(ctx, 'Запуск Codex через SkillFoxx: codex --profile skillfoxx', 'Run Codex through SkillFoxx: codex --profile skillfoxx'))
  }
  ctx.out(tr(ctx, 'Подобрать скиллы и MCP под проект: https://skillfoxx.ru/scan', 'Find skills and MCP for your project: https://skillfoxx.ru/scan'))
  return 0
}
