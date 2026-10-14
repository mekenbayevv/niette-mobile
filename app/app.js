/* NIETTE на Postgres: вход и семь экранов — «Обзор», «Kaspi», «Ozon», «Аналитика»,
 * «Клиенты», «Склад» и «B2B».
 *
 * Состояния по порядку: нет библиотеки / нет настроек / секретный ключ →
 * вход → проверка допуска (app_users) → загрузка → экран.
 *
 * ЭКРАНЫ — по адресу: …/app/ и …/app/#overview — «Обзор», …/app/#kaspi —
 * «Kaspi», …/app/#ozon — «Ozon», …/app/#analytics — «Аналитика»,
 * …/app/#clients — «Клиенты», …/app/#stock — «Склад», …/app/#b2b — «B2B». Данные экрана грузятся при первом заходе на
 * него и дальше живут в памяти: переключение между вкладками в базу не
 * ходит. «Обновить» перечитывает открытый экран. Период у всех экранов,
 * кроме «Клиентов» и «Склада», общий: выбрал июль на одном — остальные
 * откроются на июле. У «Склада» периода нет: остаток — на сейчас.
 *
 * ДОСТУП. Вход — Supabase Auth (email и пароль). «Вошёл» ещё ничего не
 * значит: читать можно, только если email есть в app_users (sql/12_auth.sql).
 * Недопущенному RLS отдаёт пустые витрины без ошибки, поэтому допуск
 * проверяется ЯВНО, rpc('is_app_user'): иначе он увидел бы пустой экран и
 * решил, что клиентов нет.
 *
 * РАЗДЕЛЫ (05.10.2026). Что открыто вошедшему — rpc('app_me'): торгпред с
 * разделом {b2b} видит одну вкладку «B2B», остальные ему не показываются, а
 * адрес …/app/#kaspi открывает его вкладку. Права держит база (политики 12),
 * не страница: вкладки прячутся, чтобы торгпред не открывал пустые экраны.
 * Нет app_me в базе (страница выложена раньше SQL) — все вкладки, как раньше.
 * Выход стирает из памяти всё загруженное: следующий вошедший на этом
 * телефоне не должен найти в ней чужие экраны.
 *
 * ДАННЫЕ. Читаются снимки витрин (snap_*, sql/15_snapshots.sql) — готовые
 * таблицы, а не пересчёт на каждый заход. Каждый снимок грузится отдельно
 * (Promise.allSettled): упал один — его раздел показывает причину, остальные
 * работают. Большие листаются страницами до пустой страницы: у проекта
 * Supabase стоит лимит строк на ответ (по умолчанию 1000), и без листания
 * база клиентов молча обрезалась бы.
 */
