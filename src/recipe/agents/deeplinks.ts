/** base64 от UTF-8: btoa понимает только Latin-1, а в плейсхолдерах кириллица. */
export const base64Utf8 = (text: string): string => {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** https://cursor.com/docs/context/mcp/install-links: config это base64 объекта сервера без обертки именем. */
export const cursorDeeplink = (name: string, server: Record<string, unknown>): string =>
  `https://cursor.com/en/install-mcp?name=${encodeURIComponent(name)}&config=${encodeURIComponent(base64Utf8(JSON.stringify(server)))}`

/**
 * https://code.visualstudio.com/api/extension-guides/ai/mcp: vscode:mcp/install?<json>. Обертка https показывает
 * понятную страницу тому, у кого VS Code не установлен, вместо молчаливой ошибки неизвестной схемы.
 */
export const vscodeDeeplink = (name: string, server: Record<string, unknown>): string => {
  const raw = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, ...server }))}`
  return `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(raw)}`
}
