import { expandGlobal } from './agents'
import type { Ctx } from './context'

export const GATEWAY_DEFAULT = 'https://api.skillfoxx.ru'
export const CONNECT_AGENTS = ['claude-code', 'codex', 'opencode', 'cursor'] as const
export type ConnectAgent = (typeof CONNECT_AGENTS)[number]
export type ConnectEdit = { file: string; format: 'json' | 'toml'; key: string[]; value: unknown }

/**
 * Что пишет connect. Claude Code читает env из settings.json (ключ лежит там же, как у его собственного
 * входа). Codex и opencode берут ключ из SKILLFOXX_API_KEY: в их файлах ключа нет. Cursor хранит настройки
 * в своей базе, туда CLI не пишет: печатает шаги.
 */
export const connectEdits = (ctx: Pick<Ctx, 'home' | 'env' | 'platform'>, agent: ConnectAgent, gateway: string, key: string, models: string[]): ConnectEdit[] => {
  if (agent === 'claude-code') {
    const file = expandGlobal(ctx, '{claude}/settings.json')
    return [
      { file, format: 'json', key: ['env', 'ANTHROPIC_BASE_URL'], value: gateway },
      { file, format: 'json', key: ['env', 'ANTHROPIC_AUTH_TOKEN'], value: key },
    ]
  }
  if (agent === 'codex') {
    const file = expandGlobal(ctx, '{codex}/config.toml')
    return [
      { file, format: 'toml', key: ['model_providers', 'skillfoxx'], value: { name: 'SkillFoxx', base_url: `${gateway}/v1`, env_key: 'SKILLFOXX_API_KEY', wire_api: 'chat' } },
      { file, format: 'toml', key: ['profiles', 'skillfoxx'], value: { model_provider: 'skillfoxx' } },
    ]
  }
  if (agent === 'opencode') {
    return [
      {
        file: expandGlobal(ctx, '~/.config/opencode/opencode.json'),
        format: 'json',
        key: ['provider', 'skillfoxx'],
        value: {
          npm: '@ai-sdk/openai-compatible',
          name: 'SkillFoxx',
          options: { baseURL: `${gateway}/v1`, apiKey: '{env:SKILLFOXX_API_KEY}' },
          models: Object.fromEntries(models.slice(0, 60).map((id) => [id, { name: id }])),
        },
      },
    ]
  }
  return []
}
