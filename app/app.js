/* NIETTE на Postgres: вход и четыре экрана — «Обзор», «Kaspi», «Ozon» и «Клиенты».
 *
 * Состояния по порядку: нет библиотеки / нет настроек / секретный ключ →
 * вход → проверка допуска (app_users) → загрузка → экран.
 *
 * ЭКРАНЫ — по адресу: …/app/ и …/app/#overview — «Обзор», …/app/#kaspi —
 * «Kaspi», …/app/#ozon — «Ozon», …/app/#clients — «Клиенты». Данные экрана
 * грузятся при первом заходе на него и дальше живут в памяти: переключение
 * между вкладками в базу не ходит. «Обновить» перечитывает открытый экран.
 * Период у «Обзора», «Kaspi» и «Ozon» общий: выбрал июль на одном —
 * остальные откроются на июле.
 *
 * ДОСТУП. Вход — Supabase Auth (email и пароль). «Вошёл» ещё ничего не
 * значит: читать можно, только если email есть в app_users (sql/12_auth.sql).
 * Недопущенному RLS отдаёт пустые витрины без ошибки, поэтому допуск
 * проверяется ЯВНО, rpc('is_app_user'): иначе он увидел бы пустой экран и
 * решил, что клиентов нет.
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
    { key: 'monthly', table: 'snap_new_vs_returning', order: 'month',  what: 'Новые и вернувшиеся' },
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
      const q = ordered(client.from(src.table).select(src.select || '*'), src.order);
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

  function ordered(q, order) {
    [].concat(order || []).forEach(col => { q = q.order(col, { ascending: true }); });
    return q;
  }

  async function fetchSmall(client, src) {
    const res = await ordered(client.from(src.table).select(src.select || '*'), src.order);
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

  const ROUTES = [{ key: 'overview', label: 'Обзор' }, { key: 'kaspi', label: 'Kaspi' }, { key: 'ozon', label: 'Ozon' },
                  { key: 'clients', label: 'Клиенты' }];

  function headerHtml(app) {
    const email = app.session && app.session.user ? app.session.user.email : '';
    const tabs = ROUTES.map(r => '<button type="button" class="tab' + (app.route === r.key ? ' on' : '') +
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
      '<div class="two">' +
        section('repeat', 'Время до второго заказа', '', or(e, 'repeat', () => C.renderRepeat(d.repeat))) +
        section('entry', 'Вход через мини-пак', 'С чего начал клиент',
                or(e, 'entry', () => C.renderEntry(d.entry))) +
      '</div>' +
      section('risk', 'Риск оттока', 'Давно не заказывал по меркам этого клиента · самые ценные сверху',
              or(e, 'risk', () => riskToolbar(app) + '<div id="riskBody">' + riskBodyHtml(app) + '</div>')) +
      section('monthly', 'Новые и вернувшиеся по месяцам', '',
              or(e, 'monthly', () => C.renderMonthly(d.monthly))) +
      section('base', 'База клиентов', 'Клиент = имя + фамилия + город · только выданные заказы Kaspi',
              or(e, 'base', () => baseToolbar(app) + '<div id="baseBody">' + baseBodyHtml(app) + '</div>')) +
      section('notes', 'Как читать эти числа', '', C.renderNotes()));
  }

  // ── Показ ─────────────────────────────────────────────────────────────────
  function show(app, html) { app.root.innerHTML = html; }

  function showLogin(app, errorText, email) {
    app.session = null;
    app.data = null;
    show(app, loginHtml(errorText, email));
    const f = app.root.querySelector(email ? '#loginPassword' : '#loginEmail');
    if (f && f.focus) f.focus();
  }

  function showDenied(app) {
    const email = app.session && app.session.user ? app.session.user.email : '';
    show(app, messageHtml('Нет доступа',
      '<p>Вы вошли как <b>' + C.esc(email) + '</b>, но этого email нет в списке допущенных.</p>' +
      '<p class="muted">Добавить можно в Supabase → SQL Editor:</p>' +
      '<pre><code>insert into app_users (email, note) values (\'' + C.esc(email) + '\', \'кто это\');</code></pre>',
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
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю клиентов…</div>'));
    const res = await loadAll(app.client);
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
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю выручку…</div>'));
    app.ov = await loadOverview(app.client);
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
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю Kaspi…</div>'));
    app.kp = await loadKaspi(app.client);
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
    show(app, headerHtml(app) + page('<div class="card loading" role="status">Загружаю Ozon…</div>'));
    app.oz = await loadOzon(app.client);
    if (app.route === 'ozon') renderOzon(app);
  }

  // ── Экраны с периодом ─────────────────────────────────────────────────────
  // Кнопки периода, группировка, свои даты, график и его подсказка у
  // «Обзора», «Kaspi» и «Ozon» общие. Что у открытого экрана своё — здесь,
  // одной таблицей: новый экран с периодом — одна строка.
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
    return h === 'clients' || h === 'kaspi' || h === 'ozon' ? h : 'overview';
  }

  function openRoute(app) {
    if (app.route === 'clients') return app.data ? renderScreen(app) : loadAndRender(app);
    if (app.route === 'kaspi') return app.kp ? renderKaspi(app) : loadKaspiScreen(app);
    if (app.route === 'ozon') return app.oz ? renderOzon(app) : loadOzonScreen(app);
    return app.ov ? renderOverview(app) : loadOverviewScreen(app);
  }

  async function afterLogin(app) {
    show(app, page('<div class="card loading" role="status">Проверяю доступ…</div>'));
    let res;
    try { res = await app.client.rpc('is_app_user'); }
    catch (e) { res = { error: e }; }
    if (res.error) return showFatal(app, humanError(res.error, 'Проверка доступа'));
    if (res.data !== true) return showDenied(app);
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
        else app.ov = null;
        return afterLogin(app);
      }
      if (action === 'route') {
        const r = el.getAttribute('data-route');
        if (r === app.route) return;
        app.route = r;
        try { if (root.history && root.history.replaceState) root.history.replaceState(null, '', '#' + r); } catch (e) { /* неважно */ }
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

    // Поиск и сортировка перерисовывают только таблицу: поле поиска остаётся
    // тем же элементом, и фокус с курсором не прыгают на каждой букве.
    rootEl.addEventListener('input', ev => {
      if (!app.data || !ev.target || ev.target.id !== 'baseSearch') return;
      app.ui.baseQuery = ev.target.value;
      app.ui.baseLimit = BASE_STEP;
      const body = rootEl.querySelector('#baseBody');
      if (body) body.innerHTML = baseBodyHtml(app);
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
      opts, root: rootEl, client: null, session: null, data: null, errors: {},
      riskByKey: {}, synced: null, loadedAt: null,
      route: routeFromHash(), ov: null, ovView: null, ovChartWidth: 0, kp: null, kpView: null, oz: null, ozView: null,
      now: opts.now || (() => new Date()),
      ovUi: { preset, grouping: ['day', 'week', 'decade', 'month'].indexOf(prefs.grouping) >= 0 ? prefs.grouping : DEFAULT_GROUPING[preset],
              from: '', to: '', hidden: {} },
      ui: { riskLevel: 'высокий', riskAll: false, baseQuery: '', baseSort: 'revenue', baseLimit: BASE_STEP }
    };

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
        if (r !== app.route && app.session) { app.route = r; openRoute(app); }
      });
      let t = null;
      root.addEventListener('resize', () => {
        if (t) clearTimeout(t);
        t = setTimeout(() => { if (periodScreen(app)) fitChart(app); }, 150);
      });
    }
    if (app.client.auth.onAuthStateChange) {
      app.client.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT' && app.session) showLogin(app);
        else if (session && app.session) app.session = session;
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

  root.NietteApp = { start, keyProblem, humanError, fetchAll, loadAll, loadOverview, loadKaspi, loadOzon, SOURCES, PAGE };
})(typeof window !== 'undefined' ? window : globalThis);
