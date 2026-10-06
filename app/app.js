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

  const C = root.NietteClients;
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
    { key: 'base',    table: 'snap_client_base',      paged: true, order: 'client_key', what: 'База клиентов' },
    { key: 'risk',    table: 'snap_client_risk',      paged: true, order: 'client_key', what: 'Риск оттока',
      select: 'client_key,name,city,orders,revenue,last_at,days_since_last,expected_gap,overdue_x,risk' },
    { key: 'repeat',  table: 'snap_client_repeat',    order: 'sort',   what: 'Время до второго заказа' },
    { key: 'ltv',     table: 'snap_client_ltv',       order: 'cohort', what: 'Когорты' },
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
  // alive — без мягко удалённых строк (deleted_at, появятся с записью).
  const B2B_SRC = [
    { key: 'clients',   table: 'b2b_clients',    paged: true, order: ['sheet_row', 'id'], what: 'Партнёры' },
    { key: 'shipments', table: 'b2b_shipments',  paged: true, order: ['sheet_row', 'id'], what: 'Поставки', alive: true },
    { key: 'payments',  table: 'b2b_payments',   paged: true, order: ['sheet_row', 'id'], what: 'Оплаты', alive: true },
    { key: 'visits',    table: 'b2b_visits',     paged: true, order: ['sheet_row', 'id'], what: 'Визиты', alive: true,
      select: 'id,day,client_id,result,next_day,rep,comment,files' },
    { key: 'items',     table: 'b2b_ship_items', paged: true, order: ['sheet_row', 'id'], what: 'Позиции поставок', alive: true },
    { key: 'payItems',  table: 'b2b_pay_items',  paged: true, order: ['sheet_row', 'id'], what: 'Позиции оплат', alive: true },
    { key: 'branches',  table: 'b2b_branches',   paged: true, order: ['sheet_row', 'id'], what: 'Филиалы', alive: true },
    { key: 'docs',      table: 'b2b_docs',       paged: true, order: ['sheet_row', 'id'], what: 'Документы', alive: true },
    { key: 'rounds',    table: 'b2b_rounds',     paged: true, order: ['sheet_row', 'id'], what: 'Обходы', alive: true }
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

  async function loadOverview(client) {
    const snapP = fetchSnapState(client);
    const [daily, gaps, fresh] = await Promise.allSettled([
      fetchAll(client, OV_DAILY), fetchSmall(client, OV_GAPS), fetchSmall(client, OV_FRESH)]);
    const snap = await snapP;
    return {
      rows: daily.status === 'fulfilled' ? daily.value : [],
      gaps: gaps.status === 'fulfilled' ? gaps.value : [],
      fresh: fresh.status === 'fulfilled' && fresh.value.length ? fresh.value[0] : {},
      errors: {
        daily: daily.status === 'rejected' ? humanError(daily.reason, OV_DAILY.what) : null,
        gaps: gaps.status === 'rejected' ? humanError(gaps.reason, OV_GAPS.what) : null
      },
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

  async function loadB2b(client) {
    const res = await Promise.allSettled(B2B_SRC.map(s => (s.paged ? fetchAll : fetchSmall)(client, s))
                                                .concat([fetchSmall(client, B2B_STATUS)]));
    const data = {}, errors = {};
    B2B_SRC.forEach((s, i) => {
      const r = res[i];
      if (r.status === 'fulfilled') data[s.key] = r.value;
      else { data[s.key] = []; errors[s.key] = humanError(r.reason, s.what); }
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

  function page(inner) { return '<div class="page">' + inner + '</div>'; }

  function messageHtml(title, body, actions) {
    return page('<section class="card message" role="alert"><h1>' + C.esc(title) + '</h1>' + body +
                (actions || '') + '</section>');
  }

  function loginHtml(errorText, email) {
    return page(
      '<section class="card login"><h1>NIETTE</h1><p class="muted">Выручка и клиенты</p>' +
      '<form id="loginForm" novalidate>' +
        '<label for="loginEmail">Email</label>' +
        '<input id="loginEmail" name="email" type="email" autocomplete="username" required value="' + C.esc(email || '') + '">' +
        '<label for="loginPassword">Пароль</label>' +
        '<input id="loginPassword" name="password" type="password" autocomplete="current-password" required>' +
        '<button type="submit" class="primary">Войти</button>' +
        '<div id="loginError" class="error"' + (errorText ? ' role="alert">' + C.esc(errorText) : ' hidden>') + '</div>' +
      '</form></section>');
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

  function headerHtml(app) {
    const email = app.session && app.session.user ? app.session.user.email : '';
    const tabs = routesFor(app).map(r => '<button type="button" class="tab' + (app.route === r.key ? ' on' : '') +
      '" data-action="route" data-route="' + r.key + '"' + (app.route === r.key ? ' aria-current="page"' : '') + '>' +
      C.esc(r.label) + '</button>').join('');
    return '<header class="top"><div class="top-inner">' +
      '<div class="brand">NIETTE</div>' +
      '<nav class="tabs" aria-label="Экраны">' + tabs + '</nav>' +
      '<div class="top-actions">' +
        (email ? '<span class="who-am-i" title="Вы вошли как">' + C.esc(email) + '</span>' : '') +
        '<button type="button" data-action="refresh">Обновить</button>' +
        '<button type="button" data-action="logout" class="ghost">Выйти</button>' +
      '</div></div></header>';
  }

  function section(id, title, sub, inner) {
    return '<section class="card" id="' + id + '" aria-labelledby="' + id + 'Title">' +
      '<div class="card-head"><h2 id="' + id + 'Title">' + C.esc(title) + '</h2>' +
      (sub ? '<div class="card-sub">' + sub + '</div>' : '') + '</div>' + inner + '</section>';
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
    return section('retention', 'Удержание по месяцам', 'Новые клиенты месяца — сколько из них купили в следующие месяцы',
      or(e, 'retention', () =>
        '<div class="toolbar" role="group" aria-label="Как считать месяцы">' +
          seg('ret-mode', 'data-mode', 'any', m === 'any', C.RET_MODES.any) +
          seg('ret-mode', 'data-mode', 'streak', m === 'streak', C.RET_MODES.streak) + '</div>' +
        entryBar + render()));
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
    const panel = mixOk
      ? '<div class="mix" id="mixBody">' + C.renderMonthMix(d.monthMix, sel, { monthly: row }) + '</div>'
      : (e.monthMix ? '<p class="note">Разбор месяца недоступен. ' + C.esc(e.monthMix) + '</p>' : '');
    return section('monthly', 'Новые и вернувшиеся по месяцам', mixOk ? 'Нажмите на месяц — кто в нём покупал' : '',
      or(e, 'monthly', () => C.renderMonthly(d.monthly, { months, selected: sel })) + panel);
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
    const parts = [];
    if (app.snapAt) parts.push('Данные на ' + hhmm(app.snapAt));
    if (app.synced) parts.push('зеркало Apps Script обновлено ' + hhmm(app.synced));
    parts.push('загружено ' + hhmm(app.loadedAt));
    const fresh = parts.join(' · ');
    const stale = staleNote(app);
    return headerHtml(app) + page(
      '<div class="fresh muted">' + C.esc(fresh.charAt(0).toUpperCase() + fresh.slice(1)) + '</div>' +
      (stale ? '<div class="stale" role="status">' + C.esc(stale) + '</div>' : '') +
      (e.base ? C.sectionError(e.base) : C.renderKpis(k)) +
      section('cohorts', 'Когорты: LTV и окупаемость', 'Когорта — месяц первого заказа · CAC только Meta',
              or(e, 'ltv', () => C.renderCohorts(d.ltv))) +
      retentionSection(app) +
      '<div class="two">' +
        section('repeat', 'Время до второго заказа', '', or(e, 'repeat', () => C.renderRepeat(d.repeat))) +
        section('entry', 'Вход через мини-пак', 'С чего начал клиент',
                or(e, 'entry', () => C.renderEntry(d.entry))) +
      '</div>' +
      section('risk', 'Риск оттока', 'Давно не заказывал по меркам этого клиента · самые ценные сверху',
              or(e, 'risk', () => riskToolbar(app) + '<div id="riskBody">' + riskBodyHtml(app) + '</div>')) +
      monthlySection(app) +
      section('base', 'База клиентов', 'Клиент = имя + фамилия + город · только выданные заказы Kaspi',
              or(e, 'base', () => baseToolbar(app) + '<div id="baseBody">' + baseBodyHtml(app) + '</div>')) +
      section('notes', 'Как читать эти числа', '', C.renderNotes()));
  }

  // ── Показ ─────────────────────────────────────────────────────────────────
  function show(app, html) { app.root.innerHTML = html; }

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
  }

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
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю клиентов…</div>'));
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

  function ovFreshHtml(app) {
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
    const txt = bits.join(' · ');
    const stale = staleNote(app.ov);
    return '<div class="fresh muted">' + C.esc(txt.charAt(0).toUpperCase() + txt.slice(1)) + '</div>' +
      (stale ? '<div class="stale" role="status">' + C.esc(stale) + '</div>' : '');
  }

  // Всё, что зависит от периода, считается здесь одним проходом и кладётся
  // в app.ovView — подсказке графика нужны ровно те бакеты, что нарисованы.
  function ovCompute(app) {
    const O = root.NietteOverview, ui = app.ovUi, rows = app.ov.rows;
    const today = O.todayIso(app.now());
    const rg = ovRange(app);
    const prg = O.prevRange(ui.preset === 'custom' ? 'custom' : ui.preset, rg);
    const chans = O.channelsOf(rows);
    const series = O.buildSeries(rows, rg, ui.grouping, today);
    const present = {};
    chans.forEach(c => { present[c.key] = series.some(e => (e.by[c.key] || 0) !== 0); });
    app.ovView = { rg, prg, chans, series, present, t: O.totals(rows, rg), pt: prg ? O.totals(rows, prg) : null };
    return app.ovView;
  }

  function ovChartHtml(app, width) {
    const v = app.ovView;
    return root.NietteOverview.renderChart(v.series, v.chans, app.ovUi.hidden, width, app.ovUi.grouping);
  }

  function ovTrendInner(app) {
    const O = root.NietteOverview, v = app.ovView;
    return O.renderGroupings(app.ovUi.grouping) + O.renderLegend(v.chans, app.ovUi.hidden, v.present) +
      '<div id="ovChartBox">' + ovChartHtml(app, app.ovChartWidth) + '</div>';
  }

  function overviewHtml(app) {
    const O = root.NietteOverview, ov = app.ov;
    if (ov.errors.daily) {
      return headerHtml(app) + page(ovFreshHtml(app) + C.sectionError(ov.errors.daily));
    }
    const v = ovCompute(app);
    const gSub = GROUP_SUB[app.ovUi.grouping];
    return headerHtml(app) + page(
      ovFreshHtml(app) +
      O.renderFilters(app.ovUi, v.rg) +
      '<div class="two hero-row">' + O.renderHero(v.t, v.pt, v.rg, v.prg) +
        section('ovShares', 'Доли каналов', 'по выручке за период', O.renderShares(v.t, v.chans)) + '</div>' +
      (ov.errors.gaps ? C.sectionError(ov.errors.gaps) : O.renderGaps(ov.gaps)) +
      section('ovTrend', 'Динамика выручки', C.esc(gSub) + ' · незакрытый период бледнее', '<div id="ovTrendBody">' + ovTrendInner(app) + '</div>') +
      section('ovTable', 'По периодам', 'новые сверху · итог сходится с общей выручкой', O.renderTable(v.series, v.chans)) +
      section('ovNotes', 'Как читать эти числа', '', O.renderNotes()));
  }

  // Ширина графика — настоящая ширина карточки. SVG с чужой шириной
  // масштабируется целиком, вместе с текстом: на телефоне подписи стали бы
  // мельче шести пикселей.
  function fitChart(app) {
    const box = app.root.querySelector('#ovChartBox');
    const scr = periodScreen(app);
    if (!box || !scr || !scr.view()) return;
    const w = Math.round(box.clientWidth || 0);
    if (!w || Math.abs(w - (app.ovChartWidth || 0)) < 8) return;
    app.ovChartWidth = w;
    box.innerHTML = scr.chart(w);
  }

  function syncPresetButtons(app) {
    app.root.querySelectorAll('[data-action="ov-preset"]').forEach(b => {
      const on = b.getAttribute('data-preset') === app.ovUi.preset;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
  }

  function renderOverview(app) {
    show(app, overviewHtml(app));
    fitChart(app);
  }

  // Период или каналы поменялись — перерисовать всё, что от них зависит, но
  // не фильтры: поле даты, в котором сейчас курсор, не должно пересоздаваться.
  function rerenderOverview(app, keepFilters) {
    if (!keepFilters) return renderOverview(app);
    const O = root.NietteOverview, v = ovCompute(app);
    const swap = (sel, html) => { const el = app.root.querySelector(sel); if (el) el.outerHTML = html; };
    swap('.hero-row', '<div class="two hero-row">' + O.renderHero(v.t, v.pt, v.rg, v.prg) +
      section('ovShares', 'Доли каналов', 'по выручке за период', O.renderShares(v.t, v.chans)) + '</div>');
    const tb = app.root.querySelector('#ovTrendBody'); if (tb) tb.innerHTML = ovTrendInner(app);
    swap('#ovTable', section('ovTable', 'По периодам', 'новые сверху · итог сходится с общей выручкой', O.renderTable(v.series, v.chans)));
    syncPresetButtons(app);
    fitChart(app);
  }

  async function loadOverviewScreen(app) {
    const g = app.gen;
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю выручку…</div>'));
    const ov = await loadOverview(app.client);
    if (g !== app.gen) return;
    app.ov = ov;
    if (app.route === 'overview') renderOverview(app);
  }

  // ── «Kaspi» ───────────────────────────────────────────────────────────────
  // Разметка и расчёты — в kaspi.js; здесь только сборка экрана из частей и
  // перерисовка частей при смене периода.
  const KASPI_CH = [{ key: 'kaspi', label: 'Kaspi' }];

  function kpFreshHtml(app) {
    const f = app.kp.fresh || {};
    const bits = [];
    if (app.kp.snapAt) bits.push('Данные на ' + when(app.kp.snapAt));
    if (f.kaspi_polled_at) bits.push('опрос Kaspi ' + when(f.kaspi_polled_at));
    if (f.mirror_synced_at) bits.push('удалённые оплаты — с таблицей ' + when(f.mirror_synced_at));
    bits.push('загружено ' + when(app.kp.loadedAt));
    const txt = bits.join(' · ');
    const stale = staleNote(app.kp);
    return '<div class="fresh muted">' + C.esc(txt.charAt(0).toUpperCase() + txt.slice(1)) + '</div>' +
      (stale ? '<div class="stale" role="status">' + C.esc(stale) + '</div>' : '');
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

  function kpChartHtml(app, width) {
    return root.NietteOverview.renderChart(app.kpView.series, KASPI_CH, {}, width, app.ovUi.grouping);
  }
  function kpTrendInner(app) {
    return root.NietteOverview.renderGroupings(app.ovUi.grouping) +
      '<div id="ovChartBox">' + kpChartHtml(app, app.ovChartWidth) + '</div>';
  }
  function kpTopHtml(app) {
    const O = root.NietteOverview, v = app.kpView;
    return '<div class="two hero-row">' +
      O.renderHero({ total: v.k.revenue }, v.pk ? { total: v.pk.revenue } : null, v.rg, v.prg, 'Выручка Kaspi',
                   root.NietteKaspi.renderRevenueParts(v.k)) +
      section('kpProfit', 'Прибыль до расходов', 'по заказам с известной себестоимостью',
              root.NietteKaspi.renderProfit(v.k, v.pk, v.prg)) + '</div>';
  }
  function kpKpisHtml(app) {
    const kp = app.kp, v = app.kpView;
    return '<div id="kpKpis">' + (kp.errors.clients ? C.sectionError(kp.errors.clients) : '') +
      root.NietteKaspi.renderKpis(v.k, v.pk, kp.errors.now ? null : kp.now) + '</div>';
  }
  function kpTableHtml(app) {
    return section('ovTable', 'По периодам', 'новые сверху · итог сходится с выручкой',
                   root.NietteKaspi.renderTable(app.kpView.series));
  }
  function kpRemoteHtml(app) {
    const kp = app.kp;
    return section('kpRemote', 'Удалённые оплаты', 'оплаты без заказа в Kaspi · в выручке по дню оплаты, без комиссии',
      kp.errors.remote ? C.sectionError(kp.errors.remote) : root.NietteKaspi.renderRemote(kp.remote, app.kpView.rg));
  }

  function kaspiHtml(app) {
    const kp = app.kp;
    if (kp.errors.daily) {
      app.kpView = null;
      return headerHtml(app) + page(kpFreshHtml(app) + C.sectionError(kp.errors.daily));
    }
    kpCompute(app);
    return headerHtml(app) + page(
      kpFreshHtml(app) +
      root.NietteOverview.renderFilters(app.ovUi, app.kpView.rg) +
      kpTopHtml(app) + kpKpisHtml(app) +
      section('ovTrend', 'Динамика продаж', C.esc(GROUP_SUB[app.ovUi.grouping]) + ' · по дню выдачи · незакрытый период бледнее',
              '<div id="ovTrendBody">' + kpTrendInner(app) + '</div>') +
      kpTableHtml(app) + kpRemoteHtml(app) +
      section('kpNotes', 'Как читать эти числа', '', root.NietteKaspi.renderNotes()));
  }

  function renderKaspi(app) {
    show(app, kaspiHtml(app));
    fitChart(app);
  }

  // Смена своих дат: перерисовать всё, что зависит от периода, кроме полей
  // дат — в одном из них сейчас курсор.
  function rerenderKaspi(app, keepFilters) {
    if (!keepFilters || app.kp.errors.daily) return renderKaspi(app);
    kpCompute(app);
    const swap = (sel, html) => { const el = app.root.querySelector(sel); if (el) el.outerHTML = html; };
    swap('.hero-row', kpTopHtml(app));
    swap('#kpKpis', kpKpisHtml(app));
    const tb = app.root.querySelector('#ovTrendBody'); if (tb) tb.innerHTML = kpTrendInner(app);
    swap('#ovTable', kpTableHtml(app));
    swap('#kpRemote', kpRemoteHtml(app));
    syncPresetButtons(app);
    fitChart(app);
  }

  async function loadKaspiScreen(app) {
    app.kpView = null;
    const g = app.gen;
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю Kaspi…</div>'));
    const kp = await loadKaspi(app.client);
    if (g !== app.gen) return;
    app.kp = kp;
    if (app.route === 'kaspi') renderKaspi(app);
  }

  // ── «Ozon» ────────────────────────────────────────────────────────────────
  const OZON_CH = [{ key: 'ozon', label: 'Ozon' }];

  function ozFreshHtml(app) {
    const n = app.oz.now || {};
    const bits = [];
    if (app.oz.snapAt) bits.push('Данные на ' + when(app.oz.snapAt));
    if (n.accruals_polled_at) bits.push('начисления Ozon ' + when(n.accruals_polled_at));
    if (n.journal_polled_at) bits.push('отправления ' + when(n.journal_polled_at));
    bits.push('загружено ' + when(app.oz.loadedAt));
    const txt = bits.join(' · ');
    const stale = staleNote(app.oz);
    return '<div class="fresh muted">' + C.esc(txt.charAt(0).toUpperCase() + txt.slice(1)) + '</div>' +
      (stale ? '<div class="stale" role="status">' + C.esc(stale) + '</div>' : '');
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

  function ozChartHtml(app, width) {
    return root.NietteOverview.renderChart(app.ozView.series, OZON_CH, {}, width, app.ovUi.grouping);
  }
  function ozTrendInner(app) {
    return root.NietteOverview.renderGroupings(app.ovUi.grouping) +
      '<div id="ovChartBox">' + ozChartHtml(app, app.ovChartWidth) + '</div>';
  }
  function ozTopHtml(app) {
    const O = root.NietteOverview, Z = root.NietteOzon, v = app.ozView;
    return '<div class="two hero-row">' +
      O.renderHero({ total: v.k.revenue }, v.pk ? { total: v.pk.revenue } : null, v.rg, v.prg, 'Выручка Ozon',
                   Z.renderRevenueParts(v.k)) +
      section('ozMoney', 'Деньги Ozon', 'из начислений: что продано, что удержано, что пришло',
              Z.renderMoney(v.k, v.pk, v.prg)) + '</div>';
  }
  function ozKpisHtml(app) {
    const oz = app.oz, v = app.ozView;
    return '<div id="ozKpis">' + root.NietteOzon.renderKpis(v.k, v.pk, oz.errors.now ? null : oz.now) + '</div>';
  }
  function ozTableHtml(app) {
    return section('ovTable', 'По периодам', 'новые сверху · итог сходится с выручкой',
                   root.NietteOzon.renderTable(app.ozView.series));
  }
  function ozSkuHtml(app) {
    const oz = app.oz, Z = root.NietteOzon;
    return section('ozSkus', 'Товары', 'за период · по выручке',
      oz.errors.skus ? C.sectionError(oz.errors.skus) : Z.renderSkus(Z.skuTotals(oz.skus, app.ozView.rg)));
  }
  function ozErrorsHtml(app) {
    const oz = app.oz;
    return section('ozErrors', 'Ошибки продавца', 'штрафы Ozon за период · новые сверху',
      oz.errors.list ? C.sectionError(oz.errors.list) : root.NietteOzon.renderErrors(oz.errorsList, app.ozView.rg));
  }

  function ozonHtml(app) {
    const oz = app.oz;
    if (oz.errors.daily) {
      app.ozView = null;
      return headerHtml(app) + page(ozFreshHtml(app) + C.sectionError(oz.errors.daily));
    }
    ozCompute(app);
    return headerHtml(app) + page(
      ozFreshHtml(app) +
      root.NietteOverview.renderFilters(app.ovUi, app.ozView.rg) +
      ozTopHtml(app) + ozKpisHtml(app) +
      section('ovTrend', 'Динамика выручки', C.esc(GROUP_SUB[app.ovUi.grouping]) + ' · по дню начисления · незакрытый период бледнее',
              '<div id="ovTrendBody">' + ozTrendInner(app) + '</div>') +
      ozTableHtml(app) + ozErrorsHtml(app) + ozSkuHtml(app) +
      section('ozNotes', 'Как читать эти числа', '', root.NietteOzon.renderNotes()));
  }

  function renderOzon(app) {
    show(app, ozonHtml(app));
    fitChart(app);
  }

  function rerenderOzon(app, keepFilters) {
    if (!keepFilters || app.oz.errors.daily) return renderOzon(app);
    ozCompute(app);
    const swap = (sel, html) => { const el = app.root.querySelector(sel); if (el) el.outerHTML = html; };
    swap('.hero-row', ozTopHtml(app));
    swap('#ozKpis', ozKpisHtml(app));
    const tb = app.root.querySelector('#ovTrendBody'); if (tb) tb.innerHTML = ozTrendInner(app);
    swap('#ovTable', ozTableHtml(app));
    swap('#ozErrors', ozErrorsHtml(app));
    swap('#ozSkus', ozSkuHtml(app));
    syncPresetButtons(app);
    fitChart(app);
  }

  async function loadOzonScreen(app) {
    app.ozView = null;
    const g = app.gen;
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю Ozon…</div>'));
    const oz = await loadOzon(app.client);
    if (g !== app.gen) return;
    app.oz = oz;
    if (app.route === 'ozon') renderOzon(app);
  }

  // ── «Аналитика» ───────────────────────────────────────────────────────────
  // Спрос по дню заказа. График — та же стопка, что у «Обзора», только в
  // столбике не каналы, а исходы заказов.
  function anFreshHtml(app) {
    const f = app.an.fresh || {};
    const bits = [];
    if (app.an.snapAt) bits.push('Данные на ' + when(app.an.snapAt));
    if (f.kaspi_polled_at) bits.push('опрос Kaspi ' + when(f.kaspi_polled_at));
    bits.push('загружено ' + when(app.an.loadedAt));
    const txt = bits.join(' · ');
    const stale = staleNote(app.an);
    return '<div class="fresh muted">' + C.esc(txt.charAt(0).toUpperCase() + txt.slice(1)) + '</div>' +
      (stale ? '<div class="stale" role="status">' + C.esc(stale) + '</div>' : '');
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

  function anChartHtml(app, width) {
    const v = app.anView;
    return root.NietteOverview.renderChart(v.chartSeries, root.NietteAnalytics.OUTCOMES, {}, width,
                                           app.ovUi.grouping, v.city ? 'Заказы в городе ' + v.city : 'Заказы');
  }
  function anTrendInner(app) {
    const v = app.anView;
    return '<div class="an-controls">' + root.NietteOverview.renderGroupings(app.ovUi.grouping) +
      (v.cityOptions ? root.NietteAnalytics.renderCityPicker(v.cityOptions, v.city) : '') + '</div>' +
      root.NietteAnalytics.renderLegend() +
      '<div id="ovChartBox">' + anChartHtml(app, app.ovChartWidth) + '</div>';
  }
  function anKpisHtml(app) {
    return '<div id="anKpis">' + root.NietteAnalytics.renderKpis(app.anView.k, app.anView.pk) + '</div>';
  }
  function anTableHtml(app) {
    return section('ovTable', 'По периодам', 'по дню заказа · новые сверху · итог сходится с карточками',
                   root.NietteAnalytics.renderTable(app.anView.series));
  }
  function anWeekDeliveryHtml(app) {
    const A = root.NietteAnalytics, an = app.an, rg = app.anView.rg;
    return '<div class="two" id="anPair">' +
      section('anWeek', 'Дни недели', 'в среднем за день · когда заказывают',
              A.renderWeekdays(A.weekdays(an.rows, rg), rg)) +
      section('anDelivery', 'Способы доставки', 'по дню заказа',
              an.errors.delivery ? C.sectionError(an.errors.delivery) : A.renderDelivery(A.deliveryTotals(an.delivery, rg))) +
    '</div>';
  }
  function anSkuHtml(app) {
    const A = root.NietteAnalytics, an = app.an;
    return section('anSkus', 'Товары', 'по дню заказа · что заказали и что выкупили',
      an.errors.skus ? C.sectionError(an.errors.skus) : A.renderSkus(A.skuTotals(an.skus, app.anView.rg)));
  }
  function anCityHtml(app) {
    const A = root.NietteAnalytics, an = app.an;
    return section('anCities', 'Города', 'по дню заказа · город доставки',
      an.errors.cities ? C.sectionError(an.errors.cities) : A.renderCities(A.cityTotals(an.cities, app.anView.rg), 15));
  }

  function analyticsHtml(app) {
    const an = app.an;
    if (an.errors.daily) {
      app.anView = null;
      return headerHtml(app) + page(anFreshHtml(app) + C.sectionError(an.errors.daily));
    }
    anCompute(app);
    return headerHtml(app) + page(
      anFreshHtml(app) +
      root.NietteOverview.renderFilters(app.ovUi, app.anView.rg) +
      anKpisHtml(app) +
      section('ovTrend', 'Что стало с заказами', C.esc(GROUP_SUB[app.ovUi.grouping]) + ' · по дню заказа · незакрытый период бледнее',
              '<div id="ovTrendBody">' + anTrendInner(app) + '</div>') +
      anTableHtml(app) + anWeekDeliveryHtml(app) + anSkuHtml(app) + anCityHtml(app) +
      section('anNotes', 'Как читать эти числа', '', root.NietteAnalytics.renderNotes()));
  }

  function renderAnalytics(app) {
    show(app, analyticsHtml(app));
    fitChart(app);
  }

  function rerenderAnalytics(app, keepFilters) {
    if (!keepFilters || app.an.errors.daily) return renderAnalytics(app);
    anCompute(app);
    const swap = (sel, html) => { const el = app.root.querySelector(sel); if (el) el.outerHTML = html; };
    swap('#anKpis', anKpisHtml(app));
    const tb = app.root.querySelector('#ovTrendBody'); if (tb) tb.innerHTML = anTrendInner(app);
    swap('#ovTable', anTableHtml(app));
    swap('#anPair', anWeekDeliveryHtml(app));
    swap('#anSkus', anSkuHtml(app));
    swap('#anCities', anCityHtml(app));
    syncPresetButtons(app);
    fitChart(app);
  }

  async function loadAnalyticsScreen(app) {
    app.anView = null;
    const g = app.gen;
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю аналитику…</div>'));
    const an = await loadAnalytics(app.client);
    if (g !== app.gen) return;
    app.an = an;
    if (app.route === 'analytics') renderAnalytics(app);
  }

  // ── «Склад» ───────────────────────────────────────────────────────────────
  // Разметка и расчёты — в stock.js. Периода нет: остаток на сейчас.
  // Продажи из таблицы старше этого — остаток уже не учитывает свежие продажи.
  // Тот же порог, что у тревоги mirror_stale в гейте опросника (sql/10).
  const MIRROR_STALE_H = 6;

  function stFreshHtml(app) {
    const f = app.st.fresh || {};
    const bits = [];
    if (app.st.snapAt) bits.push('Данные на ' + when(app.st.snapAt));
    if (f.stock_synced_at) bits.push('лист «Склад» ' + when(f.stock_synced_at));
    if (f.sales_synced_at) bits.push('продажи ' + when(f.sales_synced_at));
    bits.push('загружено ' + when(app.st.loadedAt));
    const txt = bits.join(' · ');
    const notes = [staleNote(app.st)];
    const sales = f.sales_synced_at ? new Date(f.sales_synced_at) : null;
    if (sales && !isNaN(sales) && app.st.loadedAt - sales > MIRROR_STALE_H * 3600000) {
      notes.push('Продажи из таблицы не приезжали ' + Math.round((app.st.loadedAt - sales) / 3600000) +
                 ' ч — остаток не учитывает свежие продажи. Проверьте импорт в Apps Script.');
    }
    return '<div class="fresh muted">' + C.esc(txt.charAt(0).toUpperCase() + txt.slice(1)) + '</div>' +
      notes.filter(Boolean).map(n => '<div class="stale" role="status">' + C.esc(n) + '</div>').join('');
  }

  function stockHtml(app) {
    const S = root.NietteStock, st = app.st;
    if (st.errors.stock) return headerHtml(app) + page(stFreshHtml(app) + C.sectionError(st.errors.stock));
    const now = app.now(), win = app.stUi.win;
    const rep = st.errors.recon ? null : S.reconFor(st.recon, win);
    const form = app.stForm || (app.stForm = S.newForm(now));
    const del = { canWrite: st.canWrite, confirmDel: form.confirmDel };
    const delMsg = kind => (form.msg.del && form.msg.del.kind === kind
      ? '<div class="st-msg ' + (form.msg.del.tone === 'bad' ? 'st-bad-text' : 'st-good-text') + '" role="status">' +
        C.esc(form.msg.del.text) + '</div>' : '');
    return headerHtml(app) + page(
      stFreshHtml(app) +
      S.pendingNote(st.pending, now) +
      S.renderKpis(S.kpis(st.rows, st.woffs, now)) +
      S.renderProblems(S.problems(st.rows, rep)) +
      // Где лежит товар — сразу под сводкой, как в старом табе.
      section('stMp', 'Остатки по площадкам', C.esc(S.mpSub()),
              st.errors.mp ? C.sectionError(st.errors.mp) : S.renderMp(S.mpReport(st.rows, st.mp), rep, win, now)) +
      section('stCards', 'Остатки', 'по группам · срочные сверху', S.renderCards(st.rows, now)) +
      section('stTable', 'Как сложился остаток', 'с даты пересчёта · те же колонки, что на листе «Склад»',
              S.renderTable(st.rows)) +
      section('stForms', 'Приход и списание', 'записанное видно в журналах сразу, в остатке — через минуту–две',
              S.renderForms(st.rows, form, { canWrite: st.canWrite, woffs: st.woffs, now })) +
      section('stWoff', 'Списания за 30 дней', 'брак, образцы, подарки — мимо продаж',
              st.errors.woff ? C.sectionError(st.errors.woff) : delMsg('writeoff') + S.renderWriteoffs(st.woffs, now, del)) +
      section('stArr', 'Приходы за 90 дней', 'из формы и из листа «Приходы»',
              st.errors.arr ? C.sectionError(st.errors.arr) : delMsg('arrival') + S.renderArrivals(st.arrs, now, del)) +
      // Сверка и склады Kaspi — одно окно на двоих, как в старом табе.
      section('stRecon', 'Сверка: что не доехало до остатка', C.esc(S.reconSub(rep, win)),
              S.winToolbar(win) + (st.errors.recon ? C.sectionError(st.errors.recon) : S.renderRecon(rep, win, st.rows))) +
      section('stPoints', 'Склады отгрузки Kaspi', C.esc(S.pointsSub(rep, win)),
              st.errors.recon ? C.sectionError(st.errors.recon) : S.renderPoints(rep)) +
      section('stNotes', 'Как читать эти числа', '', S.renderNotes()));
  }

  function renderStock(app) { show(app, stockHtml(app)); }

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
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю склад…</div>'));
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

  function b2bFreshHtml(app) {
    const st = app.b2b.status || {}, bits = [], notes = [];
    // Журнал загрузок (sync_log) торгпреду не виден — не его раздел, и
    // mirror_synced_at у него пуст. Тогда время зеркала — то, что взял
    // последний перенос (src_synced_at): застыли листы — застынет и оно.
    const mirrorAt = st.mirror_synced_at || st.src_synced_at || null;
    if (st.imported_at) bits.push('Перенос из таблицы ' + when(st.imported_at));
    if (mirrorAt) bits.push('зеркало ' + when(mirrorAt));
    bits.push('загружено ' + when(app.b2b.loadedAt));
    const txt = bits.join(' · ');
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
    return '<div class="fresh muted">' + C.esc(txt.charAt(0).toUpperCase() + txt.slice(1)) + '</div>' +
      notes.map(n => '<div class="stale" role="status">' + C.esc(n) + '</div>').join('') +
      (st.mode === 'live' ? '' : '<p class="note b2b-ro">Только чтение: поставки, оплаты и визиты пока вносятся в старом табе B2B ' +
        'и в мобильном торгпреда — сюда они приходят с зеркалом таблицы, днём обычно через 15–30 минут.</p>');
  }

  function b2bOvInner(app, m, per, k) {
    const B = root.NietteB2b, ui = app.b2bUi;
    const urg = B.renderUrgent(B.urgent(m, ui), m.today);
    return B.renderKpis(k, per, ui) +
      (urg ? section('b2bUrgent', 'Горит сегодня', 'требует внимания прямо сейчас', urg) : '') +
      section('b2bOverdue', 'Разбор просрочки', 'поставки партнёров, у которых затих счёт',
              B.renderOverdue(B.overdueShipments(m).filter(r => B.ovInScope(m, ui, r.cid)), ui.overdueOpen)) +
      b2bForecastHtml(app, m);
  }
  function b2bForecastHtml(app, m) {
    const B = root.NietteB2b;
    return section('b2bForecast', 'Прогноз поступлений', 'по срокам оплаты из поставок',
                   B.renderForecast(B.forecast(m, app.b2bUi), app.b2bUi.fc, m.today));
  }
  function b2bPartnersHtml(app, m) {
    const B = root.NietteB2b;
    return section('b2bPartners', 'Партнёры', 'контрагенты, деньги и последний контакт · клик по названию — карточка партнёра',
                   B.renderPartnerToolbar(app.b2bUi.p) + '<div id="b2bPartnersBody">' + b2bPartnersBody(app, m) + '</div>');
  }
  function b2bPartnersBody(app, m) {
    const B = root.NietteB2b;
    return B.renderPartners(B.partnerRows(m, app.b2bUi.p, app.b2bUi.showClosed), app.b2bUi.p, m.today);
  }

  function b2bHtml(app) {
    const B = root.NietteB2b, b = app.b2b;
    const core = B2B_CORE.map(k => b.errors[k]).filter(Boolean);
    if (core.length) return headerHtml(app) + page(b2bFreshHtml(app) + C.sectionError(core[0]));
    const m = b2bModel(app);
    if (app.b2bUi.card) {
      const cm = B.cardModel(m, app.b2bUi.card);
      const partial = Object.keys(b.errors).map(k => b.errors[k]);
      if (cm) {
        return headerHtml(app) + page(b2bFreshHtml(app) + partial.map(e => C.sectionError(e)).join('') + B.renderCard(cm, m.today));
      }
      app.b2bUi.card = null;                     // партнёра больше нет (обновили) — к списку
    }
    const per = b2bPer(app), k = B.kpis(m, app.b2bUi, per);
    return headerHtml(app) + page(
      b2bFreshHtml(app) +
      root.NietteOverview.renderFilters(app.ovUi, b2bInputsRange(app)) +
      B.renderFilters(app.b2bUi, k) +
      '<div id="b2bOv">' + b2bOvInner(app, m, per, k) + '</div>' +
      b2bPartnersHtml(app, m) +
      section('b2bNotes', 'Как читать эти числа', '', B.renderNotes()));
  }

  function renderB2b(app) { show(app, b2bHtml(app)); }

  // Период поменялся — пересчитать всё, что от него зависит, не трогая поля дат.
  function rerenderB2b(app, keep) {
    if (!keep || app.b2bUi.card) return renderB2b(app);
    const m = b2bModel(app), per = b2bPer(app), k = root.NietteB2b.kpis(m, app.b2bUi, per);
    const box = app.root.querySelector('#b2bOv');
    if (box) box.innerHTML = b2bOvInner(app, m, per, k);
    syncPresetButtons(app);
  }
  function swapSection(app, id, html) {
    const el = app.root.querySelector('#' + id);
    if (el) el.outerHTML = html;
  }

  async function loadB2bScreen(app) {
    const g = app.gen;
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю B2B…</div>'));
    const b2b = await loadB2b(app.client);
    if (g !== app.gen) return;
    app.b2b = b2b;
    app.b2bModel = null;
    if (app.route === 'b2b') renderB2b(app);
  }

  // ── Экраны с периодом ─────────────────────────────────────────────────────
  // Кнопки периода, группировка, свои даты, график и его подсказка у
  // «Обзора», «Kaspi», «Ozon» и «Аналитики» общие. Что у открытого экрана
  // своё — здесь, одной таблицей: новый экран с периодом — одна строка.
  function periodScreen(app) {
    if (app.route === 'overview') return {
      view: () => app.ovView, ready: () => !!(app.ov && app.ovView),
      render: () => renderOverview(app), rerender: keep => rerenderOverview(app, keep),
      chart: w => ovChartHtml(app, w),
      tip: i => root.NietteOverview.tooltipHtml(app.ovView.series[i], app.ovView.chans, app.ovUi.hidden) };
    if (app.route === 'kaspi') return {
      view: () => app.kpView, ready: () => !!(app.kp && app.kpView),
      render: () => renderKaspi(app), rerender: keep => rerenderKaspi(app, keep),
      chart: w => kpChartHtml(app, w),
      tip: i => root.NietteKaspi.tooltipHtml(app.kpView.series[i]) };
    if (app.route === 'ozon') return {
      view: () => app.ozView, ready: () => !!(app.oz && app.ozView),
      render: () => renderOzon(app), rerender: keep => rerenderOzon(app, keep),
      chart: w => ozChartHtml(app, w),
      tip: i => root.NietteOzon.tooltipHtml(app.ozView.series[i]) };
    if (app.route === 'b2b') return {
      view: () => (app.b2b ? { rg: b2bInputsRange(app), series: [] } : null),
      ready: () => !!(app.b2b && !app.b2bUi.card),
      render: () => renderB2b(app), rerender: keep => rerenderB2b(app, keep),
      chart: () => '', tip: () => '' };
    if (app.route === 'analytics') return {
      view: () => app.anView, ready: () => !!(app.an && app.anView),
      render: () => renderAnalytics(app), rerender: keep => rerenderAnalytics(app, keep),
      chart: w => anChartHtml(app, w),
      tip: i => root.NietteAnalytics.tooltipHtml(app.anView.chartSeries[i]) };
    return null;
  }
  function periodView(app) { const s = periodScreen(app); return s ? s.view() : null; }
  function periodReady(app) { const s = periodScreen(app); return !!(s && s.ready()); }
  function renderPeriodScreen(app) { const s = periodScreen(app); return s ? s.render() : undefined; }
  function rerenderPeriodScreen(app, keep) { const s = periodScreen(app); return s ? s.rerender(keep) : undefined; }
  function tipHtmlAt(app, i) { return periodScreen(app).tip(i); }

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
          const B = root.NietteB2b;
          return swapSection(app, 'b2bOverdue', section('b2bOverdue', 'Разбор просрочки', 'поставки партнёров, у которых затих счёт',
            B.renderOverdue(B.overdueShipments(m).filter(r => B.ovInScope(m, ui, r.cid)), true)));
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
        if (box) box.outerHTML = section('risk', 'Риск оттока',
          'Давно не заказывал по меркам этого клиента · самые ценные сверху',
          riskToolbar(app) + '<div id="riskBody">' + riskBodyHtml(app) + '</div>');
        return;
      }
      if (action === 'ret-mode' || action === 'ret-entry') {
        if (action === 'ret-mode') app.ui.retMode = C.RET_MODES[el.getAttribute('data-mode')] ? el.getAttribute('data-mode') : 'any';
        else app.ui.retEntry = C.RET_ENTRIES[el.getAttribute('data-entry')] ? el.getAttribute('data-entry') : 'all';
        const box = rootEl.querySelector('#retention');
        if (box) box.outerHTML = retentionSection(app);
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

    // Поиск партнёров «B2B» — та же схема: перерисовывается только таблица.
    rootEl.addEventListener('input', ev => {
      if (!ev.target || ev.target.id !== 'b2bSearch' || app.route !== 'b2b' || !app.b2b) return;
      app.b2bUi.p.query = ev.target.value;
      const body = rootEl.querySelector('#b2bPartnersBody');
      if (body) body.innerHTML = b2bPartnersBody(app, b2bModel(app));
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
      if (box) box.innerHTML = anChartHtml(app, app.ovChartWidth);
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

    // Подсказка графика: наведение, касание и стрелки с клавиатуры.
    function tipAt(i) {
      const box = rootEl.querySelector('#ovChart');
      const tip = rootEl.querySelector('#ovTip');
      const v = periodView(app);
      if (!box || !tip || !v || !v.series[i]) return;
      app.ovTipIndex = i;
      tip.innerHTML = tipHtmlAt(app, i);
      tip.hidden = false;
      rootEl.querySelectorAll('#ovChart .hit.on').forEach(h => h.classList.remove('on'));
      const hit = rootEl.querySelector('#ovChart .hit[data-i="' + i + '"]');
      if (hit) hit.classList.add('on');
      if (hit && hit.getBoundingClientRect && box.getBoundingClientRect) {
        const hr = hit.getBoundingClientRect(), br = box.getBoundingClientRect();
        const w = tip.offsetWidth || 180;
        let left = hr.left - br.left + hr.width / 2 - w / 2;
        left = Math.max(4, Math.min(left, br.width - w - 4));
        tip.style.left = left + 'px';
      }
    }
    function tipHide() {
      const tip = rootEl.querySelector('#ovTip');
      if (tip) tip.hidden = true;
      rootEl.querySelectorAll('#ovChart .hit.on').forEach(h => h.classList.remove('on'));
    }
    rootEl.addEventListener('pointermove', ev => {
      const hit = ev.target && ev.target.closest ? ev.target.closest('#ovChart .hit') : null;
      if (hit) tipAt(Number(hit.getAttribute('data-i')));
    });
    rootEl.addEventListener('pointerdown', ev => {
      const hit = ev.target && ev.target.closest ? ev.target.closest('#ovChart .hit') : null;
      if (hit) tipAt(Number(hit.getAttribute('data-i')));
    });
    rootEl.addEventListener('pointerleave', ev => {
      if (ev.target && ev.target.id === 'ovChart') tipHide();
    }, true);
    rootEl.addEventListener('focusin', ev => {
      const v = periodView(app);
      if (ev.target && ev.target.id === 'ovChart' && v) {
        tipAt(app.ovTipIndex !== undefined && v.series[app.ovTipIndex] ? app.ovTipIndex : v.series.length - 1);
      }
    });
    rootEl.addEventListener('focusout', ev => { if (ev.target && ev.target.id === 'ovChart') tipHide(); });
    rootEl.addEventListener('keydown', ev => {
      const v = periodView(app);
      if (!ev.target || ev.target.id !== 'ovChart' || !v) return;
      const n = v.series.length;
      let i = app.ovTipIndex === undefined ? n - 1 : app.ovTipIndex;
      if (ev.key === 'ArrowLeft') i = Math.max(0, i - 1);
      else if (ev.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
      else if (ev.key === 'Home') i = 0;
      else if (ev.key === 'End') i = n - 1;
      else if (ev.key === 'Escape') { tipHide(); return; }
      else return;
      ev.preventDefault();
      tipAt(i);
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
      route: 'overview', ov: null, ovView: null, ovChartWidth: 0, kp: null, kpView: null, oz: null, ozView: null,
      an: null, anView: null, anUi: { city: '' }, st: null, stUi: { win: 30 }, stForm: null,
      b2b: null, b2bModel: null,
      b2bUi: { type: 'all', noWholesale: false, showClosed: false, card: null, scroll: 0, overdueOpen: false,
               fc: { month: '', day: '' }, p: { type: 'all', result: 'all', query: '', sort: null, dir: 'desc' } },
      now: opts.now || (() => new Date()),
      ovUi: { preset, grouping: ['day', 'week', 'decade', 'month'].indexOf(prefs.grouping) >= 0 ? prefs.grouping : DEFAULT_GROUPING[preset],
              from: '', to: '', hidden: {} },
      ui: { riskLevel: 'высокий', riskAll: false, baseQuery: '', baseSort: 'revenue', baseLimit: BASE_STEP,
            retMode: 'any', retEntry: 'all', mixMonth: null }
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
        t = setTimeout(() => { if (periodScreen(app)) fitChart(app); }, 150);
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
