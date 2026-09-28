import { CliError, tr, type Ctx } from './context'

/**
 * Текст из рецепта и с сервера печатается только после зачистки: ANSI и OSC последовательности, управляющие
 * символы и переключатели направления письма могут подменить вывод терминала (CWE-150).
 */
export const clean = (text: string): string =>
  String(text)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')

export const confirm = async (ctx: Ctx, question: string, def: boolean): Promise<boolean> => {
  if (!ctx.tty) {
    throw new CliError(5, tr(ctx, 'Нужен ответ на вопрос, а терминал не интерактивный. Добавьте --yes.', 'An answer is needed but the terminal is not interactive. Add --yes.'))
  }
  const hint = def ? tr(ctx, '[Д/н]', '[Y/n]') : tr(ctx, '[д/Н]', '[y/N]')
  const answer = (await ctx.prompt(`${question} ${hint} `, false)).toLowerCase()
  if (!answer) return def
  return ['y', 'yes', 'д', 'да'].includes(answer)
}

export const printJson = (ctx: Ctx, value: unknown): void => ctx.out(JSON.stringify(value, null, 2))
