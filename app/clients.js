/* Экран «Клиенты» на витринах Postgres: расчёты и разметка.
 *
 * Здесь только чистые функции: данные на вход, строка HTML на выход. Ни сети,
 * ни глобального состояния — поэтому их можно проверить в Node
 * (tests/app_clients_test.js), а не только глазами в браузере.
 *
 * Источники (sql/13_clients.sql, sql/03_views_analytics.sql). Страница читает
 * их снимки snap_* той же формы (sql/15_snapshots.sql), не сами витрины:
 *   v_client_base       строка на клиента
 *   v_client_risk       риск оттока по меркам самого клиента
 *   v_client_repeat     сколько ждать второго заказа, по корзинам
 *   v_client_ltv        LTV и окупаемость по когортам
 *   v_new_vs_returning  новые и повторные по месяцам
 *   v_client_entry      вход через мини-пак против обычного
 *   v_client_retention  удержание когорт по месяцам (sql/27)
 *   v_client_retention_entry  то же по первой покупке: мини-пак / обычная пачка
 *   v_client_month_mix  кто покупал в месяце: новые, быстрый повтор, вернулись из … (sql/29)
 *   v_client_ltv_curve  LTV типичного нового клиента по месяцам жизни: все / пачка или
 *                       мини-пак / размер первой покупки (sql/29)
 *
 * Всё строковое, что пришло из базы (имена, города), экранируется через esc():
 * имя клиента — это ввод человека, а не наш текст.
 */