(function (root) {
  'use strict';
  const s0 = v => String(v === null || v === undefined ? '' : v);

  const C = root.NietteClients;
  const NBSP = '\u00a0';
  const PAGE = 1000;
  const BASE_STEP = 50;
  const RISK_STEP = 20;

  // Страница читает СНИМКИ витрин (sql/15_snapshots.sql), а не сами витрины.
  // 25.09.2026 витрины напрямую упали по тайм-ауту в четырёх разделах из
  // шести: шесть пересчётов сразу, плюс каждая страница базы — пересчёт с
  // нуля. Снимки пересчитывает pg_cron раз в 10 минут, их время — в snap_state.
  // Порядок = порядок разделов на экране. select перечислен там, где таблица
  // шире, чем нужно экрану: меньше байтов через мобильную сеть.
  const SOURCES = [
    // Главное о клиентах (sql/30): группа × когорта × показатель × окно — сотни
    // строк. Листается: на пятом десятке когорт перевалит за лимит строк проекта.
    { key: 'summary', table: 'snap_client_summary', paged: true, order: ['grp', 'metric', 'h', 'cohort'], what: 'Главное о клиентах' },
    { key: 'base',    table: 'snap_client_base',      paged: true, order: 'client_key', what: 'База клиентов' },
    { key: 'risk',    table: 'snap_client_risk',      paged: true, order: 'client_key', what: 'Риск оттока',
      select: 'client_key,name,city,orders,revenue,last_at,days_since_last,expected_gap,overdue_x,risk' },
    { key: 'repeat',  table: 'snap_client_repeat',    order: 'sort',   what: 'Время до второго заказа' },
    { key: 'ltv',     table: 'snap_client_ltv',       order: 'cohort', what: 'Когорты' },
    // LTV по месяцам жизни (sql/29): разрез × группа × месяц, десятки строк.
    { key: 'ltvCurve', table: 'snap_client_ltv_curve', order: ['dim', 'grp', 'k'], what: 'LTV по месяцам жизни' },
    // Удержание (sql/27): строка — когорта × месяц после первого, десятки строк.
    { key: 'retention', table: 'snap_client_retention', order: ['cohort', 'k'], what: 'Удержание по месяцам' },
    { key: 'retentionEntry', table: 'snap_client_retention_entry', order: ['entry', 'cohort', 'k'],
      what: 'Удержание по первой покупке' },
    { key: 'monthly', table: 'snap_new_vs_returning', order: 'month',  what: 'Новые и вернувшиеся' },
    // Кто покупал в месяце (sql/29): месяц × группа × когорта, десятки строк.
    { key: 'monthMix', table: 'snap_client_month_mix', order: ['month', 'grp', 'cohort'], what: 'Кто покупал в месяце' },
    { key: 'entry',   table: 'snap_client_entry',     order: 'entry',  what: 'Вход через мини-пак' }
  ];
  // «Обзор» (sql/16_overview.sql): вся история «день × канал» одной таблицей,
  // период и группировку страница считает сама. Сортировка по двум колонкам:
  // листание страницами требует порядка, в котором у строки ровно одно место.
  const OV_DAILY = { table: 'snap_overview_daily', paged: true, order: ['day', 'channel'], what: 'Выручка по дням',
                     select: 'day,channel,revenue,gross,returns,extra,orders' };
  const OV_GAPS = { table: 'snap_overview_gaps', what: 'Пробелы' };
  const OV_FRESH = { table: 'v_overview_freshness', what: 'Свежесть приёма' };
  const OV_PREFS = 'niette.ov.v1';   // период и группировка — между заходами, в этом браузере
  // «Kaspi» (sql/19_kaspi.sql): дни — вся история одной таблицей, как у
  // «Обзора»; пары «клиент × день» — для новых и повторных за любой период.
  const KP_DAILY = { table: 'snap_kaspi_daily', paged: true, order: ['day'], what: 'Kaspi по дням' };
  const KP_CLIENTS = { table: 'snap_kaspi_client_days', paged: true, order: ['cid', 'day'], select: 'cid,day',
                       what: 'Новые и повторные клиенты' };
  const KP_NOW = { table: 'snap_kaspi_now', what: 'В работе' };
  const KP_REMOTE = { table: 'snap_kaspi_remote', order: ['day', 'id'], what: 'Удалённые оплаты' };
  // «Ozon» (sql/20_ozon_screen.sql): деньги по дням из начислений, товары по
  // дням, штрафы списком, «в работе» — одна строка.
  const OZ_DAILY = { table: 'snap_ozon_daily', paged: true, order: ['day'], what: 'Ozon по дням' };
  const OZ_SKU = { table: 'snap_ozon_sku_daily', paged: true, order: ['day', 'sku'], what: 'Товары Ozon' };
  const OZ_ERRORS = { table: 'snap_ozon_errors', paged: true, order: ['day', 'accrual_id', 'fee_no'], what: 'Ошибки продавца' };
  const OZ_NOW = { table: 'snap_ozon_now', what: 'В работе' };
  // «Аналитика» (sql/21_analytics.sql): спрос Kaspi по дню заказа — дни,
  // товары, города, способы доставки. Порядок листания — уникальный ключ
  // снимка: у города NULL бывает, но один на день.
  const AN_DEMAND = { table: 'snap_an_demand', paged: true, order: ['day'], what: 'Заказы по дням' };
  const AN_SKU = { table: 'snap_an_sku', paged: true, order: ['day', 'sku'], what: 'Товары' };
  const AN_CITY = { table: 'snap_an_city', paged: true, order: ['day', 'city'], what: 'Города' };
  const AN_DELIVERY = { table: 'snap_an_delivery', paged: true, order: ['day', 'method'], what: 'Способы доставки' };
  // «Склад» (sql/23_stock_screen.sql): строка на строку листа «Склад» и журнал
  // списаний. Периода нет — остаток на сейчас; свежесть — когда приехали лист
  // и продажи: снимок может быть свежим, а импорт — застывшим.
  const ST_STOCK = { table: 'snap_stock', order: ['pos'], what: 'Остатки' };
  // Журналы и «ещё не в остатке» — витрины, а не снимки (sql/23, 26): записанное
  // формой видно сразу, а снимок остатка догоняет через минуту–две.
  const ST_WOFF = { table: 'v_stock_writeoffs', order: ['day', 'id'], what: 'Журнал списаний' };
  const ST_ARR = { table: 'v_stock_arrivals', order: ['day', 'id'], what: 'Журнал приходов' };
  const ST_PEND = { table: 'v_stock_pending', what: 'Ещё не в остатке' };
  const ST_FRESH = { table: 'v_stock_freshness', what: 'Свежесть листов' };
  // Сверка (sql/24_stock_recon.sql): строка на окно, 30 и 90 дней, отчёт jsonb.
  const ST_RECON = { table: 'snap_stock_recon', order: ['window_days'], what: 'Сверка склада' };
  // Остатки на складах WB и Ozon (sql/25_mp_stocks.sql): строка на площадку.
  // Витрина, а не снимок: строк две, считать нечего — снимок опросника уже в базе.
  const ST_MP = { table: 'v_mp_stocks', order: ['channel'], what: 'Остатки площадок' };
  // «B2B» (sql/28_b2b.sql): таблицы мини-CRM целиком — их сотни строк, не
  // тысячи, а карточка партнёра открывается мгновенно из памяти. Таблицы, а
  // не снимки: после переключения записанное должно быть видно сразу.
  // alive — без мягко удалённых строк (deleted_at: запись, sql/31).
  // Колонки документа до sql/32. Страница, выложенная раньше файла, читает
  // список ими (legacy): документы видны, а что прогнать — сказано (legacyNote).
  const B2B_DOC_COLS = 'id,kind,kind_label,number,day,client_id,client_name,counterparty,amount,shipment_ids,items_text,pdf_url,paid,paid_day,' +
                       'created_by,comment,sheet_row,created_at';
  const B2B_SRC = [
    { key: 'clients',   table: 'b2b_clients',    paged: true, order: ['sheet_row', 'id'], what: 'Партнёры', alive: true },
    { key: 'shipments', table: 'b2b_shipments',  paged: true, order: ['sheet_row', 'id'], what: 'Поставки', alive: true },
    { key: 'payments',  table: 'b2b_payments',   paged: true, order: ['sheet_row', 'id'], what: 'Оплаты', alive: true },
    { key: 'visits',    table: 'b2b_visits',     paged: true, order: ['sheet_row', 'id'], what: 'Визиты', alive: true,
      select: 'id,day,client_id,result,potential,next_day,contact,phone,rep,comment,files' },
    { key: 'items',     table: 'b2b_ship_items', paged: true, order: ['sheet_row', 'id'], what: 'Позиции поставок', alive: true },
    { key: 'payItems',  table: 'b2b_pay_items',  paged: true, order: ['sheet_row', 'id'], what: 'Позиции оплат', alive: true },
    { key: 'branches',  table: 'b2b_branches',   paged: true, order: ['sheet_row', 'id'], what: 'Филиалы', alive: true },
    // Снимок документа (snapshot, sql/32) — не в списке: он нужен, только когда просят PDF.
    { key: 'docs',      table: 'b2b_docs',       paged: true, order: ['sheet_row', 'id'], what: 'Документы', alive: true,
      select: B2B_DOC_COLS + ',updated_at,has_snapshot', legacy: B2B_DOC_COLS,
      legacyNote: 'файла sql/32 в базе нет — список без PDF, новые счета и накладные не выписать. Выполните sql/32_b2b_docs.sql, затем sql/12_auth.sql.' },
    { key: 'rounds',    table: 'b2b_rounds',     paged: true, order: ['sheet_row', 'id'], what: 'Обходы', alive: true },
    // Товары для форм — «Номенклатура» (как выбирает торгпред); нет её — список мобильного.
    { key: 'nomen',     table: 'b2b_nomen',      paged: false, order: ['sheet_row', 'app_name'], what: 'Номенклатура' },
    // Довесок (салфетки в пачках по 1 ₸) и граница накладных — sql/32 от 10.10.2026.
    // optional: нет их (страница новее базы) — форма без довеска, документы без
    // границы, и это не авария экрана.
    { key: 'bundles',   table: 'v_b2b_bundle_rules', paged: false, order: ['product', 'bundle'], what: 'Довески', optional: true },
    { key: 'docset',    table: 'b2b_doc_settings', paged: false, order: ['id'], what: 'Реквизиты', optional: true,
      select: 'waybills_from,bundle_price,auto_waybill' }
  ];
  const B2B_CORE = ['clients', 'shipments', 'payments'];   // без них экрану показать нечего
  const B2B_STATUS = { table: 'v_b2b_status', what: 'Перенос B2B' };
  const GROUP_SUB = { day: 'по дням', week: 'по неделям', decade: 'по декадам', month: 'по месяцам' };

  // Снимок старше этого — предупреждение на экране. Тот же порог, что у
  // snap_health() в гейте опросника: pg_cron пропустил четыре запуска подряд.
  const STALE_MIN = 45;

  // ── Ключ: публичный — да, секретный — никогда ────────────────────────────
  function b64url(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return root.atob(s);
  }
  function keyProblem(key) {
    const k = String(key || '').trim();
    if (!k) return 'empty';
    if (/^sb_secret_/i.test(k)) return 'secret';
    if (/^eyJ/.test(k)) {
      try {
        const payload = JSON.parse(b64url(k.split('.')[1] || ''));
        if (payload && payload.role === 'service_role') return 'secret';
      } catch (e) { /* не разобрали — решит Supabase */ }
    }
    return null;
  }

  // ── Ошибки человеческим языком ────────────────────────────────────────────
  function humanError(err, what) {
    const msg = String((err && (err.message || err.error_description)) || err || '');
    const code = String((err && err.code) || '');
    const pre = what ? what + ': ' : '';
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg))
      return 'Нет связи с базой. Проверьте интернет и нажмите «Обновить».';
    if (code === '57014' || /statement timeout|canceling statement/i.test(msg))
      return pre + 'база не успела ответить (тайм-аут). Обновите через минуту.';
    if (code === '42501' || /permission denied/i.test(msg))
      return pre + 'нет прав на чтение — прогоните sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_overview|v_overview/.test(msg))
      return pre + 'снимка «Обзора» в базе нет — выполните sql/16_overview.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_kaspi|v_kaspi/.test(msg))
      return pre + 'снимка экрана Kaspi в базе нет — выполните sql/19_kaspi.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_ozon|v_ozon/.test(msg))
      return pre + 'снимка экрана Ozon в базе нет — выполните sql/20_ozon_screen.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_an_|v_an_/.test(msg))
      return pre + 'снимка экрана «Аналитика» в базе нет — выполните sql/21_analytics.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /v_stock_arrivals|v_stock_pending|stock_arrivals|stock_writeoffs/.test(msg))
      return pre + 'журналов форм в базе нет — выполните sql/00_tables.sql, 22, 23 и 26, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /v_mp_stock|mp_stock_r/.test(msg))
      return pre + 'остатков площадок в базе нет — выполните sql/25_mp_stocks.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_stock_recon|v_stock_recon/.test(msg))
      return pre + 'снимка сверки склада в базе нет — выполните sql/24_stock_recon.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_stock|v_stock/.test(msg))
      return pre + 'снимка экрана «Склад» в базе нет — выполните sql/22_inventory_old.sql и sql/23_stock_screen.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_client_retention|v_client_retention/.test(msg))
      return pre + 'снимка удержания в базе нет — выполните sql/27_client_retention.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_client_month_mix|v_client_month_mix/.test(msg))
      return pre + 'снимка разбора месяца в базе нет — выполните sql/29_client_months.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_client_ltv_curve|v_client_ltv_curve/.test(msg))
      return pre + 'снимка LTV по месяцам в базе нет — выполните sql/29_client_months.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_client_summary|v_client_summary/.test(msg))
      return pre + 'снимка «Главное о клиентах» в базе нет — выполните sql/30_client_summary.sql, затем sql/12_auth.sql.';
    // Раньше ветки «данных B2B нет»: «column b2b_docs.… does not exist» — это не прогнанный 32, а не 28.
    if ((code === '42703' || /column .* does not exist/i.test(msg)) && /b2b_doc/.test(msg))
      return pre + 'новых колонок документов в базе нет — выполните sql/32_b2b_docs.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /b2b_/.test(msg))
      return pre + 'данных B2B в базе нет — выполните sql/00_tables.sql, 01_functions.sql и 28_b2b.sql, затем sql/12_auth.sql.';
    if ((code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg)) &&
        /snap_/.test(msg))
      return pre + 'снимка в базе нет — выполните sql/15_snapshots.sql, затем sql/12_auth.sql.';
    if (code === 'PGRST205' || code === '42P01' || /does not exist|could not find the (table|relation)/i.test(msg))
      return pre + 'такой витрины в базе нет — прогоните файлы по sql/README.md.';
    if (/invalid login credentials/i.test(msg)) return 'Неверный email или пароль.';
    if (/email not confirmed/i.test(msg))
      return 'Email не подтверждён: Supabase → Authentication → Users → подтвердите пользователя.';
    if (/jwt expired|invalid jwt/i.test(msg) || /^PGRST30/.test(code)) return 'Сессия истекла — войдите заново.';
    return pre + (msg || 'неизвестная ошибка');
  }

  // ── Чтение витрин ─────────────────────────────────────────────────────────
  async function fetchAll(client, src) {
    const out = [];
    for (let from = 0, guard = 0; guard < 50; guard++) {
      const q = ordered(alive(client.from(src.table).select(src.select || '*'), src), src.order);
      const res = await q.range(from, from + PAGE - 1);
      if (res.error) throw res.error;
      const rows = res.data || [];
      // Конец — только пустая страница. Короткая страница концом не считается:
      // лимит строк проекта может быть меньше PAGE, и тогда «короткая» — это
      // просто весь лимит, а за ней есть ещё.
      if (!rows.length) return out;
      out.push.apply(out, rows);
      from += rows.length;
    }
    throw new Error(src.table + ': больше 50 страниц — проверьте сортировку');
  }

  // Мягко удалённые строки (deleted_at) — мимо: удалённое должно пропасть с экрана.
  function alive(q, src) { return src.alive ? q.is('deleted_at', null) : q; }

  function ordered(q, order) {
    [].concat(order || []).forEach(col => { q = q.order(col, { ascending: true }); });
    return q;
  }

  async function fetchSmall(client, src) {
    const res = await ordered(alive(client.from(src.table).select(src.select || '*'), src), src.order);
    if (res.error) throw res.error;
    return res.data || [];
  }

  // Свежесть — справочно: её сбой не должен гасить экран, поэтому не бросает.
  // snapAt — время САМОГО СТАРОГО снимка: цифры на экране не свежее него.
  async function fetchSnapState(client) {
    const out = { snapAt: null, snapNever: false };
    try {
      const res = await client.from('snap_state').select('snap,refreshed_at');
      if (!res.error && res.data && res.data.length) {
        out.snapNever = res.data.some(r => !r.refreshed_at);
        const t = res.data.filter(r => r.refreshed_at).map(r => new Date(r.refreshed_at))
                          .filter(d => !isNaN(d));
        if (t.length) out.snapAt = new Date(Math.min.apply(null, t));
      }
    } catch (e) { /* справочно */ }
    return out;
  }

  async function fetchFreshness(client) {
    const out = { synced: null };
    try {
      const res = await client.from('sync_log').select('synced_at')
                              .order('synced_at', { ascending: false }).limit(1);
      if (!res.error && res.data && res.data.length) out.synced = res.data[0].synced_at;
    } catch (e) { /* справочно */ }
    return Object.assign(out, await fetchSnapState(client));
  }

  async function loadAll(client) {
    const freshP = fetchFreshness(client);
    const results = await Promise.allSettled(
      SOURCES.map(s => (s.paged ? fetchAll : fetchSmall)(client, s)));
    const data = {}, errors = {};
    SOURCES.forEach((s, i) => {
      const r = results[i];
      if (r.status === 'fulfilled') data[s.key] = r.value;
      else { data[s.key] = []; errors[s.key] = humanError(r.reason, s.what); }
    });
    const fresh = await freshP;
    return { data, errors, synced: fresh.synced, snapAt: fresh.snapAt, snapNever: fresh.snapNever };
  }

  // «Обзор» с 14.10.2026 — четыре квадранта: кроме выручки по дням ему нужны
  // пары «клиент × день» Kaspi (квадрант C) и остаток склада с площадками
  // (D). Те же снимки, что у экранов Kaspi и «Склад»; упал один — его
  // квадрант показывает причину, остальной экран работает.
  async function loadOverview(client) {
    const snapP = fetchSnapState(client);
    const [daily, gaps, fresh, cdays, stock, mp] = await Promise.allSettled([
      fetchAll(client, OV_DAILY), fetchSmall(client, OV_GAPS), fetchSmall(client, OV_FRESH),
      fetchAll(client, KP_CLIENTS), fetchSmall(client, ST_STOCK), fetchSmall(client, ST_MP)]);
    const snap = await snapP;
    const val = r => (r.status === 'fulfilled' ? r.value : []);
    const err = (r, src) => (r.status === 'rejected' ? humanError(r.reason, src.what) : null);
    return {
      rows: val(daily), gaps: val(gaps), fresh: val(fresh)[0] || {},
      clientDays: val(cdays), idx: null, stock: val(stock), mp: mp.status === 'fulfilled' ? mp.value : null,
      errors: { daily: err(daily, OV_DAILY), gaps: err(gaps, OV_GAPS), clients: err(cdays, KP_CLIENTS),
                stock: err(stock, ST_STOCK), mp: err(mp, ST_MP) },
      snapAt: snap.snapAt, snapNever: snap.snapNever, loadedAt: new Date()
    };
  }

  // Каждый снимок — отдельно: упал один, его раздел показывает причину, а
  // остальные работают. Без дней экрану показать нечего — это ошибка экрана.
  async function loadKaspi(client) {
    const snapP = fetchSnapState(client);
    const [daily, cdays, now, remote, fresh] = await Promise.allSettled([
      fetchAll(client, KP_DAILY), fetchAll(client, KP_CLIENTS), fetchSmall(client, KP_NOW),
      fetchSmall(client, KP_REMOTE), fetchSmall(client, OV_FRESH)]);
    const snap = await snapP;
    const val = r => (r.status === 'fulfilled' ? r.value : []);
    const err = (r, src) => (r.status === 'rejected' ? humanError(r.reason, src.what) : null);
    return {
      rows: val(daily), clientDays: val(cdays), now: val(now)[0] || null, remote: val(remote),
      fresh: val(fresh)[0] || {}, idx: null,
      errors: { daily: err(daily, KP_DAILY), clients: err(cdays, KP_CLIENTS), now: err(now, KP_NOW),
                remote: err(remote, KP_REMOTE) },
      snapAt: snap.snapAt, snapNever: snap.snapNever, loadedAt: new Date()
    };
  }

  async function loadOzon(client) {
    const snapP = fetchSnapState(client);
    const [daily, skus, errs, now] = await Promise.allSettled([
      fetchAll(client, OZ_DAILY), fetchAll(client, OZ_SKU), fetchAll(client, OZ_ERRORS), fetchSmall(client, OZ_NOW)]);
    const snap = await snapP;
    const val = r => (r.status === 'fulfilled' ? r.value : []);
    const err = (r, src) => (r.status === 'rejected' ? humanError(r.reason, src.what) : null);
    return {
      rows: val(daily), skus: val(skus), errorsList: val(errs), now: val(now)[0] || null,
      errors: { daily: err(daily, OZ_DAILY), skus: err(skus, OZ_SKU), list: err(errs, OZ_ERRORS), now: err(now, OZ_NOW) },
      snapAt: snap.snapAt, snapNever: snap.snapNever, loadedAt: new Date()
    };
  }

  async function loadAnalytics(client) {
    const snapP = fetchSnapState(client);
    const [demand, skus, cities, delivery, fresh] = await Promise.allSettled([
      fetchAll(client, AN_DEMAND), fetchAll(client, AN_SKU), fetchAll(client, AN_CITY), fetchAll(client, AN_DELIVERY),
      fetchSmall(client, OV_FRESH)]);
    const snap = await snapP;
    const val = r => (r.status === 'fulfilled' ? r.value : []);
    const err = (r, src) => (r.status === 'rejected' ? humanError(r.reason, src.what) : null);
    return {
      rows: val(demand), skus: val(skus), cities: val(cities), delivery: val(delivery), fresh: val(fresh)[0] || {},
      errors: { daily: err(demand, AN_DEMAND), skus: err(skus, AN_SKU), cities: err(cities, AN_CITY),
                delivery: err(delivery, AN_DELIVERY) },
      snapAt: snap.snapAt, snapNever: snap.snapNever, loadedAt: new Date()
    };
  }

  async function loadStock(client) {
    const snapP = fetchSnapState(client);
    // Право записи: нет функции (26 и 12 не прогнаны) или нет права — форм
    // не показываем, остальной экран работает.
    const writerP = Promise.resolve().then(() => client.rpc('is_app_writer'))
      .then(res => !res.error && res.data === true, () => false);
    const [stock, woffs, fresh, recon, mp, arrs, pending] = await Promise.allSettled([
      fetchSmall(client, ST_STOCK), fetchSmall(client, ST_WOFF), fetchSmall(client, ST_FRESH), fetchSmall(client, ST_RECON),
      fetchSmall(client, ST_MP), fetchSmall(client, ST_ARR), fetchSmall(client, ST_PEND)]);
    const snap = await snapP;
    const canWrite = await writerP;
    const val = r => (r.status === 'fulfilled' ? r.value : []);
    const err = (r, src) => (r.status === 'rejected' ? humanError(r.reason, src.what) : null);
    return {
      rows: val(stock), woffs: woffs.status === 'fulfilled' ? woffs.value : null, fresh: val(fresh)[0] || {},
      recon: recon.status === 'fulfilled' ? recon.value : null,
      mp: mp.status === 'fulfilled' ? mp.value : null,
      arrs: arrs.status === 'fulfilled' ? arrs.value : null,
      pending: val(pending), canWrite,
      errors: { stock: err(stock, ST_STOCK), woff: err(woffs, ST_WOFF), recon: err(recon, ST_RECON), mp: err(mp, ST_MP),
                arr: err(arrs, ST_ARR) },
      snapAt: snap.snapAt, snapNever: snap.snapNever, loadedAt: new Date()
    };
  }

  // Нет колонки (страница новее базы): Postgres отвечает 42703 «column … does not exist».
  const noColumn = e => String((e && e.code) || '') === '42703' || /column .* does not exist/i.test(String((e && e.message) || ''));

  async function loadB2b(client) {
    const get = s => (s.paged ? fetchAll : fetchSmall)(client, s);
    const res = await Promise.allSettled(B2B_SRC.map(s => get(s).catch(e => {
      if (!s.legacy || !noColumn(e)) throw e;
      return get(Object.assign({}, s, { select: s.legacy })).then(rows => ({ legacy: rows }));
    })).concat([fetchSmall(client, B2B_STATUS)]));
    const data = {}, errors = {};
    B2B_SRC.forEach((s, i) => {
      const r = res[i];
      if (r.status !== 'fulfilled' && s.optional) data[s.key] = [];
      else if (r.status !== 'fulfilled') { data[s.key] = []; errors[s.key] = humanError(r.reason, s.what); }
      else if (Array.isArray(r.value)) data[s.key] = r.value;
      else { data[s.key] = r.value.legacy; errors[s.key] = s.what + ': ' + s.legacyNote; }
    });
    const st = res[B2B_SRC.length];
    return { data, errors, status: st.status === 'fulfilled' ? (st.value[0] || {}) : {}, loadedAt: new Date() };
  }

  // Застывший снимок по виду неотличим от «новых заказов не было». Поэтому
  // возраст снимка говорится словами, а не только временем в строке свежести.
  function staleNote(app) {   // app — любой носитель { snapAt, snapNever, loadedAt }
    if (app.snapNever) {
      return 'Снимки ещё ни разу не считались — цифры неполные. Supabase → SQL Editor: select refresh_client_snapshots();';
    }
    if (!app.snapAt || !app.loadedAt) return '';
    const min = Math.round((app.loadedAt - app.snapAt) / 60000);
    if (min <= STALE_MIN) return '';
    const age = min < 120 ? min + ' мин' : Math.round(min / 60) + ' ч';
    return 'Цифры могут быть устаревшими: снимок не обновлялся ' + age +
           '. Проверьте pg_cron: Supabase → Integrations → Cron.';
  }

  // ── Разметка состояний ────────────────────────────────────────────────────
  function hhmm(v) {
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d)) return '—';
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // id="screenBody" — тело экрана под полосой фильтров. Смена своих дат
  // перерисовывает только его: поля дат живут в полосе и остаются теми же
  // элементами, курсор из них не выпадает.
  function page(inner, cls) { return '<div class="page' + (cls ? ' ' + cls : '') + '" id="screenBody">' + inner + '</div>'; }

  // ── Каркас экрана (14.10.2026, по референсу) ───────────────────────────────
  // Слева — боковое меню экранов. Справа от него: верхняя белая панель
  // (фильтры экрана слева, «Обновить» и вход справа) → заголовок экрана и
  // свежесть данных → лента KPI → четыре квадранта A B / C D → подробности
  // ниже. Правая колонка — сигналы, инсайты и быстрые действия экрана, всё из
  // уже загруженных данных. На компьютере квадранты — сетка 2×2 на высоту окна,
  // длинное листается внутри квадранта, ⤢ разворачивает квадрант во всю
  // ширину; уже 1280 px правая колонка уходит под экран, на телефоне меню —
  // полоса сверху, всё — одним столбцом.
  const ROUTE_META = {
    overview:  { icon: '📊', title: 'Обзор бизнеса', sub: 'все каналы продаж · выручка, клиенты, склад' },
    kaspi:     { icon: '🔵', title: 'Kaspi', sub: 'продажи, прибыль и клиенты Kaspi' },
    ozon:      { icon: '🟠', title: 'Ozon', sub: 'продажи, деньги и ошибки продавца' },
    analytics: { icon: '📈', title: 'Аналитика заказов', sub: 'спрос по дню заказа: исходы, товары, города' },
    clients:   { icon: '👥', title: 'Клиенты и удержание', sub: 'только Kaspi · опознанные по имени и городу' },
    stock:     { icon: '📦', title: 'Склад и запасы', sub: 'остаток на сейчас · период не влияет' },
    b2b:       { icon: '🤝', title: 'B2B · аптеки и магазины', sub: 'поставки, оплаты, долги и контакты' }
  };

  // o: tools — фильтры в верхнюю панель, fresh — строка свежести, body —
  // тело экрана, title/sub — свой заголовок, rail: false — без правой колонки.
  function frame(app, o) {
    const m = ROUTE_META[app.route] || {}, title = o.title || m.title || '', sub = o.sub !== undefined ? o.sub : m.sub;
    const rail = o.rail !== false;
    return '<div class="shell">' + sideHtml(app) +
      '<div class="main">' + topHtml(app, o.tools) +
        '<div class="workspace' + (rail ? '' : ' no-rail') + '">' +
          '<div class="ws-main">' +
            '<div class="page-head"><div class="ph-titles"><h1>' +
              (m.icon ? '<span class="ph-ico" aria-hidden="true">' + m.icon + '</span>' : '') + C.esc(title) + '</h1>' +
              (sub ? '<p class="ph-sub muted">' + C.esc(sub) + '</p>' : '') + '</div>' +
              (o.fresh ? '<div class="ph-meta">' + o.fresh + '</div>' : '') + '</div>' +
            page(o.body || '') +
          '</div>' +
          (rail ? '<aside class="rail" id="screenRail" aria-label="Сигналы, инсайты и быстрые действия">' + railInner(app) + '</aside>' : '') +
        '</div></div></div>';
  }
  function quad(a, b, c, d) { return '<div class="quad">' + a + b + c + d + '</div>'; }
  function below(inner) { return '<div class="below">' + inner + '</div>'; }
  // Ссылка из квадранта на свой экран: та же кнопка, что у вкладки.
  function qpLink(route, label) {
    return '<button type="button" class="qp-link" data-action="route" data-route="' + route + '">' + C.esc(label) +
      ' <span aria-hidden="true">→</span></button>';
  }
  // Коробка графика: её ширину (и высоту — в квадранте) меряет fitCharts.
  function chartBox(id, html) { return '<div class="chart-box" id="' + id + 'Box">' + html + '</div>'; }

  // Свежесть: строка — в полосу фильтров, предупреждения — в начало экрана.
  function freshParts(bits, notes) {
    const txt = bits.filter(Boolean).join(' · ');
    return {
      line: '<div class="fresh muted">' + C.esc(txt.charAt(0).toUpperCase() + txt.slice(1)) + '</div>',
      notes: (notes || []).filter(Boolean).map(n => '<div class="stale" role="status">' + C.esc(n) + '</div>').join('')
    };
  }

  function messageHtml(title, body, actions) {
    return page('<section class="card message" role="alert"><h1>' + C.esc(title) + '</h1>' + body +
                (actions || '') + '</section>');
  }

  function loginHtml(errorText, email) {
    return page(
      '<section class="card login"><div class="login-mark" aria-hidden="true"></div><h1>NIETTE</h1><p class="muted">Analytics · выручка и клиенты</p>' +
      '<form id="loginForm" novalidate>' +
        '<label for="loginEmail">Email</label>' +
        '<input id="loginEmail" name="email" type="email" autocomplete="username" required value="' + C.esc(email || '') + '">' +
        '<label for="loginPassword">Пароль</label>' +
        '<input id="loginPassword" name="password" type="password" autocomplete="current-password" required>' +
        '<button type="submit" class="primary">Войти</button>' +
        '<div id="loginError" class="error"' + (errorText ? ' role="alert">' + C.esc(errorText) : ' hidden>') + '</div>' +
      '</form></section>', 'page-login');
  }

  // sec — раздел app_users.sections, которому принадлежит экран (sql/12_auth.sql):
  // 'all' — всё, что не отнесено к разделу; его видят только NULL и {all}.
  const ROUTES = [{ key: 'overview', label: 'Обзор', sec: 'all' }, { key: 'kaspi', label: 'Kaspi', sec: 'all' },
                  { key: 'ozon', label: 'Ozon', sec: 'all' }, { key: 'analytics', label: 'Аналитика', sec: 'all' },
                  { key: 'clients', label: 'Клиенты', sec: 'all' }, { key: 'stock', label: 'Склад', sec: 'all' },
                  { key: 'b2b', label: 'B2B', sec: 'b2b' }];
  const FULL_ME = { allowed: true, full: true, sections: ['all'], can_write: false };

  // Пока допуск не проверен (app.me нет), не открыто ничего: все вкладки —
  // только явным решением afterLogin (FULL_ME, когда app_me в базе нет).
  function meSees(app, sec) {   // sections — всегда список: так его кладёт afterLogin
    const me = app.me;
    return !!me && (me.full === true || me.sections.indexOf(sec) >= 0);
  }
  function routesFor(app) { return ROUTES.filter(r => meSees(app, r.sec)); }
  function setHash(r) {
    try { if (root.history && root.history.replaceState) root.history.replaceState(null, '', '#' + r); } catch (e) { /* неважно */ }
  }

  // Боковое меню: знак и экраны. Значок экрана рисует CSS (по data-route):
  // у кнопки остаётся одно имя экрана — его читает и экранный диктор.
  function sideHtml(app) {
    const tabs = routesFor(app).map(r => '<button type="button" class="tab' + (app.route === r.key ? ' on' : '') +
      '" data-action="route" data-route="' + r.key + '" title="' + C.esc(r.label) + '"' +
      (app.route === r.key ? ' aria-current="page"' : '') + '>' + C.esc(r.label) + '</button>').join('');
    return '<aside class="side">' +
      '<div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">NIETTE</span>' +
        '<span class="brand-sub" aria-hidden="true">Analytics</span></div>' +
      '<nav class="tabs" aria-label="Экраны">' + tabs + '</nav>' +
      '<div class="side-foot">' + (email(app) ? '<span class="who-am-i" title="Вы вошли как">' + C.esc(email(app)) + '</span>' : '') +
        '<button type="button" data-action="logout" class="ghost">Выйти</button></div></aside>';
  }
  function email(app) { return app.session && app.session.user ? app.session.user.email : ''; }
  // Верхняя панель: фильтры экрана слева, «Обновить» справа. На телефоне
  // низа меню нет — «Выйти» здесь же.
  function topHtml(app, tools) {
    return '<header class="top"><div class="top-inner">' +
      '<div class="top-tools">' + (tools || '') + '</div>' +
      '<div class="top-actions">' +
        '<button type="button" data-action="refresh">Обновить</button>' +
        '<button type="button" data-action="logout" class="ghost top-logout">Выйти</button>' +
      '</div></div></header>';
  }

  // opts.qp — квадрант: шапка со значком, ссылкой на экран (opts.tools) и
  // кнопкой ⤢, тело листается внутри (на компьютере). opts.fill — тело
  // растягивает график на всю свободную высоту. opts.app — чтобы помнить
  // развёрнутый квадрант между перерисовками.
  function section(id, title, sub, inner, opts) {
    const o = opts || {};
    const ico = o.icon ? '<span class="qp-ico" aria-hidden="true">' + o.icon + '</span>' : '';
    if (!o.qp) {
      return '<section class="card' + (o.cls ? ' ' + o.cls : '') + '" id="' + id + '" aria-labelledby="' + id + 'Title">' +
        '<div class="card-head"><h2 id="' + id + 'Title">' + ico + C.esc(title) + '</h2>' +
        (sub ? '<div class="card-sub">' + sub + '</div>' : '') + '</div>' + inner + '</section>';
    }
    const max = !!(o.app && o.app.qpMax && o.app.qpMax[o.app.route] === id);
    return '<section class="card qp' + (max ? ' qp-max' : '') + (o.cls ? ' ' + o.cls : '') + '" id="' + id + '" aria-labelledby="' + id + 'Title">' +
      '<div class="card-head qp-head"><div class="qp-titles"><h2 id="' + id + 'Title">' + ico + C.esc(title) + '</h2>' +
        (sub ? '<div class="card-sub">' + sub + '</div>' : '') + '</div>' +
        '<div class="qp-tools">' + (o.tools || '') +
          '<button type="button" class="qp-max-btn" data-action="qp-max" data-id="' + id + '" aria-pressed="' + max + '"' +
            ' title="' + (max ? 'Свернуть' : 'Развернуть во всю ширину') + '"><span aria-hidden="true">' + (max ? '⤡' : '⤢') + '</span>' +
            '<span class="sr-only">' + (max ? 'Свернуть' : 'Развернуть') + ' «' + C.esc(title) + '»</span></button>' +
        '</div></div>' +
      '<div class="qp-body' + (o.fill ? ' qp-fill' : '') + '">' + inner + '</div></section>';
  }
  function panel(app, id, icon, title, sub, inner, more) {
    return section(id, title, sub, inner, Object.assign({ qp: true, app, icon }, more || {}));
  }

  function or(errors, key, render) { return errors[key] ? C.sectionError(errors[key]) : render(); }

  function riskToolbar(app) {
    const d = app.data;
    const level = app.ui.riskLevel;
    const n = lvl => d.risk.filter(r => r.risk === lvl).length;
    const btn = (lvl, label) => '<button type="button" data-action="risk-level" data-level="' + lvl + '"' +
      ' aria-pressed="' + (level === lvl) + '" class="seg' + (level === lvl ? ' on' : '') + '">' +
      label + ' · ' + C.int(n(lvl)) + '</button>';
    return '<div class="toolbar" role="group" aria-label="Уровень риска">' +
      btn('высокий', 'Высокий') + btn('средний', 'Средний') + '</div>';
  }

  // Удержание: «купили в месяце» или «подряд», все новые или по первой
  // покупке — всё из загруженных строк, в базу не ходим. Нет снимка разреза
  // (27 не прогнан заново) — переключателя первой покупки нет, общая таблица
  // работает как раньше.
  function retentionSection(app) {
    const m = app.ui.retMode, d = app.data, e = app.errors;
    const seg = (action, attr, val, on, label) => '<button type="button" data-action="' + action + '" ' + attr + '="' + val + '"' +
      ' aria-pressed="' + on + '" class="seg' + (on ? ' on' : '') + '">' + C.esc(label) + '</button>';
    const byEntry = !e.retentionEntry && (d.retentionEntry || []).length > 0;
    const ent = byEntry && C.RET_ENTRIES[app.ui.retEntry] ? app.ui.retEntry : 'all';
    const entryBar = byEntry
      ? '<div class="toolbar" role="group" aria-label="Первая покупка"><span class="toolbar-label">Первая покупка:</span>' +
        Object.keys(C.RET_ENTRIES).map(k => seg('ret-entry', 'data-entry', k, ent === k, C.RET_ENTRIES[k])).join('') + '</div>'
      : (e.retentionEntry ? '<p class="note">Разрез по первой покупке недоступен. ' + C.esc(e.retentionEntry) + '</p>' : '');
    const render = () => {
      if (ent === 'all') return C.renderRetention(d.retention, m, { entry: 'all' });
      const totals = {};
      (d.retention || []).forEach(r => { if (Number(r.k) === 0) totals[String(r.cohort).slice(0, 7)] = Number(r.new_clients); });
      return C.renderRetention(d.retentionEntry.filter(r => r.entry === ent), m, { entry: ent, totals });
    };
    return panel(app, 'retention', '🔁', 'Удержание по месяцам', 'Новые клиенты месяца — сколько из них купили в следующие месяцы',
      or(e, 'retention', () =>
        '<div class="toolbar" role="group" aria-label="Как считать месяцы">' +
          seg('ret-mode', 'data-mode', 'any', m === 'any', C.RET_MODES.any) +
          seg('ret-mode', 'data-mode', 'streak', m === 'streak', C.RET_MODES.streak) + '</div>' +
        entryBar + render()));
  }

  // LTV по месяцам жизни (sql/29): что считать (прибыль / выручка / пачки) и
  // разрез (все / пачка или мини-пак / размер первой покупки) — из загруженных
  // строк, переключение в базу не ходит.
  function ltvSection(app) {
    const d = app.data, e = app.errors;
    const seg = (action, attr, val, on, label) => '<button type="button" data-action="' + action + '" ' + attr + '="' + val + '"' +
      ' aria-pressed="' + on + '" class="seg' + (on ? ' on' : '') + '">' + C.esc(label) + '</button>';
    const metric = C.LTV_METRICS[app.ui.ltvMetric] ? app.ui.ltvMetric : 'profit';
    const dim = C.LTV_DIMS[app.ui.ltvDim] ? app.ui.ltvDim : 'all';
    return section('ltv', 'LTV по месяцам жизни', 'Сколько в среднем приносит один новый клиент к концу каждого месяца',
      or(e, 'ltvCurve', () =>
        '<div class="toolbar" role="group" aria-label="Что считать"><span class="toolbar-label">Считать:</span>' +
          Object.keys(C.LTV_METRICS).map(k => seg('ltv-metric', 'data-metric', k, metric === k, C.LTV_METRICS[k])).join('') + '</div>' +
        '<div class="toolbar" role="group" aria-label="Разрез"><span class="toolbar-label">Разрез:</span>' +
          Object.keys(C.LTV_DIMS).map(k => seg('ltv-dim', 'data-dim', k, dim === k, C.LTV_DIMS[k])).join('') + '</div>' +
        C.renderLtvCurve(d.ltvCurve, { dim, metric })), { icon: '📈' });
  }

  // Главное о клиентах (sql/30) — первый блок экрана. Месяц (новые и
  // повторные) — из разбора месяца (sql/29); по умолчанию последний закрытый:
  // у идущего числа ещё растут. Группа и месяц переключаются из памяти, в базу
  // не ходят; поле CAC перерисовывает только таблицу окупаемости.
  function summarySection(app) {
    const d = app.data, e = app.errors;
    const mix = !e.monthMix && (d.monthMix || []).length ? C.monthMix(d.monthMix) : [];
    const months = mix.map(m => m.month);
    const closed = mix.filter(m => m.complete).map(m => m.month);
    const sel = months.indexOf(app.ui.sumMonth) >= 0 ? app.ui.sumMonth : (closed[closed.length - 1] || months[months.length - 1]);
    return panel(app, 'summary', '⭐', 'Главное о клиентах', 'Только Kaspi · новые клиенты считаются по дням от их первой покупки',
      or(e, 'summary', () => C.renderSummary(d.summary, { grp: app.ui.sumGrp, month: sel, mix, cac: app.ui.sumCac })));
  }

  // Новые и вернувшиеся по месяцам + разбор месяца по клику (sql/29): кто в
  // нём покупал — новые, быстрый повтор, вернулись из … Всё из загруженных
  // строк, в базу клик не ходит. Нет снимка разбора (29 не прогнан) — таблица
  // как раньше, месяцы не кликаются, под ней сказано, какой файл прогнать.
  function monthlySection(app) {
    const d = app.data, e = app.errors;
    const mixOk = !e.monthMix && (d.monthMix || []).length > 0;
    const months = mixOk ? C.monthMix(d.monthMix).map(m => m.month) : [];
    const sel = months.indexOf(app.ui.mixMonth) >= 0 ? app.ui.mixMonth : months[months.length - 1];
    const row = (d.monthly || []).find(r => C.monthKey(r.month) === sel) || null;
    const mixHtml = mixOk
      ? '<div class="mix" id="mixBody">' + C.renderMonthMix(d.monthMix, sel, { monthly: row }) + '</div>'
      : (e.monthMix ? '<p class="note">Разбор месяца недоступен. ' + C.esc(e.monthMix) + '</p>' : '');
    return panel(app, 'monthly', '📆', 'Новые и вернувшиеся по месяцам', mixOk ? 'Нажмите на месяц — кто в нём покупал' : '',
      or(e, 'monthly', () => C.renderMonthly(d.monthly, { months, selected: sel })) + mixHtml);
  }

  function riskSection(app) {
    return panel(app, 'risk', '⚠️', 'Риск оттока', 'Давно не заказывал по меркам этого клиента · самые ценные сверху',
      or(app.errors, 'risk', () => riskToolbar(app) + '<div id="riskBody">' + riskBodyHtml(app) + '</div>'));
  }

  function riskBodyHtml(app) {
    return C.renderRisk(app.data.risk, app.ui.riskLevel, app.ui.riskAll ? Infinity : RISK_STEP);
  }

  function baseToolbar(app) {
    const opts = Object.keys(C.SORTS).map(k =>
      '<option value="' + k + '"' + (k === app.ui.baseSort ? ' selected' : '') + '>' + C.esc(C.SORTS[k].label) + '</option>').join('');
    return '<div class="toolbar">' +
      '<label class="sr-only" for="baseSearch">Поиск по имени и городу</label>' +
      '<input id="baseSearch" type="search" placeholder="Имя или город" value="' + C.esc(app.ui.baseQuery) + '">' +
      '<label class="sr-only" for="baseSort">Сортировка</label>' +
      '<select id="baseSort">' + opts + '</select></div>';
  }

  function baseBodyHtml(app) {
    const rows = C.filterBase(app.data.base, app.ui.baseQuery, app.ui.baseSort);
    return '<div class="count muted">' + (app.ui.baseQuery ? 'Нашлось ' : 'Всего ') + C.int(rows.length) + '</div>' +
      C.renderBaseTable(rows, app.riskByKey, app.ui.baseLimit);
  }

  function screenHtml(app) {
    const d = app.data, e = app.errors;
    const k = C.computeKpis(d.base, d.repeat, d.risk);
    // Упала витрина — в сводке прочерк, а не «0 в риске»: ноль тут был бы
    // выдумкой, а не данными.
    if (e.risk) { k.high = null; k.mid = null; }
    if (e.repeat) k.medianDays = null;
    // «Данные на» — время снимка: это и есть момент, на который верны цифры.
    const f = freshParts([app.snapAt ? 'Данные на ' + hhmm(app.snapAt) : '',
                          app.synced ? 'зеркало Apps Script обновлено ' + hhmm(app.synced) : '',
                          'загружено ' + hhmm(app.loadedAt)], [staleNote(app)]);
    // Квадранты: A — главное, B — кто покупал по месяцам, C — удержание,
    // D — риск оттока; когорты, LTV, время до второго заказа и база — ниже.
    return frame(app, { fresh: f.line, body:
      f.notes +
      (e.base ? C.sectionError(e.base) : '<div class="ribbon-kpis">' + C.renderKpis(k) + '</div>') +
      quad(summarySection(app), monthlySection(app), retentionSection(app), riskSection(app)) +
      below(
        section('cohorts', 'Когорты: LTV и окупаемость', 'Когорта — месяц первого заказа · CAC только Meta',
                or(e, 'ltv', () => C.renderCohorts(d.ltv)), { icon: '💵' }) +
        ltvSection(app) +
        '<div class="two">' +
          section('repeat', 'Время до второго заказа', '', or(e, 'repeat', () => C.renderRepeat(d.repeat)), { icon: '⏱' }) +
          section('entry', 'Вход через мини-пак', 'С чего начал клиент',
                  or(e, 'entry', () => C.renderEntry(d.entry)), { icon: '🚪' }) +
        '</div>' +
        section('base', 'База клиентов', 'Клиент = имя + фамилия + город · только выданные заказы Kaspi',
                or(e, 'base', () => baseToolbar(app) + '<div id="baseBody">' + baseBodyHtml(app) + '</div>'), { icon: '🗂' }) +
        section('notes', 'Как читать эти числа', '', C.renderNotes(), { icon: 'ℹ️' })) });
  }

  // ── Правая колонка: сигналы, инсайты, быстрые действия ────────────────────
  // Только из того, что экран уже загрузил: в базу колонка не ходит. Сигнал —
  // то, что требует внимания (не загрузилось, устарело, горит, падает);
  // инсайт — одна цифра с изменением к прошлому периоду той же длины;
  // действие — обновить данные, перейти к блоку этого экрана или на другой
  // экран. Пустые сигналы так и названы: колонка не пропадает.
  const RAIL_DROP = -20;   // канал просел сильнее, чем на 20 % к прошлому периоду, — сигнал

  function railDelta(cur, prev, invert) {
    if (!C.isNum(cur) || !C.isNum(prev) || !(Math.abs(Number(prev)) > 0)) return '';
    const d = 100 * (Number(cur) - Number(prev)) / Math.abs(Number(prev));
    const up = d >= 0, good = invert ? !up : up;
    return '<span class="kpi-delta-inline ' + (good ? 'up' : 'down') + '"><span aria-hidden="true">' + (up ? '▲' : '▼') + '</span> ' +
      (up ? '+' : '−') + C.pct(Math.abs(d)) + '</span>';
  }
  // sig: { tone: bad | warn | info, title, text, go: { jump | route, label } }
  function railSignal(x) {
    const go = x.go ? (x.go.route
      ? '<button type="button" class="qp-link" data-action="route" data-route="' + x.go.route + '">' + C.esc(x.go.label) + ' <span aria-hidden="true">→</span></button>'
      : '<button type="button" class="qp-link" data-action="jump" data-id="' + x.go.jump + '">' + C.esc(x.go.label) + ' <span aria-hidden="true">↓</span></button>') : '';
    return '<li class="rl-sig rl-' + x.tone + '"><span class="rl-dot" aria-hidden="true"></span><div class="rl-txt">' +
      '<b>' + C.esc(x.title) + '</b>' + (x.text ? '<span>' + C.esc(x.text) + '</span>' : '') + go + '</div></li>';
  }
  // ins: { label, value (готовая разметка), sub (разметка) }
  function railInsight(x) {
    return '<li class="rl-ins"><span class="rl-label">' + C.esc(x.label) + '</span><span class="rl-val' + (x.txt ? ' txt' : '') + '">' + x.value + '</span>' +
      (x.sub ? '<span class="rl-sub">' + x.sub + '</span>' : '') + '</li>';
  }
  // act: { refresh } | { jump, label } | { route, label }
  function railAction(x) {
    if (x.refresh) return '<button type="button" class="ghost rl-act" data-action="refresh"><span class="rl-act-ico" aria-hidden="true">↻</span>Обновить данные</button>';
    const attr = x.route ? 'data-action="route" data-route="' + x.route + '"' : 'data-action="jump" data-id="' + x.jump + '"';
    return '<button type="button" class="ghost rl-act" ' + attr + '><span class="rl-act-ico" aria-hidden="true">' + (x.route ? '→' : '↓') +
      '</span>' + C.esc(x.label) + '</button>';
  }
  function railCard(id, icon, title, count, inner) {
    return '<section class="card rail-card" id="' + id + '" aria-labelledby="' + id + 'Title">' +
      '<div class="card-head qp-head"><div class="qp-titles"><h2 id="' + id + 'Title"><span class="qp-ico" aria-hidden="true">' + icon + '</span>' +
      C.esc(title) + '</h2></div>' + (count ? '<span class="rl-count">' + count + '</span>' : '') + '</div>' + inner + '</section>';
  }
  function railErrors(sig, errors) {
    Object.keys(errors || {}).forEach(k => { if (errors[k]) sig.push({ tone: 'bad', title: 'Не загрузилось', text: String(errors[k]) }); });
  }
  function railStale(sig, holder) {
    const n = staleNote(holder);
    if (n) sig.push({ tone: 'warn', title: 'Данные могли устареть', text: n });
  }

  const RAIL = {
    overview(app) {
      const O = root.NietteOverview, S = root.NietteStock, ov = app.ov, v = app.ovView;
      if (!ov) return null;
      const sig = [], ins = [];
      railErrors(sig, ov.errors);
      railStale(sig, ov);
      if (!v) return { sig, ins, act: [{ refresh: true }] };
      if (!ov.errors.gaps && (ov.gaps || []).length) {
        const sum = ov.gaps.reduce((a, g) => a + (Number(g.amount) || 0), 0);
        sig.push({ tone: 'warn', title: 'Не вошло в выручку', text: C.int(ov.gaps.reduce((a, g) => a + (Number(g.rows) || 0), 0)) + ' записей · ' + C.money(sum),
                   go: { jump: 'ovGapsTitle', label: 'Разбор' } });
      }
      if (S && !ov.errors.stock && (ov.stock || []).length) {
        const now = app.now(), k = S.kpis(ov.stock, null, now);
        const urgent = ov.stock.filter(r => S.status(C.isNum(r.days_remaining) ? Number(r.days_remaining) : S.INF) === 'bad')
          .map(r => S.displayName(r.name, r.sku));
        if (k.critical) sig.push({ tone: 'bad', title: 'Склад: срочно ' + C.int(k.critical) + ' SKU', text: 'хватит меньше чем на неделю: ' + urgent.slice(0, 4).join(', '),
                                   go: { route: 'stock', label: 'Склад' } });
        if (k.warn) sig.push({ tone: 'warn', title: 'Склад: на внимании ' + C.int(k.warn) + ' SKU', text: 'хватит на 7–13 дней', go: { route: 'stock', label: 'Склад' } });
      }
      const t = v.t, pt = v.pt;
      if (pt) {
        v.chans.forEach(c => {
          const cur = t.by[c.key] || 0, prev = pt.by[c.key] || 0;
          if (prev > 0 && 100 * (cur - prev) / prev <= RAIL_DROP) {
            sig.push({ tone: 'warn', title: c.label + ': −' + C.pct(100 * (prev - cur) / prev), text: 'к ' + O.rangeLabel(v.prg) + ' · было ' + C.money(prev) + ', стало ' + C.money(cur) });
          }
        });
      }
      ins.push({ label: 'Выручка за период', value: C.money(t.total), sub: pt ? railDelta(t.total, pt.total) + ' к прошлому периоду' : 'сравнивать не с чем' });
      const ranked = v.chans.map(c => ({ c, v: t.by[c.key] || 0 })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
      if (ranked.length && t.total > 0) ins.push({ label: 'Главный канал', txt: true, value: C.esc(ranked[0].c.label), sub: C.pct(100 * ranked[0].v / t.total) + ' выручки · ' + C.money(ranked[0].v) });
      if (pt) {
        const grow = v.chans.map(c => ({ c, cur: t.by[c.key] || 0, prev: pt.by[c.key] || 0 }))
          .filter(x => x.prev > 0 && x.cur > x.prev).sort((a, b) => (b.cur / b.prev) - (a.cur / a.prev))[0];
        if (grow) ins.push({ label: 'Быстрее всех растёт', txt: true, value: C.esc(grow.c.label), sub: railDelta(grow.cur, grow.prev) + ' · ' + C.money(grow.cur) });
      }
      if (v.cl && C.isNum(v.cl.active)) {
        ins.push({ label: 'Покупатели Kaspi', value: C.int(v.cl.active),
                   sub: 'новых ' + C.int(v.cl.fresh) + (v.pcl ? ' ' + railDelta(v.cl.fresh, v.pcl.fresh) : '') +
                        (v.cl.active > 0 ? ' · повторные ' + C.pct(100 * v.cl.repeat / v.cl.active) : '') });
      }
      const ks = O.channelStats(ov.rows, 'kaspi', v.rg, v.prg);
      if (C.isNum(ks.avgCheck)) {
        const pk = ks.prev && ks.prev.orders > 0 ? ks.prev.gross / ks.prev.orders : null;
        ins.push({ label: 'Средний чек Kaspi', value: C.money(ks.avgCheck), sub: (pk ? railDelta(ks.avgCheck, pk) + ' · ' : '') + C.int(ks.orders) + ' заказов' });
      }
      return { sig, ins, act: [{ refresh: true }, { jump: 'ovTrend', label: 'Все каналы на одном графике' }, { jump: 'ovTable', label: 'Выручка по периодам' },
                               { route: 'clients', label: 'Риск оттока клиентов' }, { route: 'stock', label: 'Остатки склада' }] };
    },
    kaspi(app) {
      const kp = app.kp, v = app.kpView;
      if (!kp) return null;
      const sig = [], ins = [];
      railErrors(sig, kp.errors);
      railStale(sig, kp);
      if (!v) return { sig, ins, act: [{ refresh: true }] };
      const k = v.k, p = v.pk;
      if (k.nocogs_orders) sig.push({ tone: 'warn', title: 'Себестоимость известна не везде', text: C.int(k.nocogs_orders) + ' зак. на ' + C.money(k.nocogs_revenue) + ' — прибыль по ним не посчитана',
                                      go: { jump: 'kpProfit', label: 'Прибыль' } });
      const now = kp.errors.now ? null : kp.now;
      if (now && Number(now.in_work_stale) > 0) sig.push({ tone: 'warn', title: 'В работе дольше 14 дней: ' + C.int(now.in_work_stale) + ' зак.',
                                                          text: 'на ' + C.money(now.in_work_stale_amount), go: { jump: 'kpKpis', label: 'Показатели' } });
      ins.push({ label: 'Выручка Kaspi', value: C.money(k.revenue), sub: p ? railDelta(k.revenue, p.revenue) + ' к прошлому периоду' : 'сравнивать не с чем' });
      if (C.isNum(k.profit)) ins.push({ label: 'Прибыль до расходов', value: C.money(k.profit), sub: 'маржа ' + C.pct(k.margin) + (p && C.isNum(p.profit) ? ' · ' + railDelta(k.profit, p.profit) : '') });
      ins.push({ label: 'Средний чек', value: C.money(k.avgCheck), sub: (p ? railDelta(k.avgCheck, p.avgCheck) + ' · ' : '') + C.int(k.orders) + ' заказов' });
      if (k.clients && C.isNum(k.clients.fresh)) ins.push({ label: 'Новые клиенты', value: C.int(k.clients.fresh),
        sub: (p && p.clients ? railDelta(k.clients.fresh, p.clients.fresh) + ' · ' : '') + 'повторных ' + C.int(k.clients.repeat) });
      if (C.isNum(k.cancelPct)) ins.push({ label: 'Отмены', value: C.pct(k.cancelPct), sub: C.int(k.cancels_n) + ' зак. · ' + C.money(k.cancels_amount) });
      return { sig, ins, act: [{ refresh: true }, { jump: 'kpProfit', label: 'Прибыль до расходов' }, { jump: 'kpRemote', label: 'Удалённые оплаты' },
                               { jump: 'ovTable', label: 'Выручка по периодам' }, { route: 'clients', label: 'Клиенты Kaspi' }, { route: 'analytics', label: 'Аналитика заказов' }] };
    },
    ozon(app) {
      const oz = app.oz, v = app.ozView;
      if (!oz) return null;
      const sig = [], ins = [];
      railErrors(sig, oz.errors);
      railStale(sig, oz);
      if (!v) return { sig, ins, act: [{ refresh: true }] };
      const k = v.k, p = v.pk, now = oz.errors.now ? null : oz.now;
      if (k.seller_errors_n) sig.push({ tone: 'warn', title: 'Ошибки продавца: ' + C.int(k.seller_errors_n) + ' шт.', text: 'штрафы на ' + C.money(k.seller_errors),
                                        go: { jump: 'ozErrors', label: 'Список' } });
      if (now && Number(now.to_ship) > 0) sig.push({ tone: 'info', title: 'Ждут отгрузки: ' + C.int(now.to_ship),
                                                     text: now.to_ship_oldest ? 'самое старое от ' + C.date(now.to_ship_oldest) : '' });
      if (now && Number(now.stale) > 0) sig.push({ tone: 'warn', title: 'Застыли старше 60 дней: ' + C.int(now.stale), text: 'отправления без движения' });
      ins.push({ label: 'Выручка Ozon', value: C.money(k.revenue), sub: p ? railDelta(k.revenue, p.revenue) + ' к прошлому периоду' : 'сравнивать не с чем' });
      ins.push({ label: 'Пришло на счёт', value: C.money(k.payout), sub: C.isNum(k.payoutPct) ? C.pct(k.payoutPct) + ' выручки' : '' });
      if (C.isNum(k.profit)) ins.push({ label: 'Прибыль после себестоимости', value: C.money(k.profit), sub: C.isNum(k.margin) ? 'маржа ' + C.pct(k.margin) : '' });
      ins.push({ label: 'Средний чек', value: C.money(k.avgCheck), sub: (p ? railDelta(k.avgCheck, p.avgCheck) + ' · ' : '') + C.int(k.orders) + ' заказов' });
      if (C.isNum(k.commissionPct)) ins.push({ label: 'Вознаграждение Ozon', value: C.pct(k.commissionPct), sub: C.money(k.commission) + ' · от продаж' });
      return { sig, ins, act: [{ refresh: true }, { jump: 'ozMoney', label: 'Деньги Ozon' }, { jump: 'ozSkus', label: 'Товары' },
                               { jump: 'ozErrors', label: 'Ошибки продавца' }, { jump: 'ovTable', label: 'Выручка по периодам' }] };
    },
    analytics(app) {
      const A = root.NietteAnalytics, an = app.an, v = app.anView;
      if (!an) return null;
      const sig = [], ins = [];
      railErrors(sig, an.errors);
      railStale(sig, an);
      if (!v) return { sig, ins, act: [{ refresh: true }] };
      const k = v.k, p = v.pk;
      if (C.isNum(k.work_orders) && k.work_orders > 0) sig.push({ tone: 'info', title: 'Ещё в работе: ' + C.int(k.work_orders) + ' зак.', text: 'исход заказов периода пока не известен' });
      ins.push({ label: 'Поступило заказов', value: C.int(k.placed_orders), sub: (p ? railDelta(k.placed_orders, p.placed_orders) + ' · ' : '') + C.money(k.placed_amount) });
      if (C.isNum(k.buyout)) ins.push({ label: 'Выкуп', value: C.pct(k.buyout), sub: 'отмены ' + C.pct(k.cancelShare) + ' · возвраты ' + C.pct(k.returnShare) });
      if (!an.errors.cities) {
        const top = A.cityTotals(an.cities, v.rg).filter(e => e.city !== '')[0];
        if (top && k.placed_orders > 0) ins.push({ label: 'Главный город', txt: true, value: C.esc(top.city), sub: C.int(top.placed_orders) + ' зак. · ' + C.pct(100 * top.placed_orders / k.placed_orders) + ' заказов' });
      }
      if (!an.errors.skus) {
        const top = A.skuTotals(an.skus, v.rg)[0];
        if (top && top.placed_amount > 0) ins.push({ label: 'Главный товар', txt: true, value: C.esc(top.name || top.sku), sub: C.money(top.placed_amount) + ' заказано' });
      }
      const wd = A.weekdays(an.rows, v.rg).filter(e => C.isNum(e.avgOrders) && e.avgOrders > 0).sort((a, b) => b.avgOrders - a.avgOrders)[0];
      if (wd) ins.push({ label: 'Сильнейший день недели', txt: true, value: C.esc(String(wd.full || wd.label).replace(/^./, ch => ch.toUpperCase())), sub: 'в среднем ' + C.int(wd.avgOrders) + ' зак. в день' });
      return { sig, ins, act: [{ refresh: true }, { jump: 'anSkus', label: 'Товары' }, { jump: 'anCities', label: 'Города' },
                               { jump: 'anPair', label: 'Дни недели и доставка' }, { jump: 'ovTable', label: 'Заказы по периодам' }] };
    },
    clients(app) {
      const d = app.data, e = app.errors || {};
      if (!d) return null;
      const sig = [], ins = [];
      railErrors(sig, e);
      railStale(sig, app);
      const k = C.computeKpis(d.base || [], d.repeat || [], d.risk || []);
      if (!e.risk && k.high) sig.push({ tone: 'bad', title: 'Высокий риск оттока: ' + C.int(k.high), text: 'давно не заказывали по своим меркам', go: { jump: 'risk', label: 'Список' } });
      if (!e.risk && k.mid) sig.push({ tone: 'warn', title: 'Средний риск оттока: ' + C.int(k.mid), text: 'стоит напомнить о себе', go: { jump: 'risk', label: 'Список' } });
      if (!e.base) {
        ins.push({ label: 'Клиентов в базе', value: C.int(k.clients), sub: 'повторных ' + C.int(k.repeaters) + ' · ' + C.pct(k.repeatPct) });
        ins.push({ label: 'Выручка на клиента', value: C.money(k.avgRevenue), sub: 'прибыль ' + C.money(k.avgProfit) });
      }
      if (!e.repeat && C.isNum(k.medianDays)) ins.push({ label: 'Медиана до второго заказа', value: C.days(k.medianDays), sub: 'половина повторяет быстрее' });
      return { sig, ins, act: [{ refresh: true }, { jump: 'risk', label: 'Риск оттока' }, { jump: 'retention', label: 'Удержание по месяцам' },
                               { jump: 'cohorts', label: 'Когорты и окупаемость' }, { jump: 'ltv', label: 'LTV по месяцам жизни' }, { jump: 'base', label: 'База клиентов' }] };
    },
    stock(app) {
      const S = root.NietteStock, st = app.st;
      if (!st) return null;
      const sig = [], ins = [];
      railErrors(sig, st.errors);
      railStale(sig, st);
      if (st.errors.stock) return { sig, ins, act: [{ refresh: true }] };
      const now = app.now(), k = S.kpis(st.rows, st.errors.woff ? null : st.woffs, now);
      const rep = st.errors.recon ? null : S.reconFor(st.recon, app.stUi.win), pr = S.problems(st.rows, rep);
      const names = tone => st.rows.filter(r => S.status(C.isNum(r.days_remaining) ? Number(r.days_remaining) : S.INF) === tone)
        .map(r => S.displayName(r.name, r.sku)).slice(0, 4).join(', ');
      if (k.critical) sig.push({ tone: 'bad', title: 'Срочно пополнить: ' + C.int(k.critical) + ' SKU', text: 'меньше недели: ' + names('bad'), go: { jump: 'stCards', label: 'Остатки' } });
      if (k.warn) sig.push({ tone: 'warn', title: 'На внимании: ' + C.int(k.warn) + ' SKU', text: '7–13 дней: ' + names('warn'), go: { jump: 'stCards', label: 'Остатки' } });
      if (pr.notDeducted) sig.push({ tone: 'warn', title: 'Не вычлось с пересчёта: ' + C.int(pr.notDeducted) + ' шт', text: 'остаток может быть выше реального', go: { jump: 'stRecon', label: 'Сверка' } });
      if (pr.deficits.length) sig.push({ tone: 'warn', title: 'Расход превысил пересчёт: ' + C.int(pr.deficits.length) + ' SKU', text: 'проверьте приходы и пересчёт', go: { jump: 'stTable', label: 'Расчёт' } });
      ins.push({ label: 'На своём складе', value: C.int(k.total) + ' шт', sub: C.int(k.items) + ' товаров' });
      if (C.isNum(k.avgDays)) ins.push({ label: 'В среднем хватит', value: C.int(k.avgDays) + ' дн', sub: 'по скорости продаж' });
      if (C.isNum(k.woffQty)) ins.push({ label: 'Списано за 30 дней', value: C.int(k.woffQty) + ' шт', sub: C.int(k.woffN) + ' записей' });
      return { sig, ins, act: [{ refresh: true }, { jump: 'stForms', label: 'Внести приход или списание' }, { jump: 'stMp', label: 'Остатки по площадкам' },
                               { jump: 'stLog', label: 'Журналы' }, { jump: 'stRecon', label: 'Сверка' }] };
    },
    b2b(app) {
      const B = root.NietteB2b, b = app.b2b;
      if (!b) return null;
      const sig = [], ins = [];
      railErrors(sig, b.errors);
      if (B2B_CORE.some(k => b.errors[k])) return { sig, ins, act: [{ refresh: true }] };
      const m = b2bModel(app), ui = app.b2bUi, per = b2bPer(app), k = B.kpis(m, ui, per), u = B.urgent(m, ui);
      if (u.overdue.length) sig.push({ tone: 'bad', title: 'Просрочена оплата: ' + C.int(u.overdue.length) + ' партн.', text: 'долг ' + C.money(u.overdue.reduce((a, x) => a + x.debt, 0)),
                                       go: { jump: 'b2bUrgent', label: 'Горит' } });
      if (u.contacts.length) sig.push({ tone: 'warn', title: 'Пора связаться: ' + C.int(u.contacts.length), text: 'срок следующего контакта наступил', go: { jump: 'b2bUrgent', label: 'Горит' } });
      ins.push({ label: 'Поставлено', value: C.money(k.shipped), sub: (k.delta !== null ? '<span class="kpi-delta-inline ' + (k.delta >= 0 ? 'up' : 'down') + '">' +
        (k.delta >= 0 ? '▲ +' : '▼ −') + C.int(Math.abs(k.delta)) + NBSP + '%</span> к прошлому · ' : '') + C.int(k.shipCount) + ' поставок' });
      ins.push({ label: 'Оплачено', value: C.money(k.paid), sub: k.payRate + NBSP + '% от поставленного в долг' });
      ins.push({ label: 'Долг партнёров', value: C.money(k.debt), sub: 'просрочено ' + C.money(k.overdue) + ' · должников ' + C.int(k.debtorsN) });
      ins.push({ label: 'Активные точки', value: C.int(k.active), sub: 'из ' + C.int(k.total) + ' · новых ' + C.int(k.newN) });
      return { sig, ins, act: [{ refresh: true }, { jump: 'b2bForecast', label: 'Прогноз поступлений' }, { jump: 'b2bOverdue', label: 'Разбор просрочки' },
                               { jump: 'b2bPartners', label: 'Партнёры' }] };
    }
  };

  function railInner(app) {
    const f = RAIL[app.route];
    let r = null;
    try { r = f ? f(app) : null; }
    catch (e) { r = { sig: [{ tone: 'bad', title: 'Сигналы не собрались', text: String((e && e.message) || e) }], ins: [], act: [{ refresh: true }] }; }
    if (!r) return '';
    const sig = r.sig || [], ins = r.ins || [], act = r.act || [];
    return railCard('railSignals', '🔔', 'Сигналы', sig.length ? C.int(sig.length) : '',
             sig.length ? '<ul class="rl-list">' + sig.map(railSignal).join('') + '</ul>'
                        : '<p class="rl-calm">Сигналов нет: всё загрузилось, тревожного не видно.</p>') +
      (ins.length ? railCard('railInsights', '💡', 'Инсайты', '', '<ul class="rl-list">' + ins.map(railInsight).join('') + '</ul>') : '') +
      railCard('railActions', '⚡', 'Быстрые действия', '', '<div class="rl-actions">' + act.map(railAction).join('') + '</div>');
  }
  function refreshRail(app) {
    const el = app.root.querySelector('#screenRail');
    if (el) el.innerHTML = railInner(app);
  }

  // ── Показ ─────────────────────────────────────────────────────────────────
  function show(app, html) { app.root.innerHTML = html; }
  function loadingHtml(app, text) {
    return frame(app, { body: '<div class="card loading" role="status">' + C.esc(text) + '</div>' });
  }

  // Квадранты на высоту окна — только на широком экране (то же условие, что
  // в style.css): на телефоне и планшете — один столбец обычной высоты.
  const COCKPIT_MQ = '(min-width: 1100px)';
  function isCockpit() { return !!(root.matchMedia && root.matchMedia(COCKPIT_MQ).matches); }

  // После показа: высота квадрантов — от их места на странице, графики — по
  // настоящему размеру своих коробок.
  function afterShow(app) { fitQuad(app); fitCharts(app); }

  // Верх квадрантов → CSS (--quad-top): высота строки = (окно − верх) / 2.
  // Меряется после показа: над квадрантами бывают предупреждения разной высоты.
  function fitQuad(app) {
    const q = app.root.querySelector('.quad');
    const de = root.document && root.document.documentElement;
    const bar = app.root.querySelector('.top');
    if (bar && de && bar.offsetHeight) de.style.setProperty('--top-h', bar.offsetHeight + 'px');
    if (!q || !q.getBoundingClientRect || !de) return;
    const top = Math.round(q.getBoundingClientRect().top + (root.scrollY || root.pageYOffset || 0));
    if (top > 0) de.style.setProperty('--quad-top', top + 'px');
  }

  // Размер графика — настоящий размер его коробки. SVG с чужой шириной
  // масштабируется целиком, вместе с текстом: на телефоне подписи стали бы
  // мельче шести пикселей. В квадранте на широком экране график ещё и
  // занимает всю свободную высоту; развёрнутый квадрант и телефон — 250 px.
  function fitCharts(app) {
    const specs = screenCharts(app), cockpit = isCockpit();
    Object.keys(specs).forEach(id => {
      const box = app.root.querySelector('#' + id + 'Box');
      if (!box) return;
      const w = Math.round(box.clientWidth || 0);
      if (!w) return;
      const fill = cockpit && box.closest && box.closest('.qp-fill') && !box.closest('.qp-max');
      const h = fill ? Math.round(box.clientHeight || 0) : 0;
      const d = app.chartDims[id] || { w: 0, h: 0 };
      if (Math.abs(w - d.w) < 8 && Math.abs(h - d.h) < 8) return;
      app.chartDims[id] = { w, h };
      box.innerHTML = specs[id].html(w, h);
    });
  }
  function chartW(app, id) { const d = app.chartDims[id]; return d ? d.w : 0; }
  function chartH(app, id) { const d = app.chartDims[id]; return d ? d.h : 0; }

  // Смена своих дат: тело экрана — заново, полоса фильтров — та же.
  function swapBody(app, html) {
    const body = app.root.querySelector('#screenBody');
    if (!body) return renderPeriodScreen(app);
    body.innerHTML = html;
    refreshRail(app);
    syncPresetButtons(app);
    afterShow(app);
  }

  // Развёрнутый квадрант — во всю ширину и в полную высоту, без листания
  // внутри. Один на экран; помнится до перезагрузки страницы.
  function setQpMax(app, id) {
    const cur = app.qpMax[app.route] === id;
    app.qpMax[app.route] = cur ? null : id;
    app.root.querySelectorAll('.qp').forEach(q => {
      const on = !cur && q.id === id;
      q.classList.toggle('qp-max', on);
      const b = q.querySelector('[data-action="qp-max"]');
      if (!b) return;
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Свернуть' : 'Развернуть во всю ширину';
      const ico = b.querySelector('[aria-hidden="true"]');
      if (ico) ico.textContent = on ? '⤡' : '⤢';
      const sr = b.querySelector('.sr-only');
      if (sr) sr.textContent = sr.textContent.replace(/^(Свернуть|Развернуть)/, on ? 'Свернуть' : 'Развернуть');
    });
    fitCharts(app);
    const q = app.root.querySelector('#' + id);
    if (q && !cur && typeof q.scrollIntoView === 'function') q.scrollIntoView({ block: 'nearest' });
  }

  // Переход из правой колонки к блоку экрана. Свёрнутое («Что не сходится») —
  // раскрыть; квадрант на широком экране — показать целиком.
  function jumpTo(app, id) {
    const el = id ? app.root.querySelector('#' + id) : null;
    if (!el) return;
    const det = el.closest ? el.closest('details') : null;
    if (det) det.open = true;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const f = el.matches && el.matches('section, details') ? el : (el.closest ? el.closest('section') : null);
    if (f && f.focus) { if (!f.hasAttribute('tabindex')) f.setAttribute('tabindex', '-1'); f.focus({ preventScroll: true }); }
  }

  // Всё загруженное — из памяти вон: на том же телефоне следующим может войти
  // торгпред, и экраны владельца (Kaspi, склад, клиенты) не должны его ждать.
  // gen — поколение: ответ, который грузился ДО сброса (вышли, вошёл другой),
  // приходит в старое поколение и выбрасывается, а не рисуется поверх входа.
  function resetScreens(app) {
    app.gen = (app.gen || 0) + 1;
    app.me = null;
    app.data = null; app.errors = {}; app.riskByKey = {}; app.synced = null; app.snapAt = null; app.snapNever = false;
    app.ov = null; app.ovView = null; app.kp = null; app.kpView = null; app.oz = null; app.ozView = null;
    app.an = null; app.anView = null; app.st = null; app.stForm = null; app.b2b = null; app.b2bModel = null;
    if (app.b2bUi) app.b2bUi.card = null;
    // Формы B2B — тоже: недописанная оплата одного человека не должна
    // достаться следующему, вошедшему на том же телефоне.
    app.b2bForm = null; app.b2bAct = { confirm: null }; app.b2bBulk = newBulk(); app.b2bSigned = {}; app.b2bNotice = null;
    b2bPdfDrop(app);
  }
  function newBulk() { return { sel: {}, status: 'Реализация', msg: null, busy: false }; }

  function showLogin(app, errorText, email) {
    app.session = null;
    resetScreens(app);
    show(app, loginHtml(errorText, email));
    const f = app.root.querySelector(email ? '#loginPassword' : '#loginEmail');
    if (f && f.focus) f.focus();
  }

  function showDenied(app) {
    resetScreens(app);
    const email = app.session && app.session.user ? app.session.user.email : '';
    show(app, messageHtml('Нет доступа',
      '<p>Вы вошли как <b>' + C.esc(email) + '</b>, но этого email нет в списке допущенных.</p>' +
      '<p class="muted">Добавить можно в Supabase → SQL Editor:</p>' +
      '<pre><code>insert into app_users (email, note) values (\'' + C.esc(email) + '\', \'кто это\');</code></pre>',
      '<button type="button" data-action="logout">Выйти</button>'));
  }

  // В списке, но ни одного открытого раздела: {} — доступ приостановлен.
  function showNoSections(app) {
    resetScreens(app);
    const email = app.session && app.session.user ? app.session.user.email : '';
    show(app, messageHtml('Разделы закрыты',
      '<p>Вы вошли как <b>' + C.esc(email) + '</b>: вы в списке допущенных, но ни один раздел вам не открыт.</p>' +
      '<p class="muted">Открывает владелец — Supabase → SQL Editor:</p>' +
      '<pre><code>update app_users set sections = \'{b2b}\' where email = \'' + C.esc(email) + '\';</code></pre>',
      '<button type="button" data-action="logout">Выйти</button>'));
  }

  function showFatal(app, text) {
    show(app, messageHtml('Не получилось', '<p>' + C.esc(text) + '</p>',
      '<button type="button" data-action="refresh">Повторить</button> ' +
      '<button type="button" data-action="logout" class="ghost">Выйти</button>'));
  }

  function renderScreen(app) {
    app.riskByKey = {};
    app.data.risk.forEach(r => { app.riskByKey[r.client_key] = r.risk; });
    show(app, screenHtml(app));
  }

  async function loadAndRender(app) {
    const g = app.gen;
    show(app, loadingHtml(app, 'Загружаю клиентов…'));
    const res = await loadAll(app.client);
    if (g !== app.gen) return;                 // пока грузилось, вышли или вошёл другой
    app.data = res.data;
    app.errors = res.errors;
    app.synced = res.synced;
    app.snapAt = res.snapAt;
    app.snapNever = res.snapNever;
    app.loadedAt = new Date();
    if (app.route === 'clients') renderScreen(app);
  }

  // ── «Обзор» ───────────────────────────────────────────────────────────────
  // Период общий для «Обзора» и «Kaspi». «Всё время» начинается с первого дня
  // в данных ОТКРЫТОГО экрана.
  function periodRange(app, rows) {
    const O = root.NietteOverview, ui = app.ovUi;
    const today = O.todayIso(app.now());
    if (ui.preset === 'custom' && ui.from && ui.to) {
      return ui.from <= ui.to ? { from: ui.from, to: ui.to } : { from: ui.to, to: ui.from };
    }
    return O.presetRange(ui.preset, today, O.minDay(rows));
  }
  function ovRange(app) { return periodRange(app, app.ov.rows); }

  // Сегодняшнее время — без даты: «11:57», а не «25.09, 11:57» пять раз подряд.
  function when(v) {
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d)) return '—';
    const n = new Date();
    const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return same ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : hhmm(d);
  }

  function ovFresh(app) {
    const f = app.ov.fresh || {};
    const bits = [];
    if (app.ov.snapAt) bits.push('Данные на ' + when(app.ov.snapAt));
    const poll = [];
    if (f.kaspi_polled_at) poll.push('Kaspi ' + when(f.kaspi_polled_at));
    if (f.ozon_polled_at && f.wb_polled_at && when(f.ozon_polled_at) === when(f.wb_polled_at)) {
      poll.push('Ozon и WB ' + when(f.ozon_polled_at));
    } else {
      if (f.ozon_polled_at) poll.push('Ozon ' + when(f.ozon_polled_at));
      if (f.wb_polled_at) poll.push('WB ' + when(f.wb_polled_at));
    }
    if (poll.length) bits.push('опрос ' + poll.join(', '));
    if (f.mirror_synced_at) bits.push('зеркало ' + when(f.mirror_synced_at));
    bits.push('загружено ' + when(app.ov.loadedAt));
    return freshParts(bits, [staleNote(app.ov)]);
  }

  const OV_PANELS = {
    kaspi: { id: 'ovKaspi', chart: 'ovKpChart', icon: '🔵', title: 'Kaspi · продажи', link: 'Kaspi', basis: 'по дню выдачи' },
    ozon:  { id: 'ovOzon',  chart: 'ovOzChart', icon: '🟠', title: 'Ozon · продажи',  link: 'Ozon',  basis: 'по дню начисления' }
  };
  const CLIENT_LEGEND = [{ key: 'new', label: 'Новые' }, { key: 'ret', label: 'Повторные' }];

  // Всё, что зависит от периода, считается здесь одним проходом и кладётся
  // в app.ovView — подсказкам графиков нужны ровно те бакеты, что нарисованы.
  function ovCompute(app) {
    const O = root.NietteOverview, K = root.NietteKaspi, ui = app.ovUi, ov = app.ov, rows = ov.rows;
    const today = O.todayIso(app.now());
    const rg = ovRange(app);
    const prg = O.prevRange(ui.preset === 'custom' ? 'custom' : ui.preset, rg);
    const chans = O.channelsOf(rows);
    const series = O.buildSeries(rows, rg, ui.grouping, today);
    const present = {};
    chans.forEach(c => { present[c.key] = series.some(e => (e.by[c.key] || 0) !== 0); });
    const chSeries = {};
    Object.keys(OV_PANELS).forEach(k => { chSeries[k] = O.buildSeries(rows.filter(r => r.channel === k), rg, ui.grouping, today); });
    // Клиенты — квадрант C: пары «клиент × день» Kaspi, как на экране Kaspi.
    const idx = K && !ov.errors.clients ? (ov.idx || (ov.idx = K.clientIndex(ov.clientDays))) : null;
    app.ovView = {
      rg, prg, chans, series, present, chSeries, t: O.totals(rows, rg), pt: prg ? O.totals(rows, prg) : null,
      cl: idx ? K.clientsIn(idx, rg) : null, pcl: idx && prg ? K.clientsIn(idx, prg) : null,
      cliSeries: idx ? K.clientSeries(idx, rg, ui.grouping, today) : []
    };
    return app.ovView;
  }

  function ovChartHtml(app, width, height) {
    const v = app.ovView;
    return root.NietteOverview.renderChart(v.series, v.chans, app.ovUi.hidden, width, app.ovUi.grouping, null,
                                           { height: height || 0 });
  }
  function ovChannelChartHtml(app, key, width, height) {
    const p = OV_PANELS[key], ch = app.ovView.chans.filter(c => c.key === key);
    return root.NietteOverview.renderChart(app.ovView.chSeries[key], ch.length ? ch : [{ key, label: key }], {}, width,
      app.ovUi.grouping, null, { id: p.chart, height: height || 0, tail: 'Точные суммы — в подсказке столбика и в таблице «По периодам» ниже.' });
  }
  function ovClientChartHtml(app, width, height) {
    return root.NietteOverview.renderChart(app.ovView.cliSeries, CLIENT_LEGEND, {}, width, app.ovUi.grouping, 'Покупатели',
      { id: 'ovCliChart', height: height || 0, tail: 'Новые и повторные по каждому столбику — в подсказке.' });
  }

  function ovTrendInner(app) {
    const O = root.NietteOverview, v = app.ovView;
    return O.renderLegend(v.chans, app.ovUi.hidden, v.present) +
      chartBox('ovChart', ovChartHtml(app, chartW(app, 'ovChart'), chartH(app, 'ovChart')));
  }

  // A и B: канал — сумма, изменение к прошлому периоду, заказы, график.
  function ovChannelPanel(app, key) {
    const O = root.NietteOverview, v = app.ovView, p = OV_PANELS[key];
    const st = O.channelStats(app.ov.rows, key, v.rg, v.prg);
    return panel(app, p.id, p.icon, p.title, C.esc(GROUP_SUB[app.ovUi.grouping]) + ' · ' + p.basis + ' · ' + C.esc(O.rangeLabel(v.rg)),
      O.renderChannelStat(st) + chartBox(p.chart, ovChannelChartHtml(app, key, chartW(app, p.chart), chartH(app, p.chart))),
      { fill: true, tools: qpLink(key, p.link) });
  }

  // C: покупатели Kaspi — новые и повторные по тем же бакетам.
  function ovClientsPanel(app) {
    const K = root.NietteKaspi, ov = app.ov, v = app.ovView;
    const sub = C.esc(GROUP_SUB[app.ovUi.grouping]) + ' · опознанные покупатели Kaspi · по дню выдачи';
    const more = { fill: true, tools: qpLink('clients', 'Клиенты') };
    if (!K) return panel(app, 'ovClients', '👥', 'Клиенты · динамика', sub, C.sectionError('Не загрузился kaspi.js — обновите страницу.'), more);
    if (ov.errors.clients) return panel(app, 'ovClients', '👥', 'Клиенты · динамика', sub, C.sectionError(ov.errors.clients), more);
    const legend = '<div class="legend static" aria-hidden="true">' + CLIENT_LEGEND.map(c =>
      '<span class="chip"><span class="sw sq ch-' + c.key + '"></span>' + C.esc(c.label) + '</span>').join('') + '</div>';
    return panel(app, 'ovClients', '👥', 'Клиенты · динамика', sub,
      '<div class="qp-headline">' + K.renderClientStat(v.cl, v.pcl) + legend + '</div>' +
      chartBox('ovCliChart', ovClientChartHtml(app, chartW(app, 'ovCliChart'), chartH(app, 'ovCliChart'))),
      more);
  }

  // D: склад — остаток на сейчас, период его не режет.
  function ovStockPanel(app) {
    const S = root.NietteStock, ov = app.ov;
    const more = { tools: qpLink('stock', 'Склад') };
    const sub = 'на сейчас · срочные сверху · период не влияет';
    if (!S) return panel(app, 'ovStock', '📦', 'Склад · остатки', sub, C.sectionError('Не загрузился stock.js — обновите страницу.'), more);
    if (ov.errors.stock) return panel(app, 'ovStock', '📦', 'Склад · остатки', sub, C.sectionError(ov.errors.stock), more);
    return panel(app, 'ovStock', '📦', 'Склад · остатки', sub, S.renderBrief(ov.stock, app.now(), ov.errors.mp ? null : ov.mp), more);
  }

  function overviewHtml(app) {
    const O = root.NietteOverview, ov = app.ov, f = ovFresh(app);
    if (ov.errors.daily) {
      app.ovView = null;
      return frame(app, { fresh: f.line, body: f.notes + C.sectionError(ov.errors.daily) });
    }
    const v = ovCompute(app);
    return frame(app, { tools: O.renderFilters(app.ovUi, v.rg, { groupings: true }), fresh: f.line, body: ovBodyHtml(app, f) });
  }

  // Лента итогов всех каналов → A Kaspi, B Ozon / C клиенты, D склад → ниже
  // все каналы на одном графике, таблица периодов и пояснения.
  function ovBodyHtml(app, f) {
    const O = root.NietteOverview, ov = app.ov, v = app.ovView;
    const gSub = GROUP_SUB[app.ovUi.grouping];
    return (f || ovFresh(app)).notes +
      (ov.errors.gaps ? C.sectionError(ov.errors.gaps) : O.renderGaps(ov.gaps)) +
      O.renderRibbon(v.t, v.pt, v.rg, v.prg, v.chans) +
      quad(ovChannelPanel(app, 'kaspi'), ovChannelPanel(app, 'ozon'), ovClientsPanel(app), ovStockPanel(app)) +
      below(
        section('ovTrend', 'Все каналы · динамика выручки', C.esc(gSub) + ' · незакрытый период бледнее',
                '<div id="ovTrendBody">' + ovTrendInner(app) + '</div>', { icon: '📈' }) +
        section('ovTable', 'По периодам', 'новые сверху · итог сходится с общей выручкой', O.renderTable(v.series, v.chans), { icon: '📅' }) +
        section('ovNotes', 'Как читать эти числа', '', O.renderNotes(), { icon: 'ℹ️' }));
  }

  function syncPresetButtons(app) {
    app.root.querySelectorAll('[data-action="ov-preset"]').forEach(b => {
      const on = b.getAttribute('data-preset') === app.ovUi.preset;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
  }

  function renderOverview(app) {
    show(app, overviewHtml(app));
    afterShow(app);
  }

  // Период или каналы поменялись — перерисовать тело экрана, но не полосу
  // фильтров: поле даты, в котором сейчас курсор, не должно пересоздаваться.
  function rerenderOverview(app, keepFilters) {
    if (!keepFilters || app.ov.errors.daily) return renderOverview(app);
    ovCompute(app);
    swapBody(app, ovBodyHtml(app));
  }

  async function loadOverviewScreen(app) {
    const g = app.gen;
    show(app, loadingHtml(app, 'Загружаю выручку…'));
    const ov = await loadOverview(app.client);
    if (g !== app.gen) return;
    app.ov = ov;
    if (app.route === 'overview') renderOverview(app);
  }

  // ── «Kaspi» ───────────────────────────────────────────────────────────────
  // Разметка и расчёты — в kaspi.js; здесь только сборка экрана из частей и
  // перерисовка при смене периода. Показатели периода — лента над
  // квадрантами; A — выручка и график, B — прибыль до расходов, C — удалённые
  // оплаты, D — по периодам.
  const KASPI_CH = [{ key: 'kaspi', label: 'Kaspi' }];

  function kpFresh(app) {
    const f = app.kp.fresh || {};
    const bits = [];
    if (app.kp.snapAt) bits.push('Данные на ' + when(app.kp.snapAt));
    if (f.kaspi_polled_at) bits.push('опрос Kaspi ' + when(f.kaspi_polled_at));
    if (f.mirror_synced_at) bits.push('удалённые оплаты — с таблицей ' + when(f.mirror_synced_at));
    bits.push('загружено ' + when(app.kp.loadedAt));
    return freshParts(bits, [staleNote(app.kp)]);
  }

  function kpCompute(app) {
    const O = root.NietteOverview, K = root.NietteKaspi, ui = app.ovUi, kp = app.kp;
    const today = O.todayIso(app.now());
    const rg = periodRange(app, kp.rows);
    const prg = O.prevRange(ui.preset === 'custom' ? 'custom' : ui.preset, rg);
    // Упал снимок клиентов — новые и повторные прочерком, а не нулём.
    const idx = kp.errors.clients ? null : (kp.idx || (kp.idx = K.clientIndex(kp.clientDays)));
    app.kpView = {
      rg, prg,
      k: K.metrics(kp.rows, idx, rg),
      pk: prg ? K.metrics(kp.rows, idx, prg) : null,
      series: K.buildSeries(kp.rows, rg, ui.grouping, today)
    };
    return app.kpView;
  }

  function kpChartHtml(app, width, height) {
    return root.NietteOverview.renderChart(app.kpView.series, KASPI_CH, {}, width, app.ovUi.grouping, null, { height: height || 0 });
  }
  function kpSalesHtml(app) {
    const O = root.NietteOverview, v = app.kpView;
    return panel(app, 'kpSales', '🔵', 'Выручка Kaspi · динамика',
      C.esc(GROUP_SUB[app.ovUi.grouping]) + ' · по дню выдачи · незакрытый период бледнее',
      O.renderHero({ total: v.k.revenue }, v.pk ? { total: v.pk.revenue } : null, v.rg, v.prg, 'Выручка Kaspi', '', { bare: true }) +
      chartBox('ovChart', kpChartHtml(app, chartW(app, 'ovChart'), chartH(app, 'ovChart'))),
      { fill: true });
  }
  function kpProfitHtml(app) {
    const v = app.kpView;
    return panel(app, 'kpProfit', '💰', 'Прибыль до расходов', 'по заказам с известной себестоимостью',
                 root.NietteKaspi.renderProfit(v.k, v.pk, v.prg));
  }
  // Показатели периода — лента KPI над квадрантами, как на остальных экранах.
  function kpKpisHtml(app) {
    const kp = app.kp, v = app.kpView;
    return '<div id="kpKpis" class="ribbon-kpis">' + (kp.errors.clients ? C.sectionError(kp.errors.clients) : '') +
      root.NietteKaspi.renderKpis(v.k, v.pk, kp.errors.now ? null : kp.now) + '</div>';
  }
  function kpTableHtml(app) {
    return panel(app, 'ovTable', '📅', 'По периодам', 'новые сверху · итог сходится с выручкой',
                 root.NietteKaspi.renderTable(app.kpView.series));
  }
  function kpRemoteHtml(app) {
    const kp = app.kp;
    return panel(app, 'kpRemote', '🧾', 'Удалённые оплаты', 'оплаты без заказа в Kaspi · в выручке по дню оплаты, без комиссии',
      kp.errors.remote ? C.sectionError(kp.errors.remote) : root.NietteKaspi.renderRemote(kp.remote, app.kpView.rg));
  }

  function kaspiHtml(app) {
    const kp = app.kp, f = kpFresh(app);
    if (kp.errors.daily) {
      app.kpView = null;
      return frame(app, { fresh: f.line, body: f.notes + C.sectionError(kp.errors.daily) });
    }
    kpCompute(app);
    return frame(app, { tools: root.NietteOverview.renderFilters(app.ovUi, app.kpView.rg, { groupings: true }),
                        fresh: f.line, body: kpBodyHtml(app, f) });
  }
  function kpBodyHtml(app, f) {
    return (f || kpFresh(app)).notes + kpKpisHtml(app) +
      quad(kpSalesHtml(app), kpProfitHtml(app), kpRemoteHtml(app), kpTableHtml(app)) +
      below(section('kpNotes', 'Как читать эти числа', '', root.NietteKaspi.renderNotes(), { icon: 'ℹ️' }));
  }

  function renderKaspi(app) {
    show(app, kaspiHtml(app));
    afterShow(app);
  }

  // Смена своих дат: перерисовать тело экрана, кроме полосы фильтров — в
  // одном из полей дат сейчас курсор.
  function rerenderKaspi(app, keepFilters) {
    if (!keepFilters || app.kp.errors.daily) return renderKaspi(app);
    kpCompute(app);
    swapBody(app, kpBodyHtml(app));
  }

  async function loadKaspiScreen(app) {
    app.kpView = null;
    const g = app.gen;
    show(app, loadingHtml(app, 'Загружаю Kaspi…'));
    const kp = await loadKaspi(app.client);
    if (g !== app.gen) return;
    app.kp = kp;
    if (app.route === 'kaspi') renderKaspi(app);
  }

  // ── «Ozon» ────────────────────────────────────────────────────────────────
  // Показатели — лента над квадрантами; A — выручка и график, B — деньги
  // Ozon, C — товары, D — ошибки продавца; таблица периодов — ниже.
  const OZON_CH = [{ key: 'ozon', label: 'Ozon' }];

  function ozFresh(app) {
    const n = app.oz.now || {};
    const bits = [];
    if (app.oz.snapAt) bits.push('Данные на ' + when(app.oz.snapAt));
    if (n.accruals_polled_at) bits.push('начисления Ozon ' + when(n.accruals_polled_at));
    if (n.journal_polled_at) bits.push('отправления ' + when(n.journal_polled_at));
    bits.push('загружено ' + when(app.oz.loadedAt));
    return freshParts(bits, [staleNote(app.oz)]);
  }

  function ozCompute(app) {
    const O = root.NietteOverview, Z = root.NietteOzon, ui = app.ovUi, oz = app.oz;
    const today = O.todayIso(app.now());
    const rg = periodRange(app, oz.rows);
    const prg = O.prevRange(ui.preset === 'custom' ? 'custom' : ui.preset, rg);
    app.ozView = {
      rg, prg,
      k: Z.metrics(oz.rows, rg),
      pk: prg ? Z.metrics(oz.rows, prg) : null,
      series: Z.buildSeries(oz.rows, rg, ui.grouping, today)
    };
    return app.ozView;
  }

  function ozChartHtml(app, width, height) {
    return root.NietteOverview.renderChart(app.ozView.series, OZON_CH, {}, width, app.ovUi.grouping, null, { height: height || 0 });
  }
  function ozSalesHtml(app) {
    const O = root.NietteOverview, v = app.ozView;
    return panel(app, 'ozSales', '🟠', 'Выручка Ozon · динамика',
      C.esc(GROUP_SUB[app.ovUi.grouping]) + ' · по дню начисления · незакрытый период бледнее',
      O.renderHero({ total: v.k.revenue }, v.pk ? { total: v.pk.revenue } : null, v.rg, v.prg, 'Выручка Ozon', '', { bare: true }) +
      chartBox('ovChart', ozChartHtml(app, chartW(app, 'ovChart'), chartH(app, 'ovChart'))),
      { fill: true });
  }
  function ozMoneyHtml(app) {
    const v = app.ozView;
    return panel(app, 'ozMoney', '💰', 'Деньги Ozon', 'из начислений: что продано, что удержано, что пришло',
                 root.NietteOzon.renderMoney(v.k, v.pk, v.prg));
  }
  function ozKpisHtml(app) {
    const oz = app.oz, v = app.ozView;
    return '<div id="ozKpis" class="ribbon-kpis">' + root.NietteOzon.renderKpis(v.k, v.pk, oz.errors.now ? null : oz.now) + '</div>';
  }
  function ozTableHtml(app) {
    return section('ovTable', 'По периодам', 'новые сверху · итог сходится с выручкой',
                   root.NietteOzon.renderTable(app.ozView.series), { icon: '📅' });
  }
  function ozSkuHtml(app) {
    const oz = app.oz, Z = root.NietteOzon;
    return panel(app, 'ozSkus', '🧷', 'Товары', 'за период · по выручке',
      oz.errors.skus ? C.sectionError(oz.errors.skus) : Z.renderSkus(Z.skuTotals(oz.skus, app.ozView.rg)));
  }
  function ozErrorsHtml(app) {
    const oz = app.oz;
    return panel(app, 'ozErrors', '⚠️', 'Ошибки продавца', 'штрафы Ozon за период · новые сверху',
      oz.errors.list ? C.sectionError(oz.errors.list) : root.NietteOzon.renderErrors(oz.errorsList, app.ozView.rg));
  }

  function ozonHtml(app) {
    const oz = app.oz, f = ozFresh(app);
    if (oz.errors.daily) {
      app.ozView = null;
      return frame(app, { fresh: f.line, body: f.notes + C.sectionError(oz.errors.daily) });
    }
    ozCompute(app);
    return frame(app, { tools: root.NietteOverview.renderFilters(app.ovUi, app.ozView.rg, { groupings: true }),
                        fresh: f.line, body: ozBodyHtml(app, f) });
  }
  function ozBodyHtml(app, f) {
    return (f || ozFresh(app)).notes + ozKpisHtml(app) +
      quad(ozSalesHtml(app), ozMoneyHtml(app), ozSkuHtml(app), ozErrorsHtml(app)) +
      below(ozTableHtml(app) +
            section('ozNotes', 'Как читать эти числа', '', root.NietteOzon.renderNotes(), { icon: 'ℹ️' }));
  }

  function renderOzon(app) {
    show(app, ozonHtml(app));
    afterShow(app);
  }

  function rerenderOzon(app, keepFilters) {
    if (!keepFilters || app.oz.errors.daily) return renderOzon(app);
    ozCompute(app);
    swapBody(app, ozBodyHtml(app));
  }

  async function loadOzonScreen(app) {
    app.ozView = null;
    const g = app.gen;
    show(app, loadingHtml(app, 'Загружаю Ozon…'));
    const oz = await loadOzon(app.client);
    if (g !== app.gen) return;
    app.oz = oz;
    if (app.route === 'ozon') renderOzon(app);
  }

  // ── «Аналитика» ───────────────────────────────────────────────────────────
  // Спрос по дню заказа. График — та же стопка, что у «Обзора», только в
  // столбике не каналы, а исходы заказов. Квадранты: A — что стало с
  // заказами, B — товары, C — города, D — дни недели и способы доставки.
  function anFresh(app) {
    const f = app.an.fresh || {};
    const bits = [];
    if (app.an.snapAt) bits.push('Данные на ' + when(app.an.snapAt));
    if (f.kaspi_polled_at) bits.push('опрос Kaspi ' + when(f.kaspi_polled_at));
    bits.push('загружено ' + when(app.an.loadedAt));
    return freshParts(bits, [staleNote(app.an)]);
  }

  function anCompute(app) {
    const O = root.NietteOverview, A = root.NietteAnalytics, ui = app.ovUi, an = app.an;
    const today = O.todayIso(app.now());
    const rg = periodRange(app, an.rows);
    const prg = O.prevRange(ui.preset === 'custom' ? 'custom' : ui.preset, rg);
    const series = A.buildSeries(an.rows, rg, ui.grouping, today);
    // Упал снимок городов — фильтра нет, график по всем городам.
    const city = an.errors.cities ? '' : app.anUi.city;
    app.anView = {
      rg, prg, city, series,
      k: A.metrics(an.rows, rg),
      pk: prg ? A.metrics(an.rows, prg) : null,
      cityOptions: an.errors.cities ? null : A.cityOptions(an.cities, rg, city),
      // у графика города те же бакеты, что у общего: индекс подсказки общий
      chartSeries: city ? A.buildSeries(A.cityRows(an.cities, city), rg, ui.grouping, today) : series
    };
    return app.anView;
  }

  function anChartHtml(app, width, height) {
    const v = app.anView;
    return root.NietteOverview.renderChart(v.chartSeries, root.NietteAnalytics.OUTCOMES, {}, width,
                                           app.ovUi.grouping, v.city ? 'Заказы в городе ' + v.city : 'Заказы',
                                           { height: height || 0 });
  }
  function anTrendHtml(app) {
    const v = app.anView;
    return panel(app, 'ovTrend', '📈', 'Что стало с заказами',
      C.esc(GROUP_SUB[app.ovUi.grouping]) + ' · по дню заказа · незакрытый период бледнее',
      '<div class="an-controls">' + root.NietteAnalytics.renderLegend() +
        (v.cityOptions ? root.NietteAnalytics.renderCityPicker(v.cityOptions, v.city) : '') + '</div>' +
      chartBox('ovChart', anChartHtml(app, chartW(app, 'ovChart'), chartH(app, 'ovChart'))),
      { fill: true });
  }
  function anKpisHtml(app) {
    return '<div id="anKpis" class="ribbon-kpis">' + root.NietteAnalytics.renderKpis(app.anView.k, app.anView.pk) + '</div>';
  }
  function anTableHtml(app) {
    return section('ovTable', 'По периодам', 'по дню заказа · новые сверху · итог сходится с карточками',
                   root.NietteAnalytics.renderTable(app.anView.series), { icon: '📅' });
  }
  // Дни недели и способы доставки — один квадрант, два блока подряд.
  function anWeekDeliveryHtml(app) {
    const A = root.NietteAnalytics, an = app.an, rg = app.anView.rg;
    const sub = (id, title, note, inner) => '<div class="qp-part" id="' + id + '"><h3 class="st-subhead">' + C.esc(title) +
      ' <span class="muted">· ' + C.esc(note) + '</span></h3>' + inner + '</div>';
    return panel(app, 'anPair', '🗓', 'Дни недели и доставка', 'по дню заказа',
      sub('anWeek', 'Дни недели', 'в среднем за день · когда заказывают', A.renderWeekdays(A.weekdays(an.rows, rg), rg)) +
      sub('anDelivery', 'Способы доставки', 'по дню заказа',
          an.errors.delivery ? C.sectionError(an.errors.delivery) : A.renderDelivery(A.deliveryTotals(an.delivery, rg))));
  }
  function anSkuHtml(app) {
    const A = root.NietteAnalytics, an = app.an;
    return panel(app, 'anSkus', '🧷', 'Товары', 'по дню заказа · что заказали и что выкупили',
      an.errors.skus ? C.sectionError(an.errors.skus) : A.renderSkus(A.skuTotals(an.skus, app.anView.rg)));
  }
  function anCityHtml(app) {
    const A = root.NietteAnalytics, an = app.an;
    return panel(app, 'anCities', '📍', 'Города', 'по дню заказа · город доставки',
      an.errors.cities ? C.sectionError(an.errors.cities) : A.renderCities(A.cityTotals(an.cities, app.anView.rg), 15));
  }

  function analyticsHtml(app) {
    const an = app.an, f = anFresh(app);
    if (an.errors.daily) {
      app.anView = null;
      return frame(app, { fresh: f.line, body: f.notes + C.sectionError(an.errors.daily) });
    }
    anCompute(app);
    return frame(app, { tools: root.NietteOverview.renderFilters(app.ovUi, app.anView.rg, { groupings: true }),
                        fresh: f.line, body: anBodyHtml(app, f) });
  }
  function anBodyHtml(app, f) {
    return (f || anFresh(app)).notes + anKpisHtml(app) +
      quad(anTrendHtml(app), anSkuHtml(app), anCityHtml(app), anWeekDeliveryHtml(app)) +
      below(anTableHtml(app) + section('anNotes', 'Как читать эти числа', '', root.NietteAnalytics.renderNotes(), { icon: 'ℹ️' }));
  }

  function renderAnalytics(app) {
    show(app, analyticsHtml(app));
    afterShow(app);
  }

  function rerenderAnalytics(app, keepFilters) {
    if (!keepFilters || app.an.errors.daily) return renderAnalytics(app);
    anCompute(app);
    swapBody(app, anBodyHtml(app));
  }

  async function loadAnalyticsScreen(app) {
    app.anView = null;
    const g = app.gen;
    show(app, loadingHtml(app, 'Загружаю аналитику…'));
    const an = await loadAnalytics(app.client);
    if (g !== app.gen) return;
    app.an = an;
    if (app.route === 'analytics') renderAnalytics(app);
  }

  // ── «Склад» ───────────────────────────────────────────────────────────────
  // Разметка и расчёты — в stock.js. Периода нет: остаток на сейчас.
  // Квадранты: A — остатки по группам, B — остатки по площадкам, C — приход
  // и списание, D — журналы; как сложился остаток и сверка — ниже.
  // Продажи из таблицы старше этого — остаток уже не учитывает свежие продажи.
  // Тот же порог, что у тревоги mirror_stale в гейте опросника (sql/10).
  const MIRROR_STALE_H = 6;

  function stFresh(app) {
    const f = app.st.fresh || {};
    const bits = [];
    if (app.st.snapAt) bits.push('Данные на ' + when(app.st.snapAt));
    if (f.stock_synced_at) bits.push('лист «Склад» ' + when(f.stock_synced_at));
    if (f.sales_synced_at) bits.push('продажи ' + when(f.sales_synced_at));
    bits.push('загружено ' + when(app.st.loadedAt));
    const notes = [staleNote(app.st)];
    const sales = f.sales_synced_at ? new Date(f.sales_synced_at) : null;
    if (sales && !isNaN(sales) && app.st.loadedAt - sales > MIRROR_STALE_H * 3600000) {
      notes.push('Продажи из таблицы не приезжали ' + Math.round((app.st.loadedAt - sales) / 3600000) +
                 ' ч — остаток не учитывает свежие продажи. Проверьте импорт в Apps Script.');
    }
    return freshParts(bits, notes);
  }

  function stockHtml(app) {
    const S = root.NietteStock, st = app.st, f = stFresh(app);
    if (st.errors.stock) return frame(app, { fresh: f.line, body: f.notes + C.sectionError(st.errors.stock) });
    const now = app.now(), win = app.stUi.win;
    const rep = st.errors.recon ? null : S.reconFor(st.recon, win);
    const form = app.stForm || (app.stForm = S.newForm(now));
    const del = { canWrite: st.canWrite, confirmDel: form.confirmDel };
    const delMsg = kind => (form.msg.del && form.msg.del.kind === kind
      ? '<div class="st-msg ' + (form.msg.del.tone === 'bad' ? 'st-bad-text' : 'st-good-text') + '" role="status">' +
        C.esc(form.msg.del.text) + '</div>' : '');
    const part = (id, title, note, inner) => '<div class="qp-part" id="' + id + '"><h3 class="st-subhead">' + C.esc(title) +
      ' <span class="muted">· ' + C.esc(note) + '</span></h3>' + inner + '</div>';
    return frame(app, { fresh: f.line, body:
      f.notes +
      S.pendingNote(st.pending, now) +
      '<div class="ribbon-kpis">' + S.renderKpis(S.kpis(st.rows, st.woffs, now)) + '</div>' +
      S.renderProblems(S.problems(st.rows, rep)) +
      quad(
        panel(app, 'stCards', '📦', 'Остатки', 'по группам · срочные сверху', S.renderCards(st.rows, now)),
        panel(app, 'stMp', '🌐', 'Остатки по площадкам', C.esc(S.mpSub()),
              st.errors.mp ? C.sectionError(st.errors.mp) : S.renderMp(S.mpReport(st.rows, st.mp), rep, win, now)),
        panel(app, 'stForms', '➕', 'Приход и списание', 'записанное видно в журналах сразу, в остатке — через минуту–две',
              S.renderForms(st.rows, form, { canWrite: st.canWrite, woffs: st.woffs, now })),
        panel(app, 'stLog', '🗒', 'Журналы', 'списания за 30 дней и приходы за 90',
              part('stWoff', 'Списания за 30 дней', 'брак, образцы, подарки — мимо продаж',
                   st.errors.woff ? C.sectionError(st.errors.woff) : delMsg('writeoff') + S.renderWriteoffs(st.woffs, now, del)) +
              part('stArr', 'Приходы за 90 дней', 'из формы и из листа «Приходы»',
                   st.errors.arr ? C.sectionError(st.errors.arr) : delMsg('arrival') + S.renderArrivals(st.arrs, now, del)))) +
      below(
        section('stTable', 'Как сложился остаток', 'с даты пересчёта · те же колонки, что на листе «Склад»',
                S.renderTable(st.rows), { icon: '🧮' }) +
        // Сверка и склады Kaspi — одно окно на двоих, как в старом табе.
        section('stRecon', 'Сверка: что не доехало до остатка', C.esc(S.reconSub(rep, win)),
                S.winToolbar(win) + (st.errors.recon ? C.sectionError(st.errors.recon) : S.renderRecon(rep, win, st.rows)), { icon: '🔎' }) +
        section('stPoints', 'Склады отгрузки Kaspi', C.esc(S.pointsSub(rep, win)),
                st.errors.recon ? C.sectionError(st.errors.recon) : S.renderPoints(rep), { icon: '🚚' }) +
        section('stNotes', 'Как читать эти числа', '', S.renderNotes(), { icon: 'ℹ️' })) });
  }

  function renderStock(app) { show(app, stockHtml(app)); afterShow(app); }

  // ── Формы «Склада» (sql/26) ──────────────────────────────────────────────
  // Ошибки форм — текстом базы: его пишет sql/26 по-русски и для человека.
  // Поверх — только то, что база сказать не может.
  function formError(err) {
    const msg = String((err && (err.message || err.error_description)) || err || '');
    const code = String((err && err.code) || '');
    if (code === 'PGRST202' || /could not find the function/i.test(msg))
      return 'Форм ещё нет в базе — выполните sql/26_stock_forms.sql, затем sql/12_auth.sql.';
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg))
      return 'Нет связи с базой. Прежде чем вносить снова, обновите экран и проверьте журнал — запись могла дойти.';
    if (code === '57014' || /statement timeout|canceling statement/i.test(msg))
      return 'База не успела ответить. Обновите экран и проверьте журнал, прежде чем вносить снова.';
    if (/jwt expired|invalid jwt/i.test(msg) || /^PGRST30/.test(code)) return 'Сессия истекла — войдите заново. Ничего не записано.';
    return msg || 'Не записано: неизвестная ошибка.';
  }

  async function stReload(app) {
    const g = app.gen;
    const st = await loadStock(app.client);
    if (g !== app.gen) return;
    app.st = st;
    if (app.route === 'stock') renderStock(app);
  }

  function stMsg(app, slot, tone, text) {
    app.stForm.msg[slot] = { tone, text };
    renderStock(app);
  }

  async function stSaveArrival(app) {
    const S = root.NietteStock, f = app.stForm, a = f.arr;
    if (f.busy) return;
    const row = (app.st.rows || []).find(r => S.itemKey(r) === a.key);
    if (!row) return stMsg(app, 'arr', 'bad', 'Выберите товар.');
    const n = Number(String(a.qty).replace(',', '.'));
    if (!(n > 0)) return stMsg(app, 'arr', 'bad', 'Укажите количество.');
    f.busy = 'arr'; f.msg.arr = null;
    renderStock(app);
    const g = app.gen;
    let res;
    try {
      res = await app.client.rpc('form_add_arrival', { entry: {
        sku: row.sku || '', name: row.name || '', qty: n, day: a.day || '', supplier: a.supplier || '', comment: a.comment || '' } });
    } catch (e) { res = { error: e }; }
    if (g !== app.gen) return;                 // пока писалось, вышли: экран не рисуем
    f.busy = null;
    if (res.error) return stMsg(app, 'arr', 'bad', formError(res.error));
    const d = res.data || {};
    a.qty = ''; a.supplier = ''; a.comment = '';
    f.msg.arr = { tone: 'ok', text: 'Записано ' + (d.id || '') + ': +' + n + ' шт — ' + S.displayName(row.name, row.sku) + '. ' +
      (d.before_count ? 'Дата раньше пересчёта — на остаток не повлияет: пересчёт уже включает эту партию.'
                      : 'В остатке — через минуту–две.') };
    return stReload(app);
  }

  async function stSaveWriteoffs(app) {
    const S = root.NietteStock, f = app.stForm, w = f.wo, rows = app.st.rows || [];
    if (f.busy) return;
    const sel = S.woSelected(f, rows);
    if (!sel.length) return stMsg(app, 'wo', 'bad', 'Отметьте позиции и укажите количество.');
    if (!String(w.who || '').trim()) return stMsg(app, 'wo', 'bad', 'Укажите, кто взял.');
    // Больше, чем лежит, — почти всегда опечатка. Один раз на всю партию,
    // поимённо, как в старом табе; второе нажатие — «всё равно списать».
    if (S.woOver(f, rows).length && !w.confirmOver) {
      w.confirmOver = true; f.msg.wo = null;
      return renderStock(app);
    }
    f.busy = 'wo'; f.msg.wo = null;
    renderStock(app);
    const g = app.gen;
    let res;
    try {
      res = await app.client.rpc('form_add_writeoffs', { entry: {
        items: sel.map(x => ({ sku: x.row.sku || '', name: x.row.name || '', qty: x.qty })),
        day: w.day || '', reason: w.reason, taken_by: String(w.who).trim(), comment: w.comment || '' } });
    } catch (e) { res = { error: e }; }
    if (g !== app.gen) return;
    f.busy = null;
    if (res.error) return stMsg(app, 'wo', 'bad', formError(res.error));
    const d = res.data || {}, late = d.before_count || [];
    w.sel = {}; w.search = ''; w.comment = ''; w.confirmOver = false;
    f.msg.wo = { tone: 'ok', text: 'Списано: ' + sel.length + ' ' + (sel.length === 1 ? 'позиция' : sel.length < 5 ? 'позиции' : 'позиций') +
      ', ' + sel.reduce((a, x) => a + x.qty, 0) + ' шт. ' +
      (late.length ? 'Дата раньше пересчёта у: ' + late.join(', ') + ' — на их остаток не повлияет. ' : '') +
      'В остатке — через минуту–две.' };
    return stReload(app);
  }

  async function stDelete(app, kind, id) {
    const f = app.stForm;
    if (f.busy) return;
    f.busy = 'del'; f.msg.del = null;
    const g = app.gen;
    let res;
    try { res = await app.client.rpc('form_delete_entry', { kind, entry_id: id }); }
    catch (e) { res = { error: e }; }
    if (g !== app.gen) return;
    f.busy = null; f.confirmDel = null;
    if (res.error) { f.msg.del = { kind, tone: 'bad', text: formError(res.error) }; return renderStock(app); }
    f.msg.del = { kind, tone: 'ok', text: 'Удалено: ' + id + '. Остаток вернётся через минуту–две.' };
    return stReload(app);
  }

  // Поле формы поменялось: состояние — в app.stForm, экран НЕ перерисовываем,
  // чтобы не терять фокус и курсор. Перерисовываются только список позиций
  // (при поиске) и сводка «выбрано N».
  const ST_FIELDS = { stArrItem: ['arr', 'key'], stArrQty: ['arr', 'qty'], stArrDay: ['arr', 'day'],
                      stArrSupplier: ['arr', 'supplier'], stArrComment: ['arr', 'comment'],
                      stWoReason: ['wo', 'reason'], stWoDay: ['wo', 'day'], stWoWho: ['wo', 'who'], stWoComment: ['wo', 'comment'] };
  function stFormInput(app, t) {
    if (!t || app.route !== 'stock' || !app.st || !app.stForm) return;
    const S = root.NietteStock, f = app.stForm, rootEl = app.root;
    const pick = rootEl.querySelector('#stWoPick');
    if (ST_FIELDS[t.id]) { const m = ST_FIELDS[t.id]; f[m[0]][m[1]] = t.value; return; }
    if (t.id === 'stWoSearch') {
      f.wo.search = t.value;
      if (pick) pick.innerHTML = S.renderWoPick(app.st.rows, f);
      return;
    }
    const kc = t.getAttribute ? t.getAttribute('data-wo-key') : null;
    const kq = t.getAttribute ? t.getAttribute('data-wo-qty') : null;
    if (kc === null && kq === null) return;
    const row = t.closest ? t.closest('.st-pick-row') : null;
    const box = row ? row.querySelector('input[type="checkbox"]') : null;
    const num = row ? row.querySelector('input[type="number"]') : null;
    if (kc !== null) {
      const s = f.wo.sel[kc] || { on: false, qty: '' };
      s.on = !!t.checked;
      if (!s.on) { s.qty = ''; if (num) num.value = ''; }
      f.wo.sel[kc] = s;
      if (s.on && !s.qty && num && num.focus) num.focus();
    } else {
      const s = f.wo.sel[kq] || { on: false, qty: '' };
      s.qty = t.value;
      if (Number(s.qty) > 0) { s.on = true; if (box) box.checked = true; }
      f.wo.sel[kq] = s;
    }
    // Выбор поменялся — прежнее «всё равно списать» больше не про эту партию.
    if (f.wo.confirmOver) {
      f.wo.confirmOver = false;
      const warn = rootEl.querySelector('#stWoForm .st-alert');
      if (warn && warn.parentNode) warn.parentNode.removeChild(warn);
    }
    const key = kc !== null ? kc : kq, r = (app.st.rows || []).find(x => S.itemKey(x) === key);
    const s = f.wo.sel[key];
    if (row && r) row.classList.toggle('over', !!(s && s.on && Number(s.qty) > 0 && C.isNum(r.current_stock) &&
                                                 Number(s.qty) > Number(r.current_stock)));
    const sel = S.woSelected(f, app.st.rows || []);
    const sum = rootEl.querySelector('#stWoSum');
    if (sum) sum.textContent = S.woSumText(sel);
    const btn = rootEl.querySelector('[data-action="st-wo-save"]');
    if (btn && !f.busy) btn.textContent = sel.length > 1 ? 'Списать ' + sel.length + ' ' +
      (sel.length < 5 ? 'позиции' : 'позиций') : 'Списать';
  }

  async function loadStockScreen(app) {
    const g = app.gen;
    show(app, loadingHtml(app, 'Загружаю склад…'));
    const st = await loadStock(app.client);
    if (g !== app.gen) return;
    app.st = st;
    if (app.route === 'stock') renderStock(app);
  }

  // ── «B2B» ─────────────────────────────────────────────────────────────────
  // Расчёты и разметка — в b2b.js. Период — общий с «Обзором»: им режутся
  // только потоки («Поставлено», «Оплачено»); остаток — всегда на сегодня.
  // «Всё время» здесь — без границ, как в старом табе: поставка 23 марта и
  // поставка без единой оплаты считаются одинаково.
  function b2bPer(app) {
    if (app.ovUi.preset === 'all') return { from: '', to: '' };
    return periodRange(app, []);
  }
  // Даты в полях периода: у «всего времени» — с первой поставки или оплаты.
  function b2bInputsRange(app) {
    const per = b2bPer(app);
    if (per.from) return per;
    const O = root.NietteOverview, today = O.todayIso(app.now()), d = app.b2b.data;
    let min = '';
    (d.shipments || []).forEach(s => { if (s.ship_day && (!min || s.ship_day < min)) min = s.ship_day; });
    (d.payments || []).forEach(p => { if (p.pay_day && (!min || p.pay_day < min)) min = p.pay_day; });
    return { from: min && min < today ? min : today, to: today };
  }

  function b2bModel(app) {
    return app.b2bModel || (app.b2bModel = root.NietteB2b.prepare(app.b2b.data, root.NietteOverview.todayIso(app.now())));
  }

  function b2bFresh(app) {
    const st = app.b2b.status || {}, bits = [], notes = [];
    // Журнал загрузок (sync_log) торгпреду не виден — не его раздел, и
    // mirror_synced_at у него пуст. Тогда время зеркала — то, что взял
    // последний перенос (src_synced_at): застыли листы — застынет и оно.
    const mirrorAt = st.mirror_synced_at || st.src_synced_at || null;
    if (st.imported_at) bits.push('Перенос из таблицы ' + when(st.imported_at));
    if (mirrorAt) bits.push('зеркало ' + when(mirrorAt));
    bits.push('загружено ' + when(app.b2b.loadedAt));
    const synced = mirrorAt ? new Date(mirrorAt) : null;
    const imported = st.imported_at ? new Date(st.imported_at) : null;
    if (!imported) notes.push('Перенос из таблицы ещё ни разу не работал — Supabase → SQL Editor: select b2b_import(true);');
    if (synced && !isNaN(synced) && app.b2b.loadedAt - synced > MIRROR_STALE_H * 3600000) {
      notes.push('Таблица не приезжала ' + Math.round((app.b2b.loadedAt - synced) / 3600000) +
                 ' ч — новых поставок и оплат здесь нет. Проверьте Apps Script.');
    }
    if (st.mode !== 'live' && synced && imported && synced - imported > 15 * 60000) {
      notes.push('Перенос отстаёт от зеркала: листы приехали, а таблицы не обновились. Проверка: sql/diag_b2b.sql.');
    }
    const f = freshParts(bits, notes);
    const p = b2bPerm(app);
    const ro = p.write ? root.NietteB2bForms.renderTraining(p)
      : st.mode === 'live' ? '<p class="note b2b-ro">Только чтение: вносить могут те, кому владелец включил право записи.</p>'
      : '<p class="note b2b-ro">Только чтение: поставки, оплаты и визиты пока вносятся в старом табе B2B ' +
        'и в мобильном торгпреда — сюда они приходят с зеркалом таблицы, днём обычно через 15–30 минут.</p>';
    f.notes += ro + (app.b2bNotice ? '<div class="st-msg ' + (app.b2bNotice.tone === 'bad' ? 'st-bad-text' : 'st-good-text') + '" role="status">' +
      C.esc(app.b2bNotice.text) + '</div>' : '');
    return f;
  }

  // KPI периода — лента над квадрантами; её перерисовывает смена периода.
  function b2bOvInner(app, m, per, k) {
    return root.NietteB2b.renderKpis(k, per, app.b2bUi);
  }
  // A — что горит сегодня. Пусто — так и сказано: квадрант не пропадает.
  function b2bUrgentHtml(app, m) {
    const B = root.NietteB2b, urg = B.renderUrgent(B.urgent(m, app.b2bUi), m.today);
    return panel(app, 'b2bUrgent', '🔥', 'Горит сегодня', 'требует внимания прямо сейчас',
                 urg || '<p class="empty">Сегодня ничего не горит: просроченных оплат и пропущенных контактов нет.</p>');
  }
  function b2bOverdueHtml(app, m) {
    const B = root.NietteB2b, ui = app.b2bUi, p = b2bPerm(app);
    return panel(app, 'b2bOverdue', '⏳', 'Разбор просрочки', 'поставки партнёров, у которых затих счёт',
      B.renderOverdue(B.overdueShipments(m).filter(r => B.ovInScope(m, ui, r.cid)), ui.overdueOpen,
                      p.write ? { perm: p, bulk: app.b2bBulk } : undefined));
  }
  function b2bForecastHtml(app, m) {
    const B = root.NietteB2b;
    return panel(app, 'b2bForecast', '📅', 'Прогноз поступлений', 'по срокам оплаты из поставок',
                 B.renderForecast(B.forecast(m, app.b2bUi), app.b2bUi.fc, m.today));
  }
  function b2bPartnersHtml(app, m) {
    const B = root.NietteB2b;
    return panel(app, 'b2bPartners', '🤝', 'Партнёры', 'контрагенты, деньги и последний контакт · клик по названию — карточка партнёра',
                 B.renderPartnerToolbar(app.b2bUi.p) + '<div id="b2bPartnersBody">' + b2bPartnersBody(app, m) + '</div>');
  }
  function b2bPartnersBody(app, m) {
    const B = root.NietteB2b;
    return B.renderPartners(B.partnerRows(m, app.b2bUi.p, app.b2bUi.showClosed), app.b2bUi.p, m.today);
  }

  function b2bHtml(app) {
    const B = root.NietteB2b, b = app.b2b, f = b2bFresh(app);
    const core = B2B_CORE.map(k => b.errors[k]).filter(Boolean);
    if (core.length) return frame(app, { fresh: f.line, body: f.notes + C.sectionError(core[0]) });
    const m = b2bModel(app);
    if (app.b2bUi.card) {
      const cm = B.cardModel(m, app.b2bUi.card);
      const partial = Object.keys(b.errors).map(k => b.errors[k]);
      if (cm) {
        const p = b2bPerm(app);
        const act = { perm: p, confirm: app.b2bAct.confirm, signed: app.b2bSigned, waybillsFrom: b2bWaybillsFrom(app),
                      top: (p.write ? root.NietteB2bForms.renderActions(p, true) + b2bFormPanel(app, m, cm) : '') + b2bPdfPanel(app) };
        return frame(app, { sub: 'карточка партнёра', fresh: f.line, rail: false,
          body: f.notes + partial.map(e => C.sectionError(e)).join('') + B.renderCard(cm, m.today, act) });
      }
      app.b2bUi.card = null;                     // партнёра больше нет (обновили, удалили) — к списку
      if (app.b2bForm && app.b2bForm.cid && !m.byId[app.b2bForm.cid]) app.b2bForm = null;
    }
    const per = b2bPer(app), k = B.kpis(m, app.b2bUi, per), p = b2bPerm(app);
    // Квадранты: A — горит сегодня, B — прогноз поступлений, C — разбор
    // просрочки, D — партнёры. Период режет только потоки (KPI), остаток —
    // на сегодня.
    // Срез партнёров и кнопки «внести» — одной строкой: над квадрантами
    // место дорогое. Открытая форма — сразу под ней, как раньше.
    return frame(app, { tools: root.NietteOverview.renderFilters(app.ovUi, b2bInputsRange(app)), fresh: f.line, body:
      f.notes +
      '<div class="b2b-bar">' + B.renderFilters(app.b2bUi, k) + (p.write ? root.NietteB2bForms.renderActions(p, false) : '') + '</div>' +
      (p.write ? b2bFormPanel(app, m, null) : '') + b2bPdfPanel(app) +
      '<div id="b2bOv" class="ribbon-kpis">' + b2bOvInner(app, m, per, k) + '</div>' +
      quad(b2bUrgentHtml(app, m), b2bForecastHtml(app, m), b2bOverdueHtml(app, m), b2bPartnersHtml(app, m)) +
      below(section('b2bNotes', 'Как читать эти числа', '', B.renderNotes(), { icon: 'ℹ️' })) });
  }

  function renderB2b(app) {
    show(app, b2bHtml(app));
    if (app.b2bUi.card) b2bSign(app);
    afterShow(app);
  }

  // Период поменялся — пересчитать всё, что от него зависит, не трогая поля
  // дат и открытую форму: KPI, «горит», просрочку и прогноз.
  function rerenderB2b(app, keep) {
    if (!keep || app.b2bUi.card) return renderB2b(app);
    const m = b2bModel(app), per = b2bPer(app), k = root.NietteB2b.kpis(m, app.b2bUi, per);
    const box = app.root.querySelector('#b2bOv');
    if (box) box.innerHTML = b2bOvInner(app, m, per, k);
    swapSection(app, 'b2bUrgent', b2bUrgentHtml(app, m));
    swapSection(app, 'b2bOverdue', b2bOverdueHtml(app, m));
    swapSection(app, 'b2bForecast', b2bForecastHtml(app, m));
    refreshRail(app);
    syncPresetButtons(app);
  }
  function swapSection(app, id, html) {
    const el = app.root.querySelector('#' + id);
    if (el) el.outerHTML = html;
  }

  async function loadB2bScreen(app) {
    const g = app.gen;
    show(app, loadingHtml(app, 'Загружаю B2B…'));
    const b2b = await loadB2b(app.client);
    if (g !== app.gen) return;
    app.b2b = b2b;
    app.b2bModel = null;
    if (app.route === 'b2b') renderB2b(app);
  }

  // ── Формы «B2B» (sql/31_b2b_write.sql) ───────────────────────────────────
  // Разметка и тела запросов — в b2b_forms.js. Здесь — сеть, файлы и события.
  // Права держит база (b2b_w_guard); страница по app_me и режиму только не
  // показывает кнопок, которые всё равно получили бы отказ.
  function b2bPerm(app) {
    const F = root.NietteB2bForms;
    return F ? F.perm(app.me, app.b2b && app.b2b.status) : { write: false, full: false, canPay: false, training: false, live: false };
  }
  function b2bToday(app) { return root.NietteOverview.todayIso(app.now()); }

  function b2bFormPanel(app, m, cm) {
    const form = app.b2bForm;
    if (!form) return '';
    // Форма из карточки — про этого партнёра; со списка — свой выбор партнёра.
    if (!!cm !== !!form.inCard || (cm && form.cid !== s0(cm.c.id))) return '';
    const D = root.NietteB2bDocs;
    if (form.kind === 'doc') return '<div id="b2bFormPanel">' + D.renderDocForm(form, m, {
      today: b2bToday(app), perm: b2bPerm(app), nomen: app.b2b.data.nomen || [], cm, contract: b2bContract(cm && cm.c) }) + '</div>';
    if (form.kind === 'docset') return '<div id="b2bFormPanel">' + D.renderSettingsForm(form) + '</div>';
    return '<div id="b2bFormPanel">' + root.NietteB2bForms.renderForm(form, m, {
      today: b2bToday(app), perm: b2bPerm(app), nomen: app.b2b.data.nomen || [], cm, bundle: b2bBundle(app) }) + '</div>';
  }
  // Граница накладных и довесок — из реквизитов (sql/32); нет строки — без них.
  function b2bDocset(app) { return ((app.b2b && app.b2b.data.docset) || [])[0] || {}; }
  function b2bWaybillsFrom(app) { return String(b2bDocset(app).waybills_from || '').slice(0, 10); }
  function b2bBundle(app) {
    const st = b2bDocset(app);
    return { rules: (app.b2b && app.b2b.data.bundles) || [], price: st.bundle_price === undefined ? null : st.bundle_price };
  }
  // Число довеска и итог — на месте, без перерисовки: курсор остаётся в поле.
  function b2bBundleInfo(app) {
    const F = root.NietteB2bForms, form = app.b2bForm;
    const el = app.root.querySelector('#bfBundleInfo');
    if (!form || form.kind !== 'shipment' || !el) return;
    const bv = F.bundleView(form, b2bBundle(app), b2bToday(app));
    el.textContent = F.bundleInfo(bv, F.shipmentTotal(form.items));
    const inp = app.root.querySelector('#bfBundle');
    if (inp && bv) inp.placeholder = String(bv.autoQty).replace('.', ',');
  }
  // Договор — номер И дата (как b2b_w_doc_contract в sql/32): без него счёт не выписывается.
  function b2bContract(c) {
    const no = String((c && c.contract_no) || '').replace(/^[№#\s]+/, '').trim(), day = c && c.contract_date;
    if (!no || !/^\d{4}-\d{2}-\d{2}/.test(String(day || ''))) return null;
    const d = String(day);
    return { no, day: d, text: 'Договор №' + no + ' от ' + d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4) };
  }
  // Ответ базы может прийти, когда человек уже на другой вкладке: состояние
  // формы обновлено, а экран не наш — его не трогаем (вернётся — увидит).
  function b2bRedraw(app) {
    if (app.route === 'b2b' && app.b2b) renderB2b(app);
  }
  function b2bRenderPanel(app) {
    if (app.route !== 'b2b' || !app.b2b) return;
    const box = app.root.querySelector('#b2bFormPanel');
    if (!box) return renderB2b(app);
    const m = b2bModel(app), cm = app.b2bUi.card ? root.NietteB2b.cardModel(m, app.b2bUi.card) : null;
    box.outerHTML = b2bFormPanel(app, m, cm) || '<div id="b2bFormPanel"></div>';
  }
  // Ошибки — текстом базы (sql/31 пишет их по-русски и для человека); поверх —
  // только то, что база сказать не может.
  function b2bFormError(err) {
    const msg = String((err && (err.message || err.error_description)) || err || '');
    const code = String((err && err.code) || '');
    if (code === 'PGRST202' || /could not find the function/i.test(msg))
      return 'Функций записи B2B нет в базе — выполните sql/31_b2b_write.sql, затем sql/12_auth.sql.';
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg))
      return 'Нет связи с базой. Прежде чем вносить снова, нажмите «Обновить» и проверьте карточку — запись могла дойти.';
    if (code === '57014' || /statement timeout|canceling statement/i.test(msg))
      return 'База не успела ответить. Обновите экран и проверьте карточку, прежде чем вносить снова.';
    if (/jwt expired|invalid jwt/i.test(msg) || /^PGRST30/.test(code)) return 'Сессия истекла — войдите заново. Ничего не записано.';
    return msg || 'Не записано: неизвестная ошибка.';
  }

  function b2bFindRec(app, kind, id) {
    const d = app.b2b.data, list = { shipment: d.shipments, payment: d.payments, visit: d.visits, branch: d.branches }[kind] || [];
    return list.find(r => s0(r.id) === s0(id)) || null;
  }

  function b2bOpenForm(app, kind, el) {
    const F = root.NietteB2bForms, ui = app.b2bUi, m = b2bModel(app), today = b2bToday(app);
    const cid = ui.card || '';
    let form;
    if (kind === 'row') {
      const rk = el.getAttribute('data-rowkind'), rec = b2bFindRec(app, rk, el.getAttribute('data-id'));
      if (!rec) return;
      form = F.newForm('row', { cid, rec, rowKind: rk }, today);
    } else if (kind === 'edit') {
      form = F.newForm('edit', { cid, rec: m.byId[cid] }, today);
    } else if (kind === 'doc') {
      if (!cid) return;
      form = root.NietteB2bDocs.newDocForm(el.getAttribute('data-doc'), { cid }, today);
    } else if (kind === 'docset') {
      form = root.NietteB2bDocs.newSettingsForm(null, null);
    } else {
      form = F.newForm(kind, { cid }, today);
    }
    form.inCard = !!ui.card;
    app.b2bForm = form;
    app.b2bAct.confirm = null;
    app.b2bNotice = null;
    renderB2b(app);
    if (kind === 'payment' && form.cid) b2bLoadUnpaid(app, form);
    if (kind === 'doc') b2bLoadDocLines(app, form);
    if (kind === 'docset') b2bLoadDocSettings(app, form);
    const first = app.root.querySelector('#b2bForm input:not([type="checkbox"]):not([type="file"]), #b2bForm select');
    if (first && first.focus) first.focus();
  }

  // «За что можно платить» — витрина базы, та же, по которой её проверяет
  // form_b2b_add_payment: расчёт один на двоих.
  async function b2bLoadUnpaid(app, form) {
    const cid = form.cid, g = app.gen;
    form.unpaid = null; form.unpaidErr = null; form.qty = {};
    b2bRenderPanel(app);
    let res;
    try { res = await app.client.from('v_b2b_unpaid_items').select('*').eq('client_id', cid); }
    catch (e) { res = { error: e }; }
    if (g !== app.gen || app.b2bForm !== form || form.cid !== cid) return;
    if (res.error) form.unpaidErr = /does not exist|PGRST205|42P01/.test(String(res.error.message || res.error.code || ''))
      ? 'Нет витрины v_b2b_unpaid_items — выполните sql/31_b2b_write.sql, затем sql/12_auth.sql.' : humanError(res.error, 'За что платить');
    form.unpaid = res.error ? [] : (res.data || []);
    b2bRenderPanel(app);
  }

  // Строки поставок для документа и следующий номер — из базы (sql/32): те же
  // строки возьмёт автонакладная и переформирование, расчёт один.
  async function b2bLoadDocLines(app, form) {
    const cid = form.cid, g = app.gen;
    form.lines = null; form.linesErr = null;
    const q = (t, f) => Promise.resolve().then(f).then(r => r || { error: 'пустой ответ' }, e => ({ error: e }));
    const [lines, next] = await Promise.all([
      q('lines', () => app.client.from('v_b2b_doc_lines').select('*').eq('client_id', cid)),
      q('next', () => app.client.from('v_b2b_doc_next').select('*'))]);
    if (g !== app.gen || app.b2bForm !== form || form.cid !== cid) return;
    const miss = e => /does not exist|PGRST205|42P01|could not find/i.test(String((e && (e.message || e.code)) || e || ''));
    if (lines.error) form.linesErr = miss(lines.error) ? 'Нет витрины строк документов — выполните sql/32_b2b_docs.sql, затем sql/12_auth.sql.'
                                                       : humanError(lines.error, 'Строки поставок');
    form.lines = lines.error ? [] : (lines.data || []);
    form.next = next.error ? null : ((next.data || [])[0] || null);
    const m = b2bModel(app), cm = root.NietteB2b.cardModel(m, cid);
    if (cm) root.NietteB2bDocs.prefill(form, cm, b2bWaybillsFrom(app));
    b2bRenderPanel(app);
  }
  async function b2bLoadDocSettings(app, form) {
    const g = app.gen;
    let rec, next;
    try { [rec, next] = await Promise.all([app.client.from('b2b_doc_settings').select('*'), app.client.from('v_b2b_doc_next').select('*')]); }
    catch (e) { rec = { error: e }; }
    if (g !== app.gen || app.b2bForm !== form) return;
    if (rec.error || !(rec.data || []).length) {
      form.loadErr = rec.error ? humanError(rec.error, 'Реквизиты') : 'Строки реквизитов нет — выполните sql/32_b2b_docs.sql.';
      return b2bRenderPanel(app);
    }
    const fresh = root.NietteB2bDocs.newSettingsForm(rec.data[0], next && !next.error ? (next.data || [])[0] : null);
    fresh.inCard = form.inCard;
    app.b2bForm = fresh;
    b2bRenderPanel(app);
  }

  // ── PDF документа (pdfmake, web/app/vendor) ──────────────────────────────
  // Библиотека (~1,8 МБ со шрифтами) грузится, только когда просят PDF.
  function b2bScript(src) {
    return new Promise((res, rej) => {
      const d = root.document, el = d.createElement('script');
      el.src = src; el.async = true;
      el.onload = () => res();
      el.onerror = () => rej(new Error('Не загрузилась библиотека PDF (' + src + ') — проверьте связь и обновите страницу.'));
      d.head.appendChild(el);
    });
  }
  function b2bPdfLib(app) {
    if (root.pdfMake && root.pdfMake.__nietteFonts) return Promise.resolve(root.pdfMake);
    if (!app.b2bPdfLib) {
      app.b2bPdfLib = b2bScript('vendor/pdfmake-0.2.20.min.js').then(() => b2bScript('vendor/pdf-fonts-roboto.js')).then(() => {
        if (!root.pdfMake || !root.pdfMake.__nietteFonts) throw new Error('Библиотека PDF загрузилась без шрифтов — обновите страницу.');
        return root.pdfMake;
      });
      app.b2bPdfLib.catch(() => { app.b2bPdfLib = null; });
    }
    return app.b2bPdfLib;
  }
  function b2bPdfDrop(app) {
    const p = app.b2bPdf;
    if (p && p.url && root.URL && root.URL.revokeObjectURL) { try { root.URL.revokeObjectURL(p.url); } catch (e) { /* уже нет */ } }
    app.b2bPdf = null;
  }
  // PDF показывается там, где его попросили: в карточке этого партнёра или
  // над списком партнёров.
  function b2bPdfPanel(app) {
    const p = app.b2bPdf, card = app.b2bUi.card || '';
    if (!p || (p.where === 'card' ? card !== p.cid : !!card)) return '';
    return root.NietteB2bDocs.renderPdfPanel(p);
  }
  function b2bPdfShow(app) {
    if (app.route !== 'b2b' || !app.b2b) return;
    const box = app.root.querySelector('#b2bPdf');
    const html = b2bPdfPanel(app);
    if (box) box.outerHTML = html || '';
    else renderB2b(app);
    const el = app.root.querySelector('#b2bPdf');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }
  // snap — снимок, если он уже есть (ответ формы); иначе берём из базы.
  async function b2bDocPdf(app, id, snap) {
    const D = root.NietteB2bDocs, g = app.gen;
    b2bPdfDrop(app);
    app.b2bPdf = { id, busy: true, where: app.b2bUi.card ? 'card' : 'main', cid: app.b2bUi.card || '' };
    b2bPdfShow(app);
    let res = null, err = null;
    try {
      if (!snap) {
        const r = await app.client.from('b2b_docs').select('id,snapshot').eq('id', id);
        if (r.error) throw new Error(humanError(r.error, 'Документ'));
        // Строки нет — документ удалили или (до переключения) тренировку стёр
        // перенос из листов; строка без снимка — документ старой системы.
        if (!(r.data || []).length) throw new Error('Документа ' + id + ' больше нет — обновите экран.' +
          (b2bPerm(app).live ? '' : ' Тренировку стирает перенос из листов.'));
        snap = r.data[0].snapshot || null;
      }
      const dd = D.docDefinition(snap);
      const pm = await b2bPdfLib(app);
      const blob = await new Promise((ok, bad) => { try { pm.createPdf(dd).getBlob(ok); } catch (e) { bad(e); } });
      const name = D.fileName(snap);
      let canShare = false;
      try {
        const nav = root.navigator;
        canShare = !!(nav && nav.share && nav.canShare && root.File && nav.canShare({ files: [new root.File([blob], name, { type: 'application/pdf' })] }));
      } catch (e) { canShare = false; }
      res = { id, number: snap.number, kind: snap.kind, name, blob, canShare, cid: app.b2bPdf.cid, where: app.b2bPdf.where,
              url: root.URL.createObjectURL(blob) };
    } catch (e) { err = (e && e.message) || humanError(e, 'PDF'); }
    if (g !== app.gen) { if (res && res.url) try { root.URL.revokeObjectURL(res.url); } catch (e) { /* */ } return; }
    if (!app.b2bPdf || app.b2bPdf.id !== id) { if (res && res.url) try { root.URL.revokeObjectURL(res.url); } catch (e) { /* */ } return; }
    app.b2bPdf = res || { id, err: 'PDF не собрался: ' + err, where: app.b2bPdf.where, cid: app.b2bPdf.cid };
    b2bPdfShow(app);
  }
  // Отправить — в WhatsApp, Telegram, почту (меню телефона). Нажатие —
  // отдельное: меню открывается только в ответ на нажатие, а не после
  // загрузки библиотеки.
  async function b2bDocShare(app) {
    const p = app.b2bPdf, nav = root.navigator;
    if (!p || !p.blob || !nav || !nav.share) return;
    try { await nav.share({ files: [new root.File([p.blob], p.name, { type: 'application/pdf' })], title: p.name.replace(/\.pdf$/, '') }); }
    catch (e) { /* закрыли меню — не ошибка */ }
  }

  async function b2bReload(app) {
    const g = app.gen;
    const b = await loadB2b(app.client);
    if (g !== app.gen) return;
    app.b2b = b;
    app.b2bModel = null;
    if (app.route === 'b2b') renderB2b(app);
  }

  // ── Файлы: сжатие и загрузка в хранилище (корзина b2b) ───────────────────
  function b2bUuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    const h = '0123456789abcdef';
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => h[Math.floor(Math.random() * 16)]);
  }
  // Фото — до 1600 пикселей по длинной стороне, JPEG: снимок телефона в
  // 3–5 МБ становится ~300 КБ. Не разобрал браузер (HEIC в Chrome) или сжатое
  // не меньше исходного — уходит как есть.
  async function b2bPrepareFile(file) {
    const F = root.NietteB2bForms;
    const ext = F.extOf(file.name, file.type);
    if (!ext) throw new Error('«' + file.name + '» — не фото и не документ (можно jpg, png, webp, heic, pdf, doc, docx).');
    if (/^(jpe?g|png|webp|heic|heif)$/.test(ext) && root.createImageBitmap && root.document) {
      try {
        const bmp = await root.createImageBitmap(file);
        const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        const cv = root.document.createElement('canvas');
        cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
        cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
        const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.82));
        if (blob && blob.size > 0 && blob.size < file.size) return { blob, ext: 'jpg', type: 'image/jpeg', name: file.name };
      } catch (e) { /* как есть */ }
    }
    if (file.size > F.MAX_FILE_MB * 1024 * 1024) throw new Error('«' + file.name + '» больше ' + F.MAX_FILE_MB + ' МБ.');
    return { blob: file, ext, type: file.type || F.MIME[ext], name: file.name };
  }
  // Сначала проверить и сжать ВСЕ файлы, потом грузить: отказ третьего не
  // оставит в хранилище первые два. Загруженное помнит форма (form.upl: файл →
  // имя в хранилище): повтор после отказа сети или базы берёт уже загруженное,
  // а не грузит второй раз — иначе в корзине копятся сироты.
  const b2bFileSig = f => f.name + ':' + f.size + ':' + (f.lastModified || 0);
  async function b2bUpload(app, form, kind, files, g) {
    const F = root.NietteB2bForms;
    if (files.length > F.MAX_FILES) throw new Error('Больше ' + F.MAX_FILES + ' файлов к одной записи.');
    if (!app.client.storage) throw new Error('Хранилище файлов недоступно — запишите без файлов.');
    const done = form.upl || (form.upl = {});
    const todo = [];
    for (const f of files) if (!done[b2bFileSig(f)]) todo.push({ sig: b2bFileSig(f), x: await b2bPrepareFile(f) });
    for (const t of todo) {
      if (done[t.sig]) continue;                 // один и тот же файл выбран дважды
      if (g !== app.gen) throw new Error('Вышли — загрузка остановлена.');
      const x = t.x, path = F.storagePath(kind, b2bToday(app), b2bUuid(), x.ext);
      let res;
      try { res = await app.client.storage.from('b2b').upload(path, x.blob, { contentType: x.type, upsert: false }); }
      catch (e) { res = { error: e }; }
      if (res && res.error) {
        throw new Error('«' + x.name + '» не загрузился: ' + (res.error.message || res.error) + '. Запись не сделана — попробуйте ещё раз или без файла.');
      }
      done[t.sig] = path;
    }
    return files.map(f => done[b2bFileSig(f)]).filter((p, i, a) => a.indexOf(p) === i);
  }
  // Временные ссылки на файлы карточки: хранилище закрыто, ссылка живёт час.
  async function b2bSign(app) {
    const B = root.NietteB2b, m = b2bModel(app), cm = B.cardModel(m, app.b2bUi.card);
    if (!cm || !app.client || !app.client.storage) return;
    const now = Date.now(), have = app.b2bSignedAt || (app.b2bSignedAt = {});
    const need = B.storageFiles(cm).filter(p => !app.b2bSigned[p] || now - (have[p] || 0) > 50 * 60000);
    if (!need.length) return;
    const g = app.gen, card = app.b2bUi.card;
    let res;
    try { res = await app.client.storage.from('b2b').createSignedUrls(need, 3600); }
    catch (e) { res = { error: e }; }
    if (g !== app.gen || res.error || !Array.isArray(res.data)) return;
    res.data.forEach(x => { if (x && x.signedUrl && x.path) { app.b2bSigned[x.path] = x.signedUrl; have[x.path] = now; } });
    if (app.route !== 'b2b' || app.b2bUi.card !== card) return;
    const box = app.root.querySelector('#b2bGallery');
    const cm2 = box ? B.cardModel(b2bModel(app), card) : null;
    if (cm2) box.outerHTML = B.renderGallerySection(cm2, app.b2bSigned);
  }

  // ── Сохранить ─────────────────────────────────────────────────────────────
  const RPC_ADD = { client: 'form_b2b_add_client', visit: 'form_b2b_add_visit', shipment: 'form_b2b_add_shipment',
                    payment: 'form_b2b_add_payment', round: 'form_b2b_add_round', branch: 'form_b2b_add_branch' };
  async function b2bCall(app, fn, args) {
    try { const r = await app.client.rpc(fn, args); return r || { error: 'пустой ответ' }; }
    catch (e) { return { error: e }; }
  }
  function b2bFormMsg(app, form, tone, text) {
    form.msg = { tone, text };
    form.busy = false;
    b2bRenderPanel(app);
  }
  async function b2bSave(app) {
    const F = root.NietteB2bForms, form = app.b2bForm;
    if (!form || form.busy) return;
    const kind = form.kind;
    const needCid = kind !== 'client' && kind !== 'docset' && !(kind === 'visit' && form.newClient);
    if (needCid && !form.cid) return b2bFormMsg(app, form, 'bad', 'Выберите партнёра.');
    if (kind === 'visit' && form.newClient && !String(form.nc.name || '').trim()) return b2bFormMsg(app, form, 'bad', 'Укажите название новой точки.');
    if (kind === 'payment') {
      const t = F.paymentTotals(form);
      if (t.over.length) return b2bFormMsg(app, form, 'bad', 'По позиции введено больше, чем осталось.');
      if (!t.lines) return b2bFormMsg(app, form, 'bad', 'Укажите, за какие позиции оплата, — или разнесите сумму по старым.');
    }
    if (kind === 'row') {
      const p = F.rowProblem(form);
      if (p) return b2bFormMsg(app, form, 'bad', p);
    }
    if (kind === 'doc' || kind === 'docset') return b2bSaveDoc(app, form);
    form.busy = true; form.msg = null;
    b2bRenderPanel(app);
    // Каждый ответ сети — после паузы: за это время могли выйти, а на этом
    // телефоне войти другим. Тогда дальше не идём — ни второй запрос, ни экран:
    // иначе запись ушла бы от чужого имени.
    const g = app.gen, gone = () => g !== app.gen;
    let files = [], res;
    if ((kind === 'visit' || kind === 'shipment') && (form.files || []).length) {
      try { files = await b2bUpload(app, form, kind, form.files, g); }
      catch (e) { if (!gone()) b2bFormMsg(app, form, 'bad', e.message); return; }
      if (gone()) return;
    }
    if (RPC_ADD[kind]) {
      const d = kind === 'client' ? F.clientPayload(form) : kind === 'visit' ? F.visitPayload(form, files)
              : kind === 'shipment' ? F.shipmentPayload(form, files) : kind === 'payment' ? F.paymentPayload(form)
              : kind === 'round' ? F.roundPayload(form) : F.branchPayload(form);
      res = await b2bCall(app, RPC_ADD[kind], { d });
    } else if (kind === 'edit') {
      const ch = F.clientChanges(form);
      if (!Object.keys(ch.patch).length && ch.counterparty === null && !ch.contract) return b2bFormMsg(app, form, 'bad', 'Ничего не изменено.');
      res = { data: { ok: true } };
      if (Object.keys(ch.patch).length) res = await b2bCall(app, 'form_b2b_update', { p_kind: 'client', p_id: form.cid, p_patch: ch.patch });
      if (gone()) return;
      if (!res.error && ch.counterparty !== null) res = await b2bCall(app, 'form_b2b_set_counterparty', { p_client_id: form.cid, p_value: ch.counterparty });
      if (gone()) return;
      if (!res.error && ch.contract) res = await b2bCall(app, 'form_b2b_set_contract', { p_client_id: form.cid, p_num: ch.contract.num, p_day: ch.contract.day });
    } else if (kind === 'row') {
      const patch = F.rowPatch(form);
      if (!Object.keys(patch).length) return b2bFormMsg(app, form, 'bad', 'Ничего не изменено.');
      res = await b2bCall(app, 'form_b2b_update', { p_kind: form.rowKind, p_id: form.id, p_patch: patch });
    } else if (kind === 'delclient') {
      res = await b2bCall(app, 'form_b2b_delete_client', { p_client_id: form.cid, p_confirm: form.f.confirm });
    }
    if (gone()) return;                        // пока писалось, вышли: экран не рисуем
    // Пока писалось, форму закрыли или открыли другую: ответ — плашкой над
    // экраном, а открытую форму с тем, что в ней набрано, не трогаем.
    const still = app.b2bForm === form;
    form.busy = false;
    if (res.error) {
      const text = b2bFormError(res.error);
      if (!still) {
        app.b2bNotice = { tone: 'bad', text: 'Не записано («' + F.formTitle(form) + '»): ' + text };
        return b2bRedraw(app);
      }
      if (/уже есть/.test(text) && (kind === 'client' || (kind === 'visit' && form.newClient))) {
        const nm = kind === 'client' ? form.f.name : form.nc.name, ct = kind === 'client' ? form.f.city : form.nc.city;
        form.dupAsk = true; form.dupFor = F.dupKey(nm, ct); form.f.allow_duplicate = false;
      }
      return b2bFormMsg(app, form, 'bad', text + (files.length ? ' Файлы уже загружены — при повторе второй раз не грузятся.' : ''));
    }
    const text = F.savedText(kind, res.data, { files: files.length });
    const wb = kind === 'shipment' && res.data && res.data.waybill && res.data.waybill.id ? res.data.waybill : null;
    if (!still) {
      app.b2bNotice = { tone: 'ok', text };
      if (kind === 'delclient' && app.b2bUi.card === form.cid) app.b2bUi.card = null;
    } else if (kind === 'delclient') {
      app.b2bForm = null; app.b2bUi.card = null; app.b2bNotice = { tone: 'ok', text };
    } else if (kind === 'edit' || kind === 'row') {
      app.b2bForm = null; app.b2bNotice = { tone: 'ok', text: 'Сохранено' + (res.data && res.data.training ? ' — тренировка.' : '.') };
    } else {
      // Новая форма того же вида и про того же партнёра — следующую запись не
      // надо начинать с выбора партнёра; сообщение — в ней же.
      const next = F.newForm(kind, { cid: kind === 'client' ? '' : form.cid }, b2bToday(app));
      next.inCard = form.inCard;
      next.msg = { tone: 'ok', text, doc: wb ? { id: wb.id, number: wb.number } : null };
      app.b2bForm = next;
    }
    await b2bReload(app);
    // Список «за что платить» — заново только у свежей формы; в чужой открытой
    // не стираем набранное: лишнее отвергнет база своим текстом.
    if (still && app.b2bForm && app.b2bForm.kind === 'payment' && app.b2bForm.cid) b2bLoadUnpaid(app, app.b2bForm);
  }

  // Нет функций документов — назвать файл документов, а не записи (31).
  function b2bDocError(err) {
    const code = String((err && err.code) || ''), msg = String((err && err.message) || err || '');
    if (code === 'PGRST202' || /could not find the function/i.test(msg))
      return 'Функций документов нет в базе — выполните sql/32_b2b_docs.sql, затем sql/12_auth.sql.';
    return b2bFormError(err);
  }
  // Документ, накладные на поставки без них, переформирование, «Оплачено»
  // (sql/32). Ответ — плашкой над экраном; новый документ — сразу в PDF.
  async function b2bSaveDoc(app, form) {
    const D = root.NietteB2bDocs, g = app.gen;
    let res;
    if (form.kind === 'doc') {
      const cm = root.NietteB2b.cardModel(b2bModel(app), form.cid);
      const problem = D.docProblem(form, b2bContract(cm && cm.c));
      if (problem) { form.touched = true; return b2bFormMsg(app, form, 'bad', problem); }
      form.busy = true; form.msg = null;
      b2bRenderPanel(app);
      res = await b2bCall(app, 'form_b2b_add_doc', { d: D.docPayload(form) });
    } else {
      const patch = D.settingsChanges(form);
      if (!Object.keys(patch).length) return b2bFormMsg(app, form, 'bad', 'Ничего не изменено.');
      form.busy = true; form.msg = null;
      b2bRenderPanel(app);
      res = await b2bCall(app, 'form_b2b_doc_settings', { p: patch });
    }
    if (g !== app.gen) return;
    const still = app.b2bForm === form;
    form.busy = false;
    if (res.error) {
      const text = b2bDocError(res.error);
      if (!still) { app.b2bNotice = { tone: 'bad', text: 'Не записано: ' + text }; return b2bRedraw(app); }
      return b2bFormMsg(app, form, 'bad', text);
    }
    const d = res.data || {};
    if (still) app.b2bForm = null;
    app.b2bNotice = { tone: 'ok', text: D.savedText(form.kind, d) };
    await b2bReload(app);
    if (form.kind === 'doc' && d.id && g === app.gen) b2bDocPdf(app, d.id, d.snapshot || null);
  }
  async function b2bDocAct(app, fn, args, kind, after) {
    if (app.b2bAct.busy) return;
    const g = app.gen;
    app.b2bAct.confirm = null; app.b2bAct.busy = true;
    const res = await b2bCall(app, fn, args);
    app.b2bAct.busy = false;
    if (g !== app.gen) return;
    app.b2bNotice = res.error ? { tone: 'bad', text: b2bDocError(res.error) } : { tone: 'ok', text: root.NietteB2bDocs.savedText(kind, res.data) };
    if (res.error) return b2bRedraw(app);
    await b2bReload(app);
    if (after && g === app.gen) after(res.data || {});
  }
  async function b2bDocPaid(app, id, paid, el) {
    const g = app.gen;
    const res = await b2bCall(app, 'form_b2b_doc_paid', { p_id: id, p_paid: !!paid });
    if (g !== app.gen) return;
    if (res.error) {
      if (el) el.checked = !paid;
      app.b2bNotice = { tone: 'bad', text: 'Отметка не сохранилась: ' + b2bDocError(res.error) };
      return b2bRedraw(app);
    }
    const row = (app.b2b.data.docs || []).find(x => s0(x.id) === s0(id));
    if (row) { row.paid = !!paid; row.paid_day = res.data && res.data.paid_day || null; app.b2bModel = null; }
    app.b2bNotice = { tone: 'ok', text: (paid ? 'Отмечено «оплачено»' : 'Снята отметка «оплачено»') + (res.data && res.data.training ? ' — тренировка.' : '.') };
    return b2bRedraw(app);
  }

  async function b2bDelete(app, kind, id) {
    if (app.b2bAct.busy) return;               // второе нажатие, пока идёт первое
    const g = app.gen;
    app.b2bAct.confirm = null; app.b2bAct.busy = true;
    const res = kind === 'doc' ? await b2bCall(app, 'form_b2b_doc_delete', { p_id: id })
                               : await b2bCall(app, 'form_b2b_delete', { p_kind: kind, p_id: id });
    if (res.error && kind === 'doc') res.error = { message: b2bDocError(res.error) };
    app.b2bAct.busy = false;
    if (g !== app.gen) return;
    app.b2bNotice = res.error ? { tone: 'bad', text: b2bFormError(res.error) }
      : { tone: 'ok', text: 'Удалено: ' + (kind === 'doc' && res.data && res.data.number ? res.data.number : id) +
          (res.data && res.data.items ? ' и ' + res.data.items + ' ' + (kind === 'payment' ? 'её позиций' : 'позиций') : '') +
          (res.data && res.data.docs ? ', её накладная' : '') +
          (kind === 'doc' ? ' — номер второй раз не выдаётся' : '') + (res.data && res.data.training ? '. Тренировка.' : '.') };
    if (!res.error && kind === 'doc' && app.b2bPdf && app.b2bPdf.id === id) b2bPdfDrop(app);
    if (res.error) return b2bRedraw(app);
    return b2bReload(app);
  }

  // Отмеченные — только среди видимых строк: что скрыл фильтр, того не
  // меняем. Кнопка считает видимые — запрос шлёт ровно их же.
  function b2bBulkIds(app) {
    const B = root.NietteB2b, m = b2bModel(app), sel = app.b2bBulk.sel;
    return B.overdueShipments(m).filter(r => B.ovInScope(m, app.b2bUi, r.cid) && sel[r.id]).map(r => r.id);
  }
  async function b2bBulkSave(app) {
    const bulk = app.b2bBulk, ids = b2bBulkIds(app);
    if (!ids.length || bulk.busy) return;
    bulk.busy = true; bulk.msg = null;
    swapSection(app, 'b2bOverdue', b2bOverdueHtml(app, b2bModel(app)));
    const g = app.gen;
    const res = await b2bCall(app, 'form_b2b_bulk_status', { p_ids: ids, p_status: bulk.status });
    if (g !== app.gen) return;
    bulk.busy = false;
    if (res.error) {
      bulk.msg = { tone: 'bad', text: b2bFormError(res.error) };
      return swapSection(app, 'b2bOverdue', b2bOverdueHtml(app, b2bModel(app)));
    }
    const d = res.data || {};
    bulk.sel = {};
    bulk.msg = { tone: 'ok', text: '«' + d.status + '»: изменено ' + (d.changed_count || 0) +
      (d.already && d.already.length ? ', уже было ' + d.already.length : '') + (d.missing && d.missing.length ? ', не найдено ' + d.missing.join(', ') : '') +
      (d.training ? '. Тренировка.' : '.') };
    return b2bReload(app);
  }

  async function b2bTrainReset(app) {
    if (app.b2bAct.busy) return;
    const g = app.gen;
    app.b2bAct.busy = true;
    const res = await b2bCall(app, 'form_b2b_training_reset', {});
    app.b2bAct.busy = false;
    if (g !== app.gen) return;
    app.b2bNotice = res.error ? { tone: 'bad', text: b2bFormError(res.error) }
                              : { tone: 'ok', text: 'Тренировка стёрта: таблицы снова — копия листов.' };
    app.b2bForm = null;
    if (res.error) return b2bRedraw(app);
    return b2bReload(app);
  }

  function b2bFormAction(app, action, el) {
    const F = root.NietteB2bForms, form = app.b2bForm;
    if (action === 'b2b-f-open') return b2bOpenForm(app, el.getAttribute('data-kind'), el);
    if (action === 'b2b-f-close') { app.b2bForm = null; return renderB2b(app); }
    if (action === 'b2b-f-save') return b2bSave(app);
    if (action === 'b2b-del') { app.b2bAct.confirm = el.getAttribute('data-kind') + ':' + el.getAttribute('data-id'); app.b2bNotice = null; return renderB2b(app); }
    if (action === 'b2b-del-no') { app.b2bAct.confirm = null; return renderB2b(app); }
    if (action === 'b2b-del-yes') return b2bDelete(app, el.getAttribute('data-kind'), el.getAttribute('data-id'));
    if (action === 'b2b-bulk-save') return b2bBulkSave(app);
    if (action === 'b2b-train-reset') return b2bTrainReset(app);
    if (action === 'b2b-doc-pdf') return b2bDocPdf(app, el.getAttribute('data-id'), null);
    if (action === 'b2b-doc-pdf-close') { b2bPdfDrop(app); return b2bPdfShow(app); }
    if (action === 'b2b-doc-share') return b2bDocShare(app);
    if (action === 'b2b-doc-regen') { app.b2bAct.confirm = 'regen:' + el.getAttribute('data-id'); app.b2bNotice = null; return renderB2b(app); }
    if (action === 'b2b-doc-regen-yes') {
      const id = el.getAttribute('data-id');
      return b2bDocAct(app, 'form_b2b_doc_regen', { p_id: id }, 'regen', d => b2bDocPdf(app, id, d.snapshot || null));
    }
    if (action === 'b2b-doc-missing') { app.b2bAct.confirm = 'docmiss:' + (app.b2bUi.card || ''); app.b2bNotice = null; return renderB2b(app); }
    if (action === 'b2b-doc-missing-yes') return b2bDocAct(app, 'form_b2b_doc_waybills_missing', { p_client_id: app.b2bUi.card }, 'missing');
    if (action === 'b2b-doc-ship') {
      const sid = el.getAttribute('data-id');
      return b2bDocAct(app, 'form_b2b_add_doc', { d: { kind: 'waybill', client_id: app.b2bUi.card, shipment_ids: [sid], from_shipments: true, once: true } },
                       'doc', d => { if (d.id) b2bDocPdf(app, d.id, d.snapshot || null); });
    }
    if (!form) return;
    if (form.kind === 'doc') {
      const D = root.NietteB2bDocs;
      if (action === 'b2b-doc-line-add') { form.items.push(D.emptyLine()); form.dirty = true; return b2bRenderPanel(app); }
      if (action === 'b2b-doc-line-del') { form.items.splice(Number(el.getAttribute('data-i')), 1); form.dirty = true; return b2bRenderPanel(app); }
      if (action === 'b2b-doc-fill') {
        form.dirty = false;
        const cm = root.NietteB2b.cardModel(b2bModel(app), form.cid);
        if (cm) D.prefill(form, cm, b2bWaybillsFrom(app));
        return b2bRenderPanel(app);
      }
      return;
    }
    if (action === 'b2b-f-item-add') { form.items.push(F.emptyItem()); return b2bRenderPanel(app); }
    if (action === 'b2b-f-item-del') { form.items.splice(Number(el.getAttribute('data-i')), 1); return b2bRenderPanel(app); }
    if (action === 'b2b-f-fifo') {
      const a = F.fifo(form.unpaid || [], form.f.received);
      form.qty = {};
      Object.keys(a.qty).forEach(k => { form.qty[k] = String(a.qty[k]); });
      form.f.advance = a.advance > 0 ? String(a.advance) : '';
      form.msg = null;
      return b2bRenderPanel(app);
    }
  }

  // Поле формы поменялось — в состояние; перерисовка — только зависимого.
  const BF = { bfName: 'name', bfType: 'type', bfStage: 'stage', bfCity: 'city', bfPriority: 'priority', bfAddress: 'address',
    bfContact: 'contact', bfPhone: 'phone', bfCounterparty: 'counterparty', bfComment: 'comment', bfDay: 'day', bfResult: 'result',
    bfPotential: 'potential', bfNextDay: 'next_day', bfBranch: 'branch_id', bfShipDay: 'ship_day', bfDueDay: 'due_day',
    bfMonthDay: 'month_day', bfWeekday: 'weekday', bfStatus: 'status', bfInvoice: 'invoice_no', bfAdvance: 'advance',
    bfMethod: 'method', bfReceipt: 'receipt_no', bfReceiver: 'receiver', bfRep: 'rep', bfContractNo: 'contract_no',
    bfContractDate: 'contract_date', bfConfirm: 'confirm', bfReceived: 'received', bfPayDay: 'pay_day', bfBundle: 'bundle_qty' };
  const BF_NC = { bfNcName: 'name', bfNcType: 'type', bfNcCity: 'city', bfNcAddress: 'address' };
  function b2bFormInput(app, t, evType) {
    if (!t || app.route !== 'b2b' || !app.b2b) return;
    const F = root.NietteB2bForms, rootEl = app.root;
    if (t.id === 'bfBulkStatus') { app.b2bBulk.status = t.value; return; }
    const bulkId = t.getAttribute ? t.getAttribute('data-bulk-id') : null;
    if (bulkId !== null) {
      app.b2bBulk.sel[bulkId] = !!t.checked;
      if (evType === 'change') {
        const btn = rootEl.querySelector('[data-action="b2b-bulk-save"]');
        const nSel = b2bBulkIds(app).length;
        if (btn) { btn.disabled = !nSel; btn.textContent = nSel ? 'Сменить у ' + nSel + ' ' + (nSel % 10 === 1 && nSel % 100 !== 11 ? 'поставки' : 'поставок') : 'Сменить у отмеченных'; }
      }
      return;
    }
    const paidId = t.getAttribute ? t.getAttribute('data-doc-paid') : null;
    if (paidId !== null) { if (evType === 'change') b2bDocPaid(app, paidId, !!t.checked, t); return; }
    const form = app.b2bForm;
    if (!form) return;
    if (form.kind === 'doc' || form.kind === 'docset') return b2bDocInput(app, form, t, evType);
    if (t.id === 'bfClient') {
      if (evType !== 'change') return;
      form.cid = t.value; form.f.branch_id = ''; form.msg = null;
      if (form.kind === 'payment') return b2bLoadUnpaid(app, form);
      if (form.kind === 'shipment') return b2bRenderPanel(app);
      return;
    }
    if (t.id === 'bfNewClient') { form.newClient = !!t.checked; return b2bRenderPanel(app); }
    if (t.id === 'bfAllowDup') { form.f.allow_duplicate = !!t.checked; return; }
    if (t.id === 'bfFiles') { form.files = Array.from(t.files || []); const s = rootEl.querySelector('.b2b-files-picked');
      if (s) s.textContent = form.files.map(f => f.name).join(', ') || 'не выбраны'; return; }
    if (BF_NC[t.id]) { form.nc[BF_NC[t.id]] = t.value; return; }
    if (BF[t.id] && form.f && BF[t.id] in form.f) {
      form.f[BF[t.id]] = t.value;
      if (t.id === 'bfPayType' && evType === 'change') return b2bRenderPanel(app);
      if (t.id === 'bfAdvance') return b2bPaySum(app);
      if (t.id === 'bfBundle' || t.id === 'bfShipDay') return b2bBundleInfo(app);
      return;
    }
    if (t.id === 'bfPayType') { form.f.pay_type = t.value; if (evType === 'change') b2bRenderPanel(app); return; }
    const ii = t.getAttribute ? t.getAttribute('data-bf-item') : null;
    if (ii !== null && form.items && form.items[Number(ii)]) {
      const it = form.items[Number(ii)], col = t.getAttribute('data-bf-col');
      it[col] = t.value;
      if (col === 'product' && evType === 'change') {
        if (String(it.price || '').trim() === '') it.price = String(F.priceOf(it.product));
        return b2bRenderPanel(app);
      }
      const row = t.closest ? t.closest('tr') : null, cell = row ? row.querySelector('.b2b-f-sum') : null;
      const q = Number(String(it.qty).replace(',', '.')), pr = Number(String(it.price).replace(',', '.'));
      if (cell) cell.textContent = q > 0 && pr >= 0 ? C.money(Math.round(q * pr)) : '—';
      const tot = rootEl.querySelector('#bfTotal');
      if (tot) tot.textContent = C.money(Math.round(F.shipmentTotal(form.items)));
      return b2bBundleInfo(app);
    }
    const pid = t.getAttribute ? t.getAttribute('data-bf-pay') : null;
    if (pid !== null) {
      form.qty[pid] = t.value;
      const row = t.closest ? t.closest('tr') : null;
      const u = (form.unpaid || []).find(x => s0(x.id) === pid);
      if (row && u) row.classList.toggle('over', Number(t.value) > Number(u.left_qty) + 1e-6);
      return b2bPaySum(app);
    }
  }
  // Форма документа: поле → состояние; строки — пересчёт суммы на месте.
  const BD = { bdDay: 'day', bdComment: 'comment', bdFlatAmount: 'flat_amount', bdFlatName: 'flat_name' };
  function b2bDocInput(app, form, t, evType) {
    const D = root.NietteB2bDocs, rootEl = app.root;
    if (form.kind === 'docset') {
      const k = t.getAttribute ? t.getAttribute('data-bs') : null;
      if (k === null || !(k in form.f)) return;
      form.f[k] = t.type === 'checkbox' ? !!t.checked : t.value;
      return;
    }
    if (t.id === 'bdFlat') { form.f.flat = !!t.checked; return b2bRenderPanel(app); }
    if (BD[t.id]) {
      form.f[BD[t.id]] = t.value;
      if (t.id === 'bdFlatAmount') b2bDocTotal(app, form);
      return;
    }
    const sid = t.getAttribute ? t.getAttribute('data-doc-ship') : null;
    if (sid !== null) {
      if (evType !== 'change') return;
      form.ships = form.ships.filter(x => x !== sid);
      if (t.checked) form.ships.push(sid);
      // Строки руками не правили — пересобрать по отметкам; правили — не трогать
      // (форма предложит «Подставить строки» кнопкой).
      if (!form.dirty) {
        const it = D.fillFromShipments(form.lines, form.ships, form.docKind);
        form.items = it.length ? it : [D.emptyLine()];
      }
      return b2bRenderPanel(app);
    }
    const ii = t.getAttribute ? t.getAttribute('data-bd-item') : null;
    if (ii !== null && form.items[Number(ii)]) {
      const it = form.items[Number(ii)], col = t.getAttribute('data-bd-col');
      it[col] = t.value;
      form.dirty = true;
      const row = t.closest ? t.closest('tr') : null, cell = row ? row.querySelector('.b2b-f-sum') : null;
      if (cell) { const v = D.lineSum(it); cell.textContent = v > 0 || (Number(String(it.qty).replace(',', '.')) > 0 && String(it.price).trim() === '0') ? C.money(Math.round(v)) : '—'; }
      return b2bDocTotal(app, form);
    }
  }
  function b2bDocTotal(app, form) {
    const D = root.NietteB2bDocs, rootEl = app.root, v = D.docTotal(form);
    const tot = rootEl.querySelector('#bdTotal');
    if (tot) tot.textContent = C.money(Math.round(v));
    const btn = rootEl.querySelector('#b2bForm [data-action="b2b-f-save"]');
    if (btn && !form.busy) btn.textContent = (form.docKind === 'invoice' ? 'Выписать счёт' : 'Выписать накладную') + (v > 0 ? ' на ' + C.money(Math.round(v)) : '');
  }
  function b2bPaySum(app) {
    const F = root.NietteB2bForms, form = app.b2bForm, rootEl = app.root;
    if (!form || form.kind !== 'payment') return;
    const t = F.paymentTotals(form);
    const sum = rootEl.querySelector('#bfPaySum');
    if (sum) sum.innerHTML = F.paySumText(t);
    const btn = rootEl.querySelector('#b2bForm [data-action="b2b-f-save"]');
    if (btn && !form.busy) btn.textContent = t.total > 0 ? 'Записать оплату ' + C.money(Math.round(t.total)) : 'Записать оплату';
  }

  // ── Экраны с периодом ─────────────────────────────────────────────────────
  // Кнопки периода, группировка, свои даты, график и его подсказка у
  // «Обзора», «Kaspi», «Ozon» и «Аналитики» общие. Что у открытого экрана
  // своё — здесь, одной таблицей: новый экран с периодом — одна строка.
  // График экрана: series — нарисованные бакеты, html(w, h) — разметка под
  // размер коробки, tip(i) — подсказка столбика.
  function chartSpec(series, html, tip) { return { series, html, tip }; }

  function periodScreen(app) {
    if (app.route === 'overview') return {
      view: () => app.ovView, ready: () => !!(app.ov && app.ovView),
      render: () => renderOverview(app), rerender: keep => rerenderOverview(app, keep),
      charts: () => {
        const v = app.ovView, O = root.NietteOverview, K = root.NietteKaspi;
        if (!v) return {};
        const out = { ovChart: chartSpec(() => v.series, (w, h) => ovChartHtml(app, w, h),
                                         i => O.tooltipHtml(v.series[i], v.chans, app.ovUi.hidden)) };
        Object.keys(OV_PANELS).forEach(k => {
          out[OV_PANELS[k].chart] = chartSpec(() => v.chSeries[k], (w, h) => ovChannelChartHtml(app, k, w, h),
                                              i => O.channelTooltipHtml(v.chSeries[k][i], k));
        });
        if (K && !app.ov.errors.clients) {
          out.ovCliChart = chartSpec(() => v.cliSeries, (w, h) => ovClientChartHtml(app, w, h), i => K.clientTooltipHtml(v.cliSeries[i]));
        }
        return out;
      } };
    if (app.route === 'kaspi') return {
      view: () => app.kpView, ready: () => !!(app.kp && app.kpView),
      render: () => renderKaspi(app), rerender: keep => rerenderKaspi(app, keep),
      charts: () => (app.kpView ? { ovChart: chartSpec(() => app.kpView.series, (w, h) => kpChartHtml(app, w, h),
                                                       i => root.NietteKaspi.tooltipHtml(app.kpView.series[i])) } : {}) };
    if (app.route === 'ozon') return {
      view: () => app.ozView, ready: () => !!(app.oz && app.ozView),
      render: () => renderOzon(app), rerender: keep => rerenderOzon(app, keep),
      charts: () => (app.ozView ? { ovChart: chartSpec(() => app.ozView.series, (w, h) => ozChartHtml(app, w, h),
                                                       i => root.NietteOzon.tooltipHtml(app.ozView.series[i])) } : {}) };
    if (app.route === 'b2b') return {
      view: () => (app.b2b ? { rg: b2bInputsRange(app), series: [] } : null),
      ready: () => !!(app.b2b && !app.b2bUi.card),
      render: () => renderB2b(app), rerender: keep => rerenderB2b(app, keep),
      charts: () => ({}) };
    if (app.route === 'analytics') return {
      view: () => app.anView, ready: () => !!(app.an && app.anView),
      render: () => renderAnalytics(app), rerender: keep => rerenderAnalytics(app, keep),
      charts: () => (app.anView ? { ovChart: chartSpec(() => app.anView.chartSeries, (w, h) => anChartHtml(app, w, h),
                                                       i => root.NietteAnalytics.tooltipHtml(app.anView.chartSeries[i])) } : {}) };
    return null;
  }
  // Графики открытого экрана: id → chartSpec. У экранов без периода — нет.
  function screenCharts(app) { const s = periodScreen(app); return s && s.charts ? s.charts() : {}; }
  function periodView(app) { const s = periodScreen(app); return s ? s.view() : null; }
  function periodReady(app) { const s = periodScreen(app); return !!(s && s.ready()); }
  function renderPeriodScreen(app) { const s = periodScreen(app); return s ? s.render() : undefined; }
  function rerenderPeriodScreen(app, keep) { const s = periodScreen(app); return s ? s.rerender(keep) : undefined; }

  function saveOvPrefs(app) {
    try { root.localStorage.setItem(OV_PREFS, JSON.stringify({ preset: app.ovUi.preset, grouping: app.ovUi.grouping })); }
    catch (e) { /* приватный режим — просто не запоминаем */ }
  }
  function loadOvPrefs() {
    try { return JSON.parse(root.localStorage.getItem(OV_PREFS) || 'null') || {}; }
    catch (e) { return {}; }
  }

  const DEFAULT_GROUPING = { today: 'day', '7d': 'day', '30d': 'day', month: 'day', all: 'month', custom: 'day' };

  // ── Экраны ────────────────────────────────────────────────────────────────
  function routeFromHash() {
    const h = String((root.location && root.location.hash) || '').replace(/^#/, '');
    return ROUTES.some(r => r.key === h) ? h : 'overview';
  }

  // Единственный сторож экранов на странице: закрытый вошедшему экран (из
  // адреса, вкладки, «назад» в браузере) — первый открытый, и адрес туда же.
  function openRoute(app) {
    const open = routesFor(app);
    if (!open.length) return showNoSections(app);
    if (!open.some(r => r.key === app.route)) { app.route = open[0].key; setHash(app.route); }
    if (app.route === 'clients') return app.data ? renderScreen(app) : loadAndRender(app);
    if (app.route === 'kaspi') return app.kp ? renderKaspi(app) : loadKaspiScreen(app);
    if (app.route === 'ozon') return app.oz ? renderOzon(app) : loadOzonScreen(app);
    if (app.route === 'analytics') return app.an ? renderAnalytics(app) : loadAnalyticsScreen(app);
    if (app.route === 'stock') return app.st ? renderStock(app) : loadStockScreen(app);
    if (app.route === 'b2b') return app.b2b ? renderB2b(app) : loadB2bScreen(app);
    return app.ov ? renderOverview(app) : loadOverviewScreen(app);
  }

  // Допуск и разделы — двумя вызовами сразу, ожидание как у одного. Решает
  // is_app_user, как и до разделов; app_me только говорит, какие вкладки
  // показать. Её нет в базе (PGRST202: страница выложена раньше sql/12) или
  // она ответила пусто — все вкладки: права всё равно держит база.
  async function afterLogin(app) {
    const g = app.gen;
    show(app, page('<div class="card loading" role="status">Проверяю доступ…</div>'));
    const call = fn => Promise.resolve().then(() => app.client.rpc(fn)).then(r => r || {}, e => ({ error: e }));
    const [res, me] = await Promise.all([call('is_app_user'), call('app_me')]);
    if (g !== app.gen) return;                 // пока проверяли, вышли или вошёл другой
    if (res.error) return showFatal(app, humanError(res.error, 'Проверка доступа'));
    if (res.data !== true) return showDenied(app);
    const noFn = e => String((e && e.code) || '') === 'PGRST202' ||
                      /could not find the function/i.test(String((e && e.message) || ''));
    if (me.error && !noFn(me.error)) return showFatal(app, humanError(me.error, 'Проверка разделов'));
    const d = !me.error && me.data && typeof me.data === 'object' ? me.data : null;
    if (d && d.allowed === false) return showDenied(app);
    app.me = d && d.allowed === true
      ? { allowed: true, full: d.full === true, sections: Array.isArray(d.sections) ? d.sections : [], can_write: d.can_write === true }
      : FULL_ME;
    return openRoute(app);
  }

  // ── События: одно делегирование на корень ────────────────────────────────
  function wire(app) {
    const rootEl = app.root;

    rootEl.addEventListener('submit', async ev => {
      if (!ev.target || ev.target.id !== 'loginForm') return;
      ev.preventDefault();
      const email = rootEl.querySelector('#loginEmail').value.trim();
      const password = rootEl.querySelector('#loginPassword').value;
      if (!email || !password) return showLogin(app, 'Введите email и пароль.', email);
      const btn = rootEl.querySelector('#loginForm button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Вхожу…'; }
      let res;
      try { res = await app.client.auth.signInWithPassword({ email, password }); }
      catch (e) { res = { error: e }; }
      if (res.error || !res.data || !res.data.session) {
        return showLogin(app, humanError(res.error || 'Вход не удался'), email);
      }
      app.session = res.data.session;
      return afterLogin(app);
    });

    rootEl.addEventListener('click', async ev => {
      const el = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (!el) return;
      const action = el.getAttribute('data-action');
      if (action === 'logout') {
        try { await app.client.auth.signOut(); } catch (e) { /* выходим в любом случае */ }
        return showLogin(app);
      }
      if (action === 'refresh') {
        if (!app.session) return showLogin(app);
        if (app.route === 'clients') app.data = null;
        else if (app.route === 'kaspi') app.kp = null;
        else if (app.route === 'ozon') app.oz = null;
        else if (app.route === 'analytics') app.an = null;
        else if (app.route === 'stock') app.st = null;
        else if (app.route === 'b2b') { app.b2b = null; app.b2bModel = null; }
        else app.ov = null;
        return afterLogin(app);
      }
      if (action === 'qp-max') return setQpMax(app, el.getAttribute('data-id'));
      if (action === 'jump') return jumpTo(app, el.getAttribute('data-id'));
      if (action === 'st-arr-save' && app.route === 'stock' && app.st) return stSaveArrival(app);
      if (action === 'st-wo-save' && app.route === 'stock' && app.st) return stSaveWriteoffs(app);
      if ((action === 'st-del' || action === 'st-del-no' || action === 'st-del-yes') && app.route === 'stock' && app.st) {
        const kind = el.getAttribute('data-kind'), id = el.getAttribute('data-id');
        if (action === 'st-del-yes') return stDelete(app, kind, id);
        app.stForm.confirmDel = action === 'st-del' ? kind + ':' + id : null;
        app.stForm.msg.del = null;
        return renderStock(app);
      }
      if (action === 'st-win') {
        // Окно сверки: оба окна уже в памяти, в базу не ходим.
        if (app.route !== 'stock' || !app.st) return;
        app.stUi.win = Number(el.getAttribute('data-win')) === 90 ? 90 : 30;
        return renderStock(app);
      }
      if (action.indexOf('b2b-') === 0) {
        if (app.route !== 'b2b' || !app.b2b) return;
        const ui = app.b2bUi, m = b2bModel(app);
        if (/^b2b-(f-|del|bulk-save|train-reset|doc-)/.test(action)) return b2bFormAction(app, action, el);
        if (action === 'b2b-card') {
          ui.scroll = root.scrollY || 0;
          ui.card = el.getAttribute('data-id');
          renderB2b(app);
          if (root.scrollTo) root.scrollTo(0, 0);
          return;
        }
        if (action === 'b2b-back') {
          ui.card = null;
          renderB2b(app);
          if (root.scrollTo) root.scrollTo(0, ui.scroll || 0);
          return;
        }
        if (action === 'b2b-ovtype' || action === 'b2b-nows' || action === 'b2b-closed') {
          if (action === 'b2b-ovtype') ui.type = el.getAttribute('data-type') || 'all';
          else if (action === 'b2b-nows') ui.noWholesale = !ui.noWholesale;
          else ui.showClosed = !ui.showClosed;
          return renderB2b(app);
        }
        if (action === 'b2b-ptype' || action === 'b2b-presult' || action === 'b2b-sort') {
          if (action === 'b2b-ptype') ui.p.type = el.getAttribute('data-type') || 'all';
          else if (action === 'b2b-presult') ui.p.result = el.getAttribute('data-result') || 'all';
          else {
            const col = el.getAttribute('data-col');
            if (ui.p.sort === col) ui.p.dir = ui.p.dir === 'asc' ? 'desc' : 'asc';
            else { ui.p.sort = col; ui.p.dir = 'desc'; }
          }
          return swapSection(app, 'b2bPartners', b2bPartnersHtml(app, m));
        }
        if (action === 'b2b-fc-nav' || action === 'b2b-fc-day') {
          if (action === 'b2b-fc-nav') {
            const ym = ui.fc.month || m.today.slice(0, 7);
            let y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7)) + Number(el.getAttribute('data-dir'));
            if (mo > 12) { mo = 1; y++; } else if (mo < 1) { mo = 12; y--; }
            ui.fc.month = y + '-' + String(mo).padStart(2, '0');
            ui.fc.day = '';
          } else {
            const d = el.getAttribute('data-day');
            ui.fc.day = ui.fc.day === d ? '' : d;
          }
          return swapSection(app, 'b2bForecast', b2bForecastHtml(app, m));
        }
        if (action === 'b2b-overdue') {
          ui.overdueOpen = true;
          return swapSection(app, 'b2bOverdue', b2bOverdueHtml(app, m));
        }
        return;
      }
      if (action === 'route') {
        const r = el.getAttribute('data-route');
        if (r === app.route) return;
        app.route = r;
        setHash(r);
        return openRoute(app);
      }
      if (action && action.indexOf('ov-') === 0) {
        if (!periodReady(app)) return;
        const O = root.NietteOverview, ui = app.ovUi;
        if (action === 'ov-preset') {
          ui.preset = el.getAttribute('data-preset');
          ui.grouping = DEFAULT_GROUPING[ui.preset] || 'day';
          saveOvPrefs(app);
          return renderPeriodScreen(app);
        }
        if (action === 'ov-group') {
          ui.grouping = el.getAttribute('data-group');
          // «Месяцы» на одном месяце — один столбик, а не динамика: как в
          // старом «Обзоре», период сам раскрывается до «всего времени».
          if (ui.grouping === 'month' && O.monthsSpanned(periodView(app).rg) < 2) ui.preset = 'all';
          saveOvPrefs(app);
          return renderPeriodScreen(app);
        }
        if (action === 'ov-ch') {
          if (app.route !== 'overview') return;
          const k = el.getAttribute('data-ch');
          ui.hidden[k] = !ui.hidden[k];
          const tb = rootEl.querySelector('#ovTrendBody');
          if (tb) tb.innerHTML = ovTrendInner(app);
          return;
        }
        return;
      }
      if (!app.data) return;
      if (action === 'risk-level') {
        app.ui.riskLevel = el.getAttribute('data-level');
        app.ui.riskAll = false;
        const box = rootEl.querySelector('#risk');
        if (box) box.outerHTML = riskSection(app);
        return;
      }
      if (action === 'ret-mode' || action === 'ret-entry') {
        if (action === 'ret-mode') app.ui.retMode = C.RET_MODES[el.getAttribute('data-mode')] ? el.getAttribute('data-mode') : 'any';
        else app.ui.retEntry = C.RET_ENTRIES[el.getAttribute('data-entry')] ? el.getAttribute('data-entry') : 'all';
        const box = rootEl.querySelector('#retention');
        if (box) box.outerHTML = retentionSection(app);
        return;
      }
      if (action === 'ltv-metric' || action === 'ltv-dim') {
        if (action === 'ltv-metric') app.ui.ltvMetric = C.LTV_METRICS[el.getAttribute('data-metric')] ? el.getAttribute('data-metric') : 'profit';
        else app.ui.ltvDim = C.LTV_DIMS[el.getAttribute('data-dim')] ? el.getAttribute('data-dim') : 'all';
        const box = rootEl.querySelector('#ltv');
        if (box) box.outerHTML = ltvSection(app);
        return;
      }
      if (action === 'sum-grp' || action === 'sum-month') {
        // Главное о клиентах: другая группа или месяц — из памяти; фокус
        // остаётся на нажатой кнопке.
        if (app.route !== 'clients' || !app.data) return;
        let sel;
        if (action === 'sum-grp') {
          app.ui.sumGrp = C.SUM_GROUPS[el.getAttribute('data-grp')] ? el.getAttribute('data-grp') : 'all';
          sel = '[data-action="sum-grp"][data-grp="' + app.ui.sumGrp + '"]';
        } else {
          const key = C.monthKey(el.getAttribute('data-month'));
          if (!key) return;
          app.ui.sumMonth = key;
          sel = '[data-action="sum-month"][data-month="' + key + '"]';
        }
        const box = rootEl.querySelector('#summary');
        if (box) box.outerHTML = summarySection(app);
        const again = rootEl.querySelector(sel);
        if (again && again.focus) again.focus();
        return;
      }
      if (action === 'month-mix') {
        // Разбор другого месяца — из памяти; фокус остаётся на нажатом месяце.
        if (app.route !== 'clients' || !app.data) return;
        const key = C.monthKey(el.getAttribute('data-month'));
        if (!key) return;
        app.ui.mixMonth = key;
        const box = rootEl.querySelector('#monthly');
        if (box) box.outerHTML = monthlySection(app);
        const again = rootEl.querySelector('[data-action="month-mix"][data-month="' + key + '"]');
        if (again && again.focus) again.focus();
        const panel = rootEl.querySelector('#mixBody');
        if (panel && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (action === 'risk-all') {
        app.ui.riskAll = true;
        const body = rootEl.querySelector('#riskBody');
        if (body) body.innerHTML = riskBodyHtml(app);
        return;
      }
      if (action === 'base-more') {
        app.ui.baseLimit += BASE_STEP;
        const body = rootEl.querySelector('#baseBody');
        if (body) body.innerHTML = baseBodyHtml(app);
      }
    });

    // Формы «Склада»: поле → состояние, без перерисовки экрана.
    rootEl.addEventListener('input', ev => stFormInput(app, ev.target));
    rootEl.addEventListener('change', ev => stFormInput(app, ev.target));

    // Формы «B2B»: поле → состояние формы; перерисовывается только то, что от
    // поля зависит (сумма, список позиций), курсор остаётся на месте.
    rootEl.addEventListener('input', ev => b2bFormInput(app, ev.target, 'input'));
    rootEl.addEventListener('change', ev => b2bFormInput(app, ev.target, 'change'));

    // Поиск партнёров «B2B» — та же схема: перерисовывается только таблица.
    rootEl.addEventListener('input', ev => {
      if (!ev.target || ev.target.id !== 'b2bSearch' || app.route !== 'b2b' || !app.b2b) return;
      app.b2bUi.p.query = ev.target.value;
      const body = rootEl.querySelector('#b2bPartnersBody');
      if (body) body.innerHTML = b2bPartnersBody(app, b2bModel(app));
    });

    // Свой CAC в «Главном»: перерисовывается только таблица окупаемости —
    // поле остаётся тем же элементом, курсор не прыгает.
    rootEl.addEventListener('input', ev => {
      if (!app.data || !ev.target || ev.target.id !== 'sumCac') return;
      app.ui.sumCac = ev.target.value;
      const body = rootEl.querySelector('#sumPayback');
      if (body) body.innerHTML = C.renderSummaryPayback(app.data.summary, app.ui.sumCac);
    });

    // Поиск и сортировка перерисовывают только таблицу: поле поиска остаётся
    // тем же элементом, и фокус с курсором не прыгают на каждой букве.
    rootEl.addEventListener('input', ev => {
      if (!app.data || !ev.target || ev.target.id !== 'baseSearch') return;
      app.ui.baseQuery = ev.target.value;
      app.ui.baseLimit = BASE_STEP;
      const body = rootEl.querySelector('#baseBody');
      if (body) body.innerHTML = baseBodyHtml(app);
    });
    // Город на графике «Аналитики»: перерисовывается только сам график —
    // список остаётся тем же элементом, и фокус с клавиатуры не теряется.
    rootEl.addEventListener('change', ev => {
      const t = ev.target;
      if (!t || t.id !== 'anCity' || app.route !== 'analytics' || !periodReady(app)) return;
      app.anUi.city = t.value;
      anCompute(app);
      const box = rootEl.querySelector('#ovChartBox');
      if (box) box.innerHTML = anChartHtml(app, chartW(app, 'ovChart'), chartH(app, 'ovChart'));
      const tip = rootEl.querySelector('#ovTip');
      if (tip) tip.hidden = true;
    });
    // Свои даты периода: поле меняется — остальной экран пересчитывается, а
    // сами поля остаются теми же элементами.
    rootEl.addEventListener('change', ev => {
      const t = ev.target;
      if (!t || (t.id !== 'ovFrom' && t.id !== 'ovTo') || !periodReady(app)) return;
      const from = rootEl.querySelector('#ovFrom'), to = rootEl.querySelector('#ovTo');
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from.value) || !/^\d{4}-\d{2}-\d{2}$/.test(to.value)) return;
      app.ovUi.preset = 'custom';
      app.ovUi.from = from.value;
      app.ovUi.to = to.value;
      rerenderPeriodScreen(app, true);
    });

    // Подсказка графика: наведение, касание и стрелки с клавиатуры. Графиков
    // на экране несколько (квадранты): у каждого своя подсказка и свой
    // выбранный столбик, данные — из screenCharts по id графика.
    const chartOf = el => (el && el.closest ? el.closest('.chart') : null);
    const isChart = el => !!(el && el.classList && el.classList.contains('chart'));
    function tipAt(chart, i) {
      const spec = chart ? screenCharts(app)[chart.id] : null;
      const tip = chart ? chart.querySelector('.tip') : null;
      if (!spec || !tip || !spec.series()[i]) return;
      app.tipIdx[chart.id] = i;
      tip.innerHTML = spec.tip(i);
      tip.hidden = false;
      chart.querySelectorAll('.hit.on').forEach(h => h.classList.remove('on'));
      const hit = chart.querySelector('.hit[data-i="' + i + '"]');
      if (hit) hit.classList.add('on');
      if (hit && hit.getBoundingClientRect && chart.getBoundingClientRect) {
        const hr = hit.getBoundingClientRect(), br = chart.getBoundingClientRect();
        const w = tip.offsetWidth || 180;
        let left = hr.left - br.left + hr.width / 2 - w / 2;
        left = Math.max(4, Math.min(left, br.width - w - 4));
        tip.style.left = left + 'px';
      }
    }
    function tipHide(chart) {
      if (!chart) return;
      const tip = chart.querySelector('.tip');
      if (tip) tip.hidden = true;
      chart.querySelectorAll('.hit.on').forEach(h => h.classList.remove('on'));
    }
    const onHit = ev => {
      const hit = ev.target && ev.target.closest ? ev.target.closest('.chart .hit') : null;
      if (hit) tipAt(chartOf(hit), Number(hit.getAttribute('data-i')));
    };
    rootEl.addEventListener('pointermove', onHit);
    rootEl.addEventListener('pointerdown', onHit);
    rootEl.addEventListener('pointerleave', ev => { if (isChart(ev.target)) tipHide(ev.target); }, true);
    rootEl.addEventListener('focusin', ev => {
      if (!isChart(ev.target)) return;
      const spec = screenCharts(app)[ev.target.id];
      if (!spec) return;
      const n = spec.series().length, i = app.tipIdx[ev.target.id];
      tipAt(ev.target, i !== undefined && i < n ? i : n - 1);
    });
    rootEl.addEventListener('focusout', ev => { if (isChart(ev.target)) tipHide(ev.target); });
    rootEl.addEventListener('keydown', ev => {
      if (!isChart(ev.target)) return;
      const spec = screenCharts(app)[ev.target.id];
      if (!spec) return;
      const n = spec.series().length;
      let i = app.tipIdx[ev.target.id] === undefined ? n - 1 : app.tipIdx[ev.target.id];
      if (ev.key === 'ArrowLeft') i = Math.max(0, i - 1);
      else if (ev.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
      else if (ev.key === 'Home') i = 0;
      else if (ev.key === 'End') i = n - 1;
      else if (ev.key === 'Escape') { tipHide(ev.target); return; }
      else return;
      ev.preventDefault();
      tipAt(ev.target, i);
    });

    rootEl.addEventListener('change', ev => {
      if (!app.data || !ev.target || ev.target.id !== 'baseSort') return;
      app.ui.baseSort = ev.target.value;
      app.ui.baseLimit = BASE_STEP;
      const body = rootEl.querySelector('#baseBody');
      if (body) body.innerHTML = baseBodyHtml(app);
    });
  }

  // ── Запуск ────────────────────────────────────────────────────────────────
  async function start(opts) {
    opts = opts || {};
    const rootEl = opts.root;
    const cfg = opts.config || root.NIETTE_CONFIG || {};
    const makeClient = opts.createClient || (root.supabase && root.supabase.createClient);
    const prefs = loadOvPrefs();
    const preset = ['today', '7d', '30d', 'month', 'all'].indexOf(prefs.preset) >= 0 ? prefs.preset : 'month';
    const app = {
      opts, root: rootEl, client: null, session: null, me: null, gen: 0, data: null, errors: {},
      riskByKey: {}, synced: null, loadedAt: null,
      route: 'overview', ov: null, ovView: null, chartDims: {}, tipIdx: {}, qpMax: {}, kp: null, kpView: null, oz: null, ozView: null,
      an: null, anView: null, anUi: { city: '' }, st: null, stUi: { win: 30 }, stForm: null,
      b2b: null, b2bModel: null, b2bForm: null, b2bAct: { confirm: null }, b2bBulk: newBulk(), b2bSigned: {}, b2bNotice: null,
      b2bUi: { type: 'all', noWholesale: false, showClosed: false, card: null, scroll: 0, overdueOpen: false,
               fc: { month: '', day: '' }, p: { type: 'all', result: 'all', query: '', sort: null, dir: 'desc' } },
      now: opts.now || (() => new Date()),
      ovUi: { preset, grouping: ['day', 'week', 'decade', 'month'].indexOf(prefs.grouping) >= 0 ? prefs.grouping : DEFAULT_GROUPING[preset],
              from: '', to: '', hidden: {} },
      ui: { riskLevel: 'высокий', riskAll: false, baseQuery: '', baseSort: 'revenue', baseLimit: BASE_STEP,
            retMode: 'any', retEntry: 'all', mixMonth: null, ltvMetric: 'profit', ltvDim: 'all',
            sumGrp: 'all', sumMonth: null, sumCac: '' }
    };
    app.route = routeFromHash();   // разделы ещё не известны; закрытый экран поправит openRoute

    if (!makeClient) {
      show(app, messageHtml('Не загрузилась библиотека Supabase',
        '<p>Файл <code>vendor/supabase-2.117.1.js</code> не подключился. Проверьте, что он выложен рядом со страницей.</p>'));
      return app;
    }
    if (!cfg.supabaseUrl || !cfg.supabaseKey) {
      show(app, messageHtml('Нужны адрес и ключ проекта',
        '<p>Впишите их в <code>config.js</code>: Supabase → Project Settings → API Keys. ' +
        'Нужен publishable или legacy anon ключ.</p>'));
      return app;
    }
    if (keyProblem(cfg.supabaseKey) === 'secret') {
      show(app, messageHtml('В config.js секретный ключ',
        '<p>Это ключ <b>service_role / secret</b>: он обходит все права, и через страницу база ' +
        'открылась бы любому. Страница с ним не запускается.</p>' +
        '<p>Замените его на publishable или legacy anon. Если страница с этим ключом уже была ' +
        'выложена — перевыпустите секретный ключ в Supabase.</p>'));
      return app;
    }

    app.client = makeClient(cfg.supabaseUrl, cfg.supabaseKey,
                            { auth: { persistSession: true, autoRefreshToken: true } });
    wire(app);
    if (root.addEventListener) {
      // Назад/вперёд в браузере переключают экран так же, как вкладки.
      root.addEventListener('hashchange', () => {
        const r = routeFromHash();
        if (r !== app.route && app.session && app.me) { app.route = r; openRoute(app); }
      });
      let t = null;
      root.addEventListener('resize', () => {
        if (t) clearTimeout(t);
        t = setTimeout(() => { if (app.session) afterShow(app); }, 150);
      });
    }
    if (app.client.auth.onAuthStateChange) {
      app.client.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT' && app.session) return showLogin(app);
        if (!session || !app.session) return;
        // В другой вкладке вошли ДРУГИМ человеком — сессия общая на весь сайт.
        // Его права другие: память — вон, допуск и разделы — заново.
        const was = app.session.user && app.session.user.email, now = session.user && session.user.email;
        app.session = session;
        if (was !== now) { resetScreens(app); afterLogin(app); }
      });
    }

    let res;
    try { res = await app.client.auth.getSession(); }
    catch (e) { res = { error: e }; }
    const session = res && res.data ? res.data.session : null;
    if (res.error || !session) { showLogin(app); return app; }
    app.session = session;
    await afterLogin(app);
    return app;
  }

  root.NietteApp = { start, keyProblem, humanError, fetchAll, loadAll, loadOverview, loadKaspi, loadOzon, loadAnalytics,
                     loadStock, loadB2b, SOURCES, B2B_SRC, PAGE };
})(typeof window !== 'undefined' ? window : globalThis);
