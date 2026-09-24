/* Адрес и ключ проекта Supabase для браузера.
 *
 * Ключ здесь ПУБЛИЧНЫЙ по замыслу (шапка sql/12_auth.sql): данные защищают
 * вход, список допущенных app_users и RLS, а не секретность ключа. Поэтому
 * файл публикуется вместе со страницей.
 *
 * Сюда — ТОЛЬКО publishable (sb_publishable_…) или legacy anon (eyJ…).
 * НИКОГДА не service_role и не sb_secret_: такой ключ обходит RLS, и вся база
 * открылась бы любому, кто откроет страницу. app.js проверяет это и
 * отказывается запускаться с секретным ключом.
 *
 * Где взять: Supabase → Project Settings → API Keys.
 */
window.NIETTE_CONFIG = {
  supabaseUrl: 'https://tmgczwrogmzknzbbtssm.supabase.co',   // https://<проект>.supabase.co
  supabaseKey: 'sb_publishable_x6GyzQc0UvE_YNl0nDHohg_LVAi0S6m'    // publishable или legacy anon
};