(function (root) {
  'use strict';

  const NBSP = '\u00a0';   // U+00A0 escape-последовательностью: сам символ невидим и теряется при записи файла
  const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль',
                  'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Форматирование. Пусто и нечисло — прочерк, никогда не «0» ─────────────
  // Правило проекта: неизвестное показывается пробелом, а не выдуманным нулём.
  function isNum(v) {
    return v !== null && v !== undefined && v !== '' && isFinite(Number(v));
  }
  function num(v) { return isNum(v) ? Number(v) : 0; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function int(v) { return isNum(v) ? nf0.format(Math.round(Number(v))) : '—'; }
  function money(v) { return isNum(v) ? nf0.format(Math.round(Number(v))) + NBSP + '₸' : '—'; }
  function pct(v) { return isNum(v) ? nf1.format(Number(v)) + NBSP + '%' : '—'; }
  function times(v) { return isNum(v) ? nf2.format(Number(v)) + '×' : '—'; }
  function days(v) { return isNum(v) ? nf0.format(Math.round(Number(v))) + NBSP + 'дн.' : '—'; }
  function date(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || '');
    return m ? m[3] + '.' + m[2] + '.' + m[1] : (v ? esc(v) : '—');
  }
  function monthName(v) {
    const m = /^(\d{4})-(\d{2})/.exec(v || '');
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : esc(v);
  }
  // 'YYYY-MM' из '2026-10', '2026-10-01' и т. п.; всё прочее — null.
  function monthKey(v) {
    const m = /^(\d{4})-(\d{2})/.exec(v === null || v === undefined ? '' : String(v));
    return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? m[1] + '-' + m[2] : null;
  }

  function empty(text) { return '<p class="empty">' + esc(text) + '</p>'; }
  function sectionError(text) {
    return '<div class="error" role="alert">' + esc(text) + '</div>';
  }

  // ── Сводка ────────────────────────────────────────────────────────────────
  // Считается из строк базы, а не отдельной витриной: 1,7 тыс. строк уже
  // загружены для таблицы, второй поход в базу за теми же числами не нужен.
  function computeKpis(base, repeat, risk) {
    const clients = base.length;
    const repeaters = base.filter(r => num(r.orders) >= 2).length;
    const revenue = base.reduce((a, r) => a + num(r.revenue), 0);
    const counted = base.filter(r => isNum(r.profit));
    const profit = counted.reduce((a, r) => a + Number(r.profit), 0);
    return {
      clients,
      repeaters,
      repeatPct: clients ? 100 * repeaters / clients : null,
      medianDays: repeat.length ? repeat[0].median_days : null,
      avgRevenue: clients ? revenue / clients : null,
      avgProfit: counted.length ? profit / counted.length : null,
      countedPct: clients ? 100 * counted.length / clients : null,
      high: risk.filter(r => r.risk === 'высокий').length,
      mid: risk.filter(r => r.risk === 'средний').length
    };
  }

  function card(label, value, sub, tone) {
    return '<div class="kpi' + (tone ? ' kpi-' + tone : '') + '">' +
             '<div class="kpi-label">' + esc(label) + '</div>' +
             '<div class="kpi-value">' + value + '</div>' +
             (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') +
           '</div>';
  }

  function renderKpis(k) {
    // Прибыль на клиента — по посчитанным. Если посчитаны не все, это
    // сказано прямо в карточке: иначе среднее по части выглядело бы как
    // среднее по всем (та же пара clients / clients_counted, что в SQL).
    const profitSub = 'прибыль ' + money(k.avgProfit) +
      (isNum(k.countedPct) && k.countedPct < 99.95 ? ' · по ' + pct(k.countedPct) + ' клиентов' : '');
    return '<div class="kpi-grid">' +
      card('Клиентов', int(k.clients), 'опознанных, Kaspi') +
      card('С повторным заказом', pct(k.repeatPct), int(k.repeaters) + ' человек') +
      card('До второго заказа', days(k.medianDays), 'медиана') +
      card('Выручка на клиента', money(k.avgRevenue), profitSub) +
      card('Риск оттока', int(k.high), 'высокий · ещё ' + int(k.mid) + ' средний', k.high ? 'warn' : '') +
    '</div>';
  }

  // ── Когорты: LTV и окупаемость ────────────────────────────────────────────
  function paybackCell(v) {
    if (!isNum(v)) return '<td class="num muted">—</td>';
    return '<td class="num ' + (Number(v) >= 1 ? 'good' : 'bad') + '">' + times(v) + '</td>';
  }

  function renderCohorts(rows) {
    if (!rows.length) return empty('Когорт пока нет.');
    const head = ['Когорта', 'Возраст', 'Клиентов', 'Посчитано', 'Заказов на клиента',
                  'Выручка на клиента', 'Прибыль на клиента', 'CAC (Meta)',
                  'Прибыль за 30 дней', 'Окупаемость за 30 дней', 'Окупаемость на сегодня'];
    const body = rows.map(r =>
      '<tr>' +
        '<th scope="row">' + monthName(r.cohort) + '</th>' +
        '<td class="num">' + days(r.cohort_age_days) + '</td>' +
        '<td class="num">' + int(r.clients) + '</td>' +
        '<td class="num' + (num(r.counted_pct) < 99.95 ? ' warn' : '') + '">' + pct(r.counted_pct) + '</td>' +
        '<td class="num">' + (isNum(r.avg_orders) ? nf2.format(Number(r.avg_orders)) : '—') + '</td>' +
        '<td class="num">' + money(r.ltv_revenue) + '</td>' +
        '<td class="num">' + money(r.ltv_profit) + '</td>' +
        '<td class="num">' + money(r.cac_meta_only) + '</td>' +
        '<td class="num">' + money(r.d30) + '</td>' +
        paybackCell(r.payback_d30) +
        paybackCell(r.payback_todate) +
      '</tr>').join('');
    return '<div class="table-scroll"><table class="grid sticky-first">' +
      '<thead><tr>' + head.map(h => '<th scope="col">' + esc(h) + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>' +
      '<p class="note">Сравнивать когорты между собой можно только по окупаемости за 30 дней: ' +
      'у всех одинаковый возраст. «На сегодня» растёт вместе с возрастом когорты, и падение ' +
      'сверху вниз — это возраст, а не ухудшение. «Посчитано» ниже 100% — прибыль по части ' +
      'клиентов: у остальных есть заказ без себестоимости или комиссии.</p>';
  }

  // ── Время до второго заказа ───────────────────────────────────────────────
  function renderRepeat(rows) {
    if (!rows.length) return empty('Повторных заказов пока нет.');
    const max = Math.max(1, ...rows.map(r => num(r.clients)));
    const bars = rows.map(r =>
      '<div class="bar-row">' +
        '<div class="bar-label">' + esc(r.bucket) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' +
          (100 * num(r.clients) / max).toFixed(1) + '%"></div></div>' +
        '<div class="bar-value">' + int(r.clients) + ' · ' + pct(r.pct) + '</div>' +
      '</div>').join('');
    const r0 = rows[0];
    return '<div class="bars">' + bars + '</div>' +
      '<p class="note">Медиана — ' + days(r0.median_days) + ' по ' + int(r0.repeaters) +
      ' клиентам со вторым заказом. Повтор в тот же день попадает в «0–7»; старый дашборд ' +
      'такие отбрасывает.</p>';
  }

  // ── Риск оттока ───────────────────────────────────────────────────────────
  // Сначала самые ценные: из «давно не заказывал» важнее тот, кто принёс больше.
  function riskRows(risk, level) {
    return risk.filter(r => r.risk === level)
               .sort((a, b) => num(b.revenue) - num(a.revenue) ||
                               String(a.client_key).localeCompare(String(b.client_key)));
  }

  function renderRisk(risk, level, limit) {
    const rows = riskRows(risk, level);
    if (!rows.length) return empty('Никого.');
    const shown = rows.slice(0, limit);
    const body = shown.map(r =>
      '<tr>' +
        '<th scope="row"><div class="who">' + esc(r.name || '—') + '</div>' +
          '<div class="where">' + esc(r.city || '') + '</div></th>' +
        '<td class="num">' + int(r.orders) + '</td>' +
        '<td class="num">' + money(r.revenue) + '</td>' +
        '<td class="num">' + date(r.last_at) + '</td>' +
        '<td class="num">' + days(r.days_since_last) + '</td>' +
        '<td class="num">' + days(r.expected_gap) + '</td>' +
        '<td class="num strong">' + times(r.overdue_x) + '</td>' +
      '</tr>').join('');
    return '<div class="table-scroll"><table class="grid sticky-first">' +
      '<thead><tr><th scope="col">Клиент</th><th scope="col">Заказов</th><th scope="col">Выручка</th>' +
      '<th scope="col">Последний заказ</th><th scope="col">Прошло</th><th scope="col">Обычно</th>' +
      '<th scope="col">Просрочка</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      (rows.length > shown.length
        ? '<button type="button" class="more" data-action="risk-all">Показать всех: ' + int(rows.length) + '</button>'
        : '');
  }

  // ── Новые и повторные по месяцам ─────────────────────────────────────────
  // opts.months — месяцы, у которых есть разбор (снимок sql/29): они
  // кликаются; opts.selected — какой разобран сейчас. Без opts таблица та же,
  // что до разбора (06.10.2026).
  function renderMonthly(rows, opts) {
    if (!rows.length) return empty('Нет данных.');
    const o = opts || {};
    const can = new Set(o.months || []);
    const label = r => {
      const key = monthKey(r.month);
      if (!key || !can.has(key)) return monthName(r.month);
      return '<button type="button" class="month-link" data-action="month-mix" data-month="' + key + '" aria-pressed="' +
        (key === o.selected) + '" title="Кто покупал в этом месяце">' + monthName(r.month) + '</button>';
    };
    const body = rows.map(r =>
      '<tr' + (monthKey(r.month) && monthKey(r.month) === o.selected && can.has(o.selected) ? ' class="on"' : '') + '>' +
        '<th scope="row">' + label(r) + '</th>' +
        '<td class="num">' + int(r.buyers) + '</td>' +
        '<td class="num">' + int(r.new_buyers) + '</td>' +
        '<td class="num">' + int(num(r.buyers) - num(r.new_buyers)) + '</td>' +
        '<td class="num">' + money(r.revenue) + '</td>' +
        '<td class="num">' + pct(r.pct_returning) + '</td></tr>').join('');
    return '<div class="table-scroll"><table class="grid sticky-first">' +
      '<thead><tr><th scope="col">Месяц</th><th scope="col">Покупателей</th><th scope="col">Новых</th>' +
      '<th scope="col">Вернувшихся</th><th scope="col">Выручка</th><th scope="col">Доля выручки от вернувшихся</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  // ── Кто покупал в месяце (sql/29, v_client_month_mix) ────────────────────
  // Клик по месяцу таблицы выше — разбор его покупателей (просьба владельца
  // 06.10.2026: «нажал на октябрь — увидел: новых 15, быстрый повтор 20, с
  // сентября 30, с августа 50»). Группы не пересекаются, их сумма — все
  // покупатели месяца:
  //   new    новый клиент, в этом месяце купил один раз (или несколько раз
  //          в один день — это одна покупка)
  //   quick  новый клиент, купил ещё раз в этом же месяце позже — быстрый повтор
  //   back   пришёл раньше, вернулся; строка на каждый прошлый месяц, ноль — тоже
  // «Новых» в таблице выше = new + quick: старый дашборд делил так же («только
  // новые» + «быстрый повтор»), отсюда его июнь 240 + 50 против когорты 290.
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
                      'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MIX_GROUPS = ['new', 'quick', 'back'];

  // «из сентября»; год — только если он не тот, что у разбираемого месяца.
  function fromMonth(cohort, ref) {
    const key = monthKey(cohort);
    if (!key) return '—';
    return 'из ' + MONTHS_GEN[Number(key.slice(5, 7)) - 1] + (ref && ref.slice(0, 4) !== key.slice(0, 4) ? ' ' + key.slice(0, 4) : '');
  }

  // Строки снимка (месяц × группа × когорта) → месяцы по порядку, у каждого
  // new, quick, back (свежие когорты сверху: из сентября, из августа…) и итоги.
  function monthMix(rows) {
    const by = new Map();
    (rows || []).forEach(r => {
      const month = monthKey(r.month), cohort = monthKey(r.cohort);
      if (!month || !cohort || MIX_GROUPS.indexOf(r.grp) < 0) return;
      if (!by.has(month)) by.set(month, { month, complete: true, new: null, quick: null, back: [] });
      const m = by.get(month);
      if (r.complete === false) m.complete = false;
      const g = { cohort, buyers: num(r.buyers), mini: num(r.buyers_mini), packs: num(r.packs),
                  revenue: num(r.revenue), cohortClients: num(r.cohort_clients) };
      if (r.grp === 'back') m.back.push(g); else m[r.grp] = g;
    });
    const zero = month => ({ cohort: month, buyers: 0, mini: 0, packs: 0, revenue: 0, cohortClients: 0 });
    const sum = list => ['buyers', 'mini', 'packs', 'revenue'].reduce((o, col) => {
      o[col] = list.reduce((s, g) => s + g[col], 0); return o;
    }, {});
    return Array.from(by.values())
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
      .map(m => {
        m.new = m.new || zero(m.month);
        m.quick = m.quick || zero(m.month);
        m.back.sort((a, b) => (a.cohort < b.cohort ? 1 : a.cohort > b.cohort ? -1 : 0));
        m.backTotal = sum(m.back);
        m.newTotal = sum([m.new, m.quick]);
        m.total = sum([m.new, m.quick].concat(m.back));
        return m;
      });
  }

  // month — 'YYYY-MM'; нет такого — последний месяц. opts.monthly — строка
  // таблицы выше за этот месяц: разошлась с разбором — так и сказано.
  function renderMonthMix(rows, month, opts) {
    const list = monthMix(rows);
    if (!list.length) return empty('Нет данных.');
    const m = list.find(x => x.month === month) || list[list.length - 1];
    const o = opts || {};
    const cell = v => '<td class="num' + (v ? '' : ' muted') + '">' + int(v) + '</td>';
    const line = (label, sub, g, cls) =>
      '<tr' + (cls ? ' class="' + cls + '"' : '') + '><th scope="row">' + label +
        (sub ? '<div class="where">' + sub + '</div>' : '') + '</th>' +
        cell(g.buyers) + cell(g.mini) + cell(g.packs) +
        '<td class="num' + (g.revenue ? '' : ' muted') + '">' + money(g.revenue) + '</td></tr>';
    const newAll = m.newTotal.buyers;
    const back = m.back.map(g => line(fromMonth(g.cohort, m.month),
      g.cohortClients ? pctInt(share(g.buyers, g.cohortClients)) + ' от ' + int(g.cohortClients) + ' новых' : '', g, 'mix-from')).join('');
    const body =
      line('Новые', 'купили один раз', m.new) +
      line('Быстрый повтор', 'новые, купили ещё раз в этом же месяце' +
           (newAll ? ' · ' + pctInt(share(m.quick.buyers, newAll)) + ' новых' : ''), m.quick) +
      (m.back.length ? line('Вернулись', 'пришли в прошлые месяцы', m.backTotal, 'mix-sub') + back : '') +
      line('Всего покупателей', '', m.total, 'mix-total');
    const mon = o.monthly;
    const off = mon && (num(mon.buyers) !== m.total.buyers || num(mon.new_buyers) !== newAll);
    return '<h3 class="mix-title">' + esc(monthName(m.month).replace(/^./, c => c.toUpperCase())) +
        (m.complete ? '' : ' <span class="muted">· месяц идёт</span>') + ' — кто покупал</h3>' +
      '<div class="table-scroll"><table class="grid sticky-first mix-grid">' +
      '<thead><tr><th scope="col">Кто</th><th scope="col">Клиентов</th><th scope="col">С мини-пака</th>' +
      '<th scope="col">Пачек</th><th scope="col">Выручка</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      (off ? '<p class="note warn" role="status">Не сходится с таблицей выше: там ' + int(mon.buyers) + ' покупателей и ' +
             int(mon.new_buyers) + ' новых, здесь ' + int(m.total.buyers) + ' и ' + int(newAll) +
             '. Проверка — в sql/29_client_months.sql, раздел «Проверка руками».</p>' : '') +
      '<p class="note">Новые и быстрый повтор вместе — это «Новых» в таблице выше. Быстрый повтор — новый клиент ' +
      'купил ещё раз в этом же месяце, позже первого дня (два заказа в один день — одна покупка). «Вернулись из …» — ' +
      'пришли в том месяце и купили в этом; доля — от новых того месяца. «С мини-пака» — сколько из них начинали ' +
      'с мини-пака: в первый день купили только мини-паки. Пачек — больших упаковок, купленных в этом месяце. ' +
      'Месяц — календарный, по дню выдачи' + (m.complete ? '.' : '; он ещё идёт — числа вырастут, а «новые» могут ' +
      'стать быстрым повтором.') + '</p>';
  }

  // ── LTV по месяцам жизни (sql/29, v_client_ltv_curve) ────────────────────
  // Сколько в среднем приносит ОДИН новый клиент к концу месяца +0, +1, … —
  // прибыль, выручка или большие пачки, накопленно. Кривая на группу, по
  // цепочке когорт (шапка 29): идущий месяц и месяц запуска не входят.
  // Разрезы: все; пачка / мини-пак (с чего начал); размер первой покупки —
  // это возраст ребёнка, то есть сколько ещё семье нужны подгузники.
  // Просьба владельца 06.10.2026: «LTV по месяцам и упаковкам».
  const LTV_METRICS = { profit: 'Прибыль', revenue: 'Выручка', packs: 'Пачки' };
  const LTV_DIMS = { all: 'Все', entry: 'Пачка или мини-пак', size: 'Размер первой покупки' };
  const LTV_GROUPS = { all: 'Все новые', regular: 'Начали с пачки', mini: 'Начали с мини-пака',
                       S: 'S', M: 'M', L: 'L', XL: 'XL', XXL: 'XXL', several: 'Несколько размеров', other: 'Без размера' };
  const LTV_ORDER = ['all', 'regular', 'mini', 'S', 'M', 'L', 'XL', 'XXL', 'several', 'other'];
  const LTV_MIN_N = 30;   // меньше — шаг шумный: показываем серым, но показываем

  // Строки снимка (разрез × группа × k) → группы с точками кривой.
  function ltvCurves(rows) {
    const by = new Map();
    (rows || []).forEach(r => {
      if (!LTV_DIMS[r.dim] || !LTV_GROUPS[r.grp] || !isNum(r.k)) return;
      const key = r.dim + '|' + r.grp;
      if (!by.has(key)) by.set(key, { dim: r.dim, grp: r.grp, clients: num(r.clients), miniShare: isNum(r.mini_share) ? Number(r.mini_share) : null,
                                      newShare: isNum(r.new_share) ? Number(r.new_share) : null,
                                      cacMeta: isNum(r.cac_meta) ? Number(r.cac_meta) : null,
                                      cacAll: isNum(r.cac_blended) ? Number(r.cac_blended) : null, points: [] });
      const c = by.get(key);
      c.points[Number(r.k)] = { k: Number(r.k), n: num(r.n), profit: isNum(r.profit) ? Number(r.profit) : null,
                                revenue: isNum(r.revenue) ? Number(r.revenue) : null, packs: isNum(r.packs) ? Number(r.packs) : null };
    });
    return by;
  }

  function renderLtvCurve(rows, opts) {
    const o = opts || {};
    const dim = LTV_DIMS[o.dim] ? o.dim : 'all';
    const metric = LTV_METRICS[o.metric] ? o.metric : 'profit';
    const by = ltvCurves(rows);
    const all = by.get('all|all');
    const list = (dim === 'all' ? [all] : [all].concat(LTV_ORDER.filter(g => g !== 'all').map(g => by.get(dim + '|' + g))))
      .filter(Boolean);
    if (!list.length) return empty('Кривой пока нет: нужен хотя бы один закрытый месяц после месяца запуска.');
    const maxK = list.reduce((m, c) => Math.max(m, c.points.length - 1), 0);
    const fmt = v => (metric === 'packs' ? (isNum(v) ? nf2.format(Number(v)) : '?') : (isNum(v) ? money(v) : '?'));
    const what = { profit: 'прибыли', revenue: 'выручки', packs: 'больших пачек' }[metric];
    const cac = all && all.cacMeta;
    const cell = (c, p) => {
      if (!p) return '<td class="num na"></td>';
      const v = p[metric];
      const weak = p.n < LTV_MIN_N;
      const paid = metric === 'profit' && c.grp === 'all' && isNum(cac) && isNum(v) && v >= cac;
      return '<td class="num' + (weak ? ' muted' : '') + (paid ? ' good' : '') + '" title="' +
        esc(LTV_GROUPS[c.grp] + ', к концу +' + p.k + ' мес.: ' + (metric === 'packs' ? fmt(v) + ' пачки' : fmt(v)) +
            ' ' + what + ' на клиента · шаг по ' + int(p.n) + ' клиентам' + (weak ? ' — мало, число шумное' : '')) + '">' +
        fmt(v) + '</td>';
    };
    const extra = dim !== 'all';
    // Размер группы — подписью под названием, а не столбцами: на телефоне
    // сразу за названием идёт сама кривая, ради которой блок.
    const meta = c => 'клиентов ' + int(c.clients) +
      (extra && c.grp !== 'all' ? ' · ' + pctInt(c.newShare) + ' новых' : '') +
      (dim === 'size' ? ' · с мини-пака ' + pctInt(c.miniShare) : '');
    const head = '<tr><th scope="col">Группа</th>' +
      Array.from({ length: maxK + 1 }, (_, k) => '<th scope="col">+' + k + NBSP + 'мес.</th>').join('') + '</tr>';
    const body = list.map(c =>
      '<tr' + (extra && c.grp === 'all' ? ' class="ltv-ref"' : '') + '><th scope="row">' + esc(LTV_GROUPS[c.grp]) +
        '<div class="where">' + meta(c) + '</div></th>' +
        Array.from({ length: maxK + 1 }, (_, k) => cell(c, c.points[k])).join('') +
      '</tr>').join('');
    let cacNote = '';
    if (metric === 'profit' && all && isNum(cac)) {
      const hit = all.points.find(p => p && isNum(p.profit) && p.profit >= cac);
      cacNote = '<p class="note">CAC Meta в среднем по когортам кривой — ' + money(cac) +
        (isNum(all.cacAll) ? ' (вместе с рекламой Kaspi — ' + money(all.cacAll) + ')' : '') + '. ' +
        (hit ? 'Прибыль «Все новые» догоняет его к концу +' + hit.k + NBSP + 'мес. (зелёным).'
             : 'Прибыль «Все новые» не догоняет его за известные месяцы.') +
        ' У групп своего CAC нет: откуда пришёл клиент, неизвестно.</p>';
    }
    return '<div class="table-scroll"><table class="grid sticky-first ltv-grid">' +
      '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' + cacNote +
      '<p class="note">Сколько ' + what + ' в среднем принёс ОДИН новый клиент к концу месяца после первой покупки — ' +
      'в том числе те, кто больше не вернулся. +0 — остаток месяца первой покупки, в среднем полмесяца. ' +
      'Кривая по цепочке: каждый следующий месяц прибавляет средний прирост у когорт, где он уже закрыт; ' +
      'идущий месяц и месяц запуска (март) не входят. Серым — шаг меньше чем по ' + LTV_MIN_N + ' клиентам, число шумное; ' +
      'наведите на ячейку — по скольким.' +
      (dim === 'size' ? ' Размер — по первой покупке, пачки и мини-паки вместе; «несколько размеров» — в первый день купили ' +
        'разные; «без размера» — в первый день не было подгузников с размером в названии (салфетки, плед, набор, пробник). ' +
        'Размер — это возраст ребёнка: чем меньше размер, тем дольше семье нужны подгузники.' : '') +
      (dim === 'entry' ? ' Пачка или мини-пак — с чего клиент начал: в первый день только мини-паки — «мини-пак».' : '') +
      (metric === 'profit' ? ' Прибыль — верхняя оценка, пока не разобраны бонусы Kaspi (около 6 % выручки).' : '') + '</p>';
  }

  // ── Удержание когорт по месяцам (sql/27) ─────────────────────────────────
  // Строка — новые клиенты месяца, столбец — календарный месяц после первого.
  // Доля — от новых этого месяца. Два счёта на одних строках, переключатель
  // над таблицей: «купили в месяце» (пропуски до него не важны) и «подряд»
  // (покупали каждый месяц с +1, пропустил — выпал). Цвет — подсказка, число
  // в ячейке всегда написано: одна зелёная шкала, темнее — больше.
  const RET_MODES = { any: 'Купили в месяце', streak: 'Подряд, без пропусков' };
  // Разрез по первой покупке (v_client_retention_entry, 03.10.2026): у
  // пришедших через мини-пак удержание вдвое ниже, а их доля среди новых
  // меняется от месяца к месяцу — общая цифра смешивает две разные группы.
  const RET_ENTRIES = { all: 'Любая', mini: 'Мини-пак', regular: 'Обычная пачка' };
  const RET_ENTRY_NOTE = {
    mini: 'Мини-пак — в первый день клиент купил только мини-паки (по 3 шт.).',
    regular: 'Обычная пачка — в первый день была хотя бы одна большая пачка (или состав заказа неизвестен).'
  };
  const RET_HEAT_MAX = 0.6;   // доля 60 % и выше — самая тёмная ячейка

  function pctInt(v) { return isNum(v) ? nf0.format(Math.round(Number(v) * 100)) + NBSP + '%' : '—'; }
  function share(part, whole) { return num(whole) > 0 ? num(part) / num(whole) : null; }

  // Строки снимка (когорта × k) → когорты с ячейками по k. k = 0 — месяц
  // первой покупки: размер когорты и повтор в том же месяце.
  function retentionGrid(rows) {
    const by = new Map();
    (rows || []).forEach(r => {
      const key = String(r.cohort || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(key)) return;
      if (!by.has(key)) by.set(key, { cohort: key, newClients: num(r.new_clients), sameMonth: null, forming: false, cells: [] });
      const c = by.get(key), k = Number(r.k);
      if (k === 0) {
        c.sameMonth = isNum(r.same_month) ? Number(r.same_month) : null;
        c.forming = r.complete === false;
      } else if (k > 0) {
        c.cells[k] = { k, month: String(r.month || '').slice(0, 7), active: num(r.active), streak: num(r.streak),
                       complete: r.complete === true };
      }
    });
    const cohorts = Array.from(by.values()).sort((a, b) => (a.cohort < b.cohort ? -1 : a.cohort > b.cohort ? 1 : 0));
    const maxK = cohorts.reduce((m, c) => Math.max(m, c.cells.length - 1), 0);
    return { cohorts, maxK };
  }

  function retTitle(c, cell) {
    const n = c.newClients, prev = cell.k > 1 ? c.cells[cell.k - 1] : null;
    return monthName(c.cohort) + ' → ' + monthName(cell.month) + ': купили ' + int(cell.active) + ' из ' + int(n) +
      ' (' + pctInt(share(cell.active, n)) + '); подряд с первого месяца — ' + int(cell.streak) +
      ' (' + pctInt(share(cell.streak, n)) + ')' +
      (prev && prev.streak > 0 ? ', это ' + pctInt(share(cell.streak, prev.streak)) + ' от покупавших подряд месяцем раньше' : '') +
      (cell.complete ? '' : '. Месяц ещё идёт — число вырастет.');
  }

  function retCell(c, cell, mode) {
    if (!cell) return '<td class="ret na"></td>';
    const v = mode === 'streak' ? cell.streak : cell.active;
    const sh = share(v, c.newClients);
    // Идущий месяц не красим: его доля ещё растёт и с соседями несравнима.
    const h = cell.complete && sh !== null ? Math.min(1, sh / RET_HEAT_MAX) : 0;
    return '<td class="ret' + (cell.complete ? '' : ' part') + '" style="--h:' + h.toFixed(2) + '" title="' +
      esc(retTitle(c, cell)) + '"><b>' + pctInt(sh) + (cell.complete ? '' : '*') + '</b>' +
      '<span class="ret-n">' + int(v) + '</span></td>';
  }

  // opts.entry — группа первой покупки; opts.totals — новых всего по когорте
  // ('YYYY-MM' → число), чтобы в группе было видно её долю: состав новых
  // меняется, и это объясняет сдвиги общей цифры.
  function renderRetention(rows, mode, opts) {
    const g = retentionGrid(rows);
    const o = opts || {};
    const entry = RET_ENTRIES[o.entry] ? o.entry : 'all';
    if (!g.cohorts.length) return empty(entry === 'all' ? 'Когорт пока нет.' : 'В этой группе клиентов пока нет.');
    const m = RET_MODES[mode] ? mode : 'any';
    const totals = entry !== 'all' && o.totals ? o.totals : null;
    const newCell = c => {
      if (!totals) return '<td class="num">' + int(c.newClients) + '</td>';
      const t = totals[c.cohort];
      return '<td class="ret same"><b>' + int(c.newClients) + '</b><span class="ret-n">' +
        (isNum(t) && t > 0 ? pctInt(c.newClients / t) + ' всех' : '') + '</span></td>';
    };
    const ks = [];
    for (let k = 1; k <= g.maxK; k++) ks.push(k);
    const head = '<tr><th scope="col">Когорта</th><th scope="col">Новых</th><th scope="col">В том же месяце</th>' +
      ks.map(k => '<th scope="col">+' + k + NBSP + 'мес.</th>').join('') + '</tr>';
    const body = g.cohorts.map(c =>
      '<tr><th scope="row">' + monthName(c.cohort) + (c.forming ? '*' : '') + '</th>' +
        newCell(c) +
        '<td class="ret same"><b>' + pctInt(share(c.sameMonth, c.newClients)) + (c.forming ? '*' : '') + '</b>' +
          '<span class="ret-n">' + int(c.sameMonth) + '</span></td>' +
        ks.map(k => retCell(c, c.cells[k], m)).join('') +
      '</tr>').join('');
    const scale = [0.2, 0.4, 0.6, 0.8, 1].map(h => '<i style="--h:' + h + '"></i>').join('');
    return '<div class="table-scroll"><table class="grid sticky-first ret-grid">' +
      '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="ret-legend" aria-hidden="true">0' + NBSP + '%' + scale + '60' + NBSP + '% и выше</div>' +
      '<p class="note">' + (m === 'streak'
        ? '«Подряд» — покупали в каждом месяце с первого следующего, без пропуска. Пропустил месяц — выпал, даже если потом вернулся.'
        : '«Купили в месяце» — купили в этом месяце хотя бы раз, неважно, был ли пропуск до него.') +
      (entry === 'all' ? ' Доля — от новых клиентов месяца.'
                       : ' ' + RET_ENTRY_NOTE[entry] + ' Доля — от новых этой группы; под числом новых — её доля среди всех новых месяца.') +
      ' «В том же месяце» — ещё одна покупка в месяце первой, позже её дня. ' +
      'Месяц — календарный, по дню выдачи. * — месяц ещё идёт, число вырастет. На компьютере наведите на ячейку — ' +
      'оба счёта и доля от прошлого месяца. Сравнивать когорты — по одному столбцу.</p>';
  }

  // ── Вход через мини-пак ───────────────────────────────────────────────────
  function renderEntry(rows) {
    if (!rows.length) return empty('Нет данных.');
    const body = rows.map(r =>
      '<tr><th scope="row">' + esc(r.entry) + '</th>' +
        '<td class="num">' + int(r.clients) + '</td>' +
        '<td class="num">' + (isNum(r.avg_orders) ? nf2.format(Number(r.avg_orders)) : '—') + '</td>' +
        '<td class="num">' + money(r.avg_ltv) + '</td>' +
        '<td class="num">' + money(r.avg_profit) + '</td>' +
        '<td class="num">' + days(r.avg_age_days) + '</td></tr>').join('');
    return '<div class="table-scroll"><table class="grid">' +
      '<thead><tr><th scope="col">Первый заказ</th><th scope="col">Клиентов</th><th scope="col">Заказов на клиента</th>' +
      '<th scope="col">Выручка на клиента</th><th scope="col">Прибыль на клиента</th><th scope="col">Средний возраст</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  // ── База клиентов ─────────────────────────────────────────────────────────
  // Порядок ничьей — по client_key: одинаковые суммы не должны прыгать
  // местами от перерисовки к перерисовке.
  const SORTS = {
    revenue: { label: 'Больше выручки',     cmp: (a, b) => num(b.revenue) - num(a.revenue) },
    orders:  { label: 'Больше заказов',     cmp: (a, b) => num(b.orders) - num(a.orders) || num(b.revenue) - num(a.revenue) },
    lapsed:  { label: 'Давно не заказывали', cmp: (a, b) => num(b.days_since_last) - num(a.days_since_last) },
    newest:  { label: 'Новые сверху',       cmp: (a, b) => String(b.first_at || '').localeCompare(String(a.first_at || '')) }
  };

  function filterBase(rows, query, sortKey) {
    const q = String(query || '').trim().toLowerCase();
    const out = q
      ? rows.filter(r => (String(r.name || '') + ' ' + String(r.city || '')).toLowerCase().indexOf(q) !== -1)
      : rows.slice();
    const cmp = (SORTS[sortKey] || SORTS.revenue).cmp;
    return out.sort((a, b) => cmp(a, b) || String(a.client_key).localeCompare(String(b.client_key)));
  }

  const RISK_BADGE = { 'высокий': 'bad', 'средний': 'warn' };

  function renderBaseTable(rows, riskByKey, limit) {
    if (!rows.length) return empty('Никого не нашлось.');
    const shown = rows.slice(0, limit);
    const body = shown.map(r => {
      const risk = riskByKey[r.client_key];
      // Прибыль клиента — строгая: NULL, если хоть один его заказ без
      // себестоимости. Тогда рядом сумма по известным, с пометкой.
      const profit = isNum(r.profit) ? money(r.profit)
        : (isNum(r.profit_partial) ? '<span class="muted" title="Не все заказы посчитаны">≥' + NBSP + money(r.profit_partial) + '</span>' : '—');
      return '<tr>' +
        '<th scope="row"><div class="who">' + esc(r.name || '—') + '</div>' +
          '<div class="where">' + esc(r.city || '') + (r.entry_mini ? ' · вход с мини-пака' : '') + '</div></th>' +
        '<td class="num">' + int(r.orders) + '</td>' +
        '<td class="num">' + money(r.revenue) + '</td>' +
        '<td class="num">' + profit + '</td>' +
        '<td class="num">' + date(r.first_at) + '</td>' +
        '<td class="num">' + date(r.last_at) + '</td>' +
        '<td class="num">' + days(r.gap_days) + '</td>' +
        '<td class="num">' + (risk && RISK_BADGE[risk] ? '<span class="badge ' + RISK_BADGE[risk] + '">' + esc(risk) + '</span>' : '') + '</td>' +
      '</tr>';
    }).join('');
    return '<div class="table-scroll tall"><table class="grid sticky-first">' +
      '<thead><tr><th scope="col">Клиент</th><th scope="col">Заказов</th><th scope="col">Выручка</th>' +
      '<th scope="col">Прибыль</th><th scope="col">Первый заказ</th><th scope="col">Последний</th>' +
      '<th scope="col">Интервал</th><th scope="col">Риск</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      (rows.length > shown.length
        ? '<button type="button" class="more" data-action="base-more">Ещё ' +
          int(Math.min(50, rows.length - shown.length)) + ' из ' + int(rows.length - shown.length) + '</button>'
        : '');
  }

  function renderNotes() {
    return '<ul class="notes">' +
      '<li>Только Kaspi: Ozon и WB не отдают, кто покупатель.</li>' +
      '<li>Заказы, где покупателя опознать нельзя (ключ <code>un:</code>, около 9%), в клиентов не входят. ' +
      'Старый дашборд считает каждый такой заказ отдельным клиентом — поэтому здесь клиентов меньше, ' +
      'а заказов на клиента больше.</li>' +
      '<li>Кто есть кто, пока решает склейка Apps Script (таблица <code>client_ids</code>): своей в Postgres ещё нет.</li>' +
      '<li>Прибыль — по заказам с известной себестоимостью и комиссией; неизвестное — прочерк, а не ноль.</li>' +
      '<li>Цифры — снимок, база пересчитывает его раз в 10 минут. На какой момент они верны — ' +
      'в строке «Данные на» вверху страницы.</li>' +
      '<li><b>Удержание по месяцам</b> — когортное: доля от новых клиентов своего месяца, поэтому от объёма ' +
      'привлечения не зависит. «Доля повторных» в помесячной динамике растёт сама, когда новых становится меньше, — ' +
      'сравнивать месяцы по ней нельзя. Старый дашборд считал удержание окнами по 30 дней от первой покупки и ' +
      'накопительно — с этой таблицей его цифры не совпадут.</li>' +
    '</ul>';
  }

  root.NietteClients = {
    esc, int, money, pct, times, days, date, monthName, isNum,
    computeKpis, renderKpis, renderCohorts, renderRepeat, riskRows, renderRisk,
    renderMonthly, renderEntry, SORTS, filterBase, renderBaseTable, renderNotes,
    sectionError, empty, RET_MODES, RET_ENTRIES, RET_HEAT_MAX, retentionGrid, renderRetention,
    monthKey, fromMonth, monthMix, renderMonthMix,
    LTV_METRICS, LTV_DIMS, LTV_GROUPS, LTV_MIN_N, ltvCurves, renderLtvCurve
  };
})(typeof window !== 'undefined' ? window : globalThis);
