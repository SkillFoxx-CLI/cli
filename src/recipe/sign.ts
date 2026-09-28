import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

/**
 * Подпись ответа рецепта Ed25519 поверх сырых байтов тела: сообщение "skillfoxx-recipe-v1\n" + тело.
 * Подпись идет в заголовке, тело остается прежним для потребителей этапа 1. Проверяет CLI (этап 3).
 */
export const SIGNATURE_HEADER = 'x-skillfoxx-signature'
const CONTEXT = 'skillfoxx-recipe-v1\n'
const message = (body: string) => Buffer.from(CONTEXT + body, 'utf8')

/** kid: "sf-" и первые 8 hex sha256 от открытого ключа SPKI DER. */
export const keyId = (publicSpkiB64: string): string =>
  `sf-${createHash('sha256').update(Buffer.from(publicSpkiB64, 'base64')).digest('hex').slice(0, 8)}`

export const signBody = (body: string, privatePkcs8B64: string): string => {
  const key = createPrivateKey({ key: Buffer.from(privatePkcs8B64, 'base64'), format: 'der', type: 'pkcs8' })
  const publicB64 = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64')
  return `v1;kid=${keyId(publicB64)};sig=${sign(null, message(body), key).toString('base64url')}`
}

export type VerifyResult = { ok: true; kid: string } | { ok: false; reason: 'missing' | 'malformed' | 'unknown_key' | 'bad_signature' }

export const verifyBody = (body: string, header: string | null, keys: Readonly<Record<string, string>>): VerifyResult => {
  if (!header) return { ok: false, reason: 'missing' }
  const parsed = /^v1;kid=(sf-[0-9a-f]{8});sig=([A-Za-z0-9_-]{86})$/.exec(header.trim())
  if (!parsed) return { ok: false, reason: 'malformed' }
  const pub = keys[parsed[1]]
  if (!pub) return { ok: false, reason: 'unknown_key' }
  const key = createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' })
  return verify(null, message(body), key, Buffer.from(parsed[2], 'base64url')) ? { ok: true, kid: parsed[1] } : { ok: false, reason: 'bad_signature' }
}
