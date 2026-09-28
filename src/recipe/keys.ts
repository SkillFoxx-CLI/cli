/**
 * Доверенные открытые ключи подписи рецептов: kid -> SPKI DER base64. Этот же список вшивает CLI и отдает
 * /.well-known/skillfoxx-recipe-keys.json. Ротация: новый ключ добавляется сюда и выходит в CLI за 30 дней
 * до переключения сервера; старый удаляется еще через 30 дней (спецификация этапа 3, раздел 8).
 * Первый ключ создан 24.09.2026, закрытая часть хранится вне репозитория и только в .env сервера.
 */
export const TRUSTED_RECIPE_KEYS: Readonly<Record<string, string>> = {
  'sf-27684b13': 'MCowBQYDK2VwAyEAKgfYOUtQTo3sv3xpfvq1g0PIkSlRQZCPEbJrcpx5Mbc=',
}
