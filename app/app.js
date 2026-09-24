/* NIETTE на Postgres: вход и экран «Клиенты». Первый экран нового фронта.
 *
 * Состояния по порядку: нет библиотеки / нет настроек / секретный ключ →
 * вход → проверка допуска (app_users) → загрузка → экран.
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
      let q = client.from(src.table).select(src.select || '*');
      if (src.order) q = q.order(src.order, { ascending: true });
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

  async function fetchSmall(client, src) {
    let q = client.from(src.table).select(src.select || '*');
    if (src.order) q = q.order(src.order, { ascending: true });
    const res = await q;
    if (res.error) throw res.error;
    return res.data || [];
  }

  // Свежесть — справочно: её сбой не должен гасить экран, поэтому не бросает.
  // snapAt — время САМОГО СТАРОГО снимка: цифры на экране не свежее него.
  async function fetchFreshness(client) {
    const out = { synced: null, snapAt: null, snapNever: false };
    try {
      const res = await client.from('sync_log').select('synced_at')
                              .order('synced_at', { ascending: false }).limit(1);
      if (!res.error && res.data && res.data.length) out.synced = res.data[0].synced_at;
    } catch (e) { /* справочно */ }
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

  // Застывший снимок по виду неотличим от «новых заказов не было». Поэтому
  // возраст снимка говорится словами, а не только временем в строке свежести.
  function staleNote(app) {
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
      '<section class="card login"><h1>NIETTE</h1><p class="muted">Аналитика клиентов</p>' +
      '<form id="loginForm" novalidate>' +
        '<label for="loginEmail">Email</label>' +
        '<input id="loginEmail" name="email" type="email" autocomplete="username" required value="' + C.esc(email || '') + '">' +
        '<label for="loginPassword">Пароль</label>' +
        '<input id="loginPassword" name="password" type="password" autocomplete="current-password" required>' +
        '<button type="submit" class="primary">Войти</button>' +
        '<div id="loginError" class="error"' + (errorText ? ' role="alert">' + C.esc(errorText) : ' hidden>') + '</div>' +
      '</form></section>');
  }

  function headerHtml(app) {
    const email = app.session && app.session.user ? app.session.user.email : '';
    return '<header class="top"><div class="top-inner">' +
      '<div class="brand">NIETTE <span class="muted">· Клиенты</span></div>' +
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
    renderScreen(app);
  }

  async function afterLogin(app) {
    show(app, page('<div class="card loading" role="status">Проверяю доступ…</div>'));
    let res;
    try { res = await app.client.rpc('is_app_user'); }
    catch (e) { res = { error: e }; }
    if (res.error) return showFatal(app, humanError(res.error, 'Проверка доступа'));
    if (res.data !== true) return showDenied(app);
    return loadAndRender(app);
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
        return afterLogin(app);
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
    const app = {
      opts, root: rootEl, client: null, session: null, data: null, errors: {},
      riskByKey: {}, synced: null, loadedAt: null,
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

  root.NietteApp = { start, keyProblem, humanError, fetchAll, loadAll, SOURCES, PAGE };
})(typeof window !== 'undefined' ? window : globalThis);
