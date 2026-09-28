import { execFile, execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'

import { TRUSTED_RECIPE_KEYS } from './shared'

export type Lang = 'ru' | 'en'
export type ExecResult = { code: number; stdout: string; stderr: string }

/** Все внешнее для CLI: файлы по путям home и cwd, сеть, вопросы, процессы, время. Тесты подменяют любое поле. */
export type Ctx = {
  home: string
  sfHome: string
  cwd: string
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  fetch: typeof fetch
  tty: boolean
  lang: Lang
  api: string
  keys: Readonly<Record<string, string>>
  out: (line: string) => void
  err: (line: string) => void
  prompt: (question: string, secret: boolean) => Promise<string>
  exec: (cmd: string, args: string[], timeoutMs?: number) => Promise<ExecResult>
  sleep: (ms: number) => Promise<void>
  now: () => Date
}

export const DEFAULT_API = 'https://skillfoxx.ru'

export class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export const tr = (ctx: Pick<Ctx, 'lang'>, ru: string, en: string): string => (ctx.lang === 'ru' ? ru : en)

/**
 * Язык вывода: сначала LC_ALL, LC_MESSAGES, LANG (кроме C и POSIX); если их нет, язык системы
 * (на macOS первый из AppleLanguages, иначе Intl); если определить не удалось, русский:
 * основная аудитория каталога русскоязычная. Явный выбор всегда флагом --lang.
 */
export const detectLang = (env: Record<string, string | undefined>, systemLocale: () => string | null = () => null): Lang => {
  const fromEnv = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v && !/^(C|POSIX)(\.|$)/i.test(v))
  const locale = fromEnv ?? systemLocale()
  if (!locale) return 'ru'
  return /^ru/i.test(locale) ? 'ru' : 'en'
}

/** Язык системы без переменных окружения: macOS AppleLanguages, затем Intl. Сбой и пустой ответ дают null. */
export const systemLocale = (platform: NodeJS.Platform): string | null => {
  if (platform === 'darwin') {
    try {
      const out = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] })
      const first = out.match(/"?([A-Za-z]{2}(?:[-_][A-Za-z0-9]+)*)"?/)
      if (first) return first[1]
    } catch {
      /* нет defaults или долгий ответ: берем Intl */
    }
  }
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale
    return loc && !/^en(-US)?$/i.test(loc) ? loc : null
  } catch {
    return null
  }
}

/**
 * Скрытый ввод readline: подменяет внутренний _writeToOutput, которым readline пишет и приглашение, и
 * каждую набранную клавишу. Наружу пропускается только точное приглашение, сами символы не выводятся.
 */
export const maskedWrite = (question: string, output: Pick<NodeJS.WritableStream, 'write'>) => (s: string): void => {
  if (s.includes(question)) output.write(question)
}

/**
 * Ctrl+C во время вопроса. В режиме терминала readline перехватывает его сам и шлет SIGINT своему
 * интерфейсу, а не процессу: без пересылки обработчик отката в install не сработал бы. Есть слушатели
 * (идет установка): событие процессу, они откатывают и выходят с кодом 130. Нет: обычный сигнал.
 */
export const forwardSigint = (): void => {
  if (process.listenerCount('SIGINT')) process.emit('SIGINT', 'SIGINT')
  else process.kill(process.pid, 'SIGINT')
}

export type PromptIo = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; interrupt: () => void }

export const readlinePrompt = (io: PromptIo) => async (question: string, secret: boolean): Promise<string> => {
  const rl = createInterface({ input: io.input, output: io.output, terminal: true })
  if (secret) {
    const internal = rl as unknown as { _writeToOutput: (s: string) => void }
    internal._writeToOutput = maskedWrite(question, io.output)
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.on('SIGINT', () => {
        reject(new CliError(130, 'Прервано / Interrupted'))
        io.interrupt()
      })
      rl.question(question).then((answer) => resolve(answer.trim()), reject)
    })
  } finally {
    rl.close()
    if (secret) io.output.write('\n')
  }
}

const realPrompt = readlinePrompt({ input: process.stdin, output: process.stdout, interrupt: forwardSigint })

const realExec = (cmd: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false, windowsHide: true }, (error, stdout, stderr) => {
      const raw = (error as { code?: unknown } | null)?.code
      resolve({ code: error ? (typeof raw === 'number' ? raw : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })

export const makeCtx = (over: Partial<Ctx> = {}): Ctx => {
  const env = over.env ?? (process.env as Record<string, string | undefined>)
  const home = over.home ?? os.homedir()
  return {
    home,
    sfHome: env.SKILLFOXX_HOME || path.join(home, '.skillfoxx'),
    cwd: process.cwd(),
    env,
    platform: process.platform,
    fetch: globalThis.fetch.bind(globalThis),
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    lang: detectLang(env, () => systemLocale(process.platform)),
    api: DEFAULT_API,
    keys: TRUSTED_RECIPE_KEYS,
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    prompt: realPrompt,
    exec: realExec,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    ...over,
  }
}

/** Полный путь к программе из PATH или null. На Windows с расширениями из PATHEXT. */
export const findOnPath = async (ctx: Pick<Ctx, 'env' | 'platform'>, bin: string): Promise<string | null> => {
  const win = ctx.platform === 'win32'
  const dirs = (ctx.env.PATH ?? '').split(win ? ';' : ':').filter(Boolean)
  const exts = win ? (ctx.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, bin + ext)
      try {
        await access(file, constants.X_OK)
        return file
      } catch {}
    }
  }
  return null
}
