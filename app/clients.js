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
 *   v_client_summary    главное о клиентах: за первые 30 … 180 дней, как часто покупают,
 *                       сколько остаются, окупаемость, мини-пак → пачка (sql/30)
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

  // ── Главное о клиентах (sql/30, v_client_summary) ────────────────────────
  // Просьба владельца 07.10.2026: сколько новых и повторных в месяце, сколько
  // пачек и выручки приносит новый клиент, как часто он покупает, сколько
  // остаётся, через сколько пачек и месяцев окупается. Повод — КП для
  // педиатров, поэтому отдельно путь «мини-пак → пачка»: ближайший аналог
  // подарка от врача. Окна — ДНИ от первой покупки клиента (30 … 180), а не
  // календарные месяцы, как в LTV ниже: «за первые 90 дней» понятно и врачу,
  // а +0 календарного месяца — в среднем полмесяца (шапка sql/30).
  const SUM_GROUPS = { all: 'Все новые', regular: 'Начали с пачки', mini: 'Начали с мини-пака' };
  const SUM_H = [30, 60, 90, 120, 150, 180];
  const SUM_MIN_N = 30;   // меньше — число шумное: серым, но показываем
  const SUM_BUCKETS = ['1–7 дней', '8–14 дней', '15–30 дней', '31–60 дней', '61+ дней'];

  // Слово после числа: 1 клиент, 2 клиента, 5 клиентов; 11–14 — как 5.
  function ru(n, one, few, many) {
    const a = Math.abs(Math.round(num(n))) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    return b > 1 && b < 5 ? few : many;
  }
  const byClients = n => 'по ' + int(n) + ' ' + ru(n, 'клиенту', 'клиентам', 'клиентам');

  // Строки снимка (группа × когорта × показатель × окно) → поиск по ключу.
  // cohort — 'YYYY-MM' или пусто (все когорты).
  function summaryIndex(rows) {
    const m = new Map();
    const key = (grp, cohort, metric, h) => grp + '|' + (cohort || '') + '|' + metric + '|' + (isNum(h) ? Number(h) : '');
    (rows || []).forEach(r => {
      if (!SUM_GROUPS[r.grp] || !r.metric) return;
      m.set(key(r.grp, monthKey(r.cohort), r.metric, r.h), { value: isNum(r.value) ? Number(r.value) : null, n: num(r.n) });
    });
    const cohorts = metric => Array.from(new Set((rows || [])
      .filter(r => r.grp === 'all' && r.metric === metric && monthKey(r.cohort) && isNum(r.value))
      .map(r => monthKey(r.cohort)))).sort();
    return { size: m.size, get: (grp, metric, h, cohort) => m.get(key(grp, cohort, metric, h)) || null, cohorts };
  }

  // Окупаемость: день, к которому накопленная прибыль нового клиента группы
  // догоняет CAC, — между точками цепочки по прямой; пачки к этому дню — так
  // же. Не догнала за последнее известное окно — сколько набрано.
  function paybackOf(S, grp, cac) {
    if (!isNum(cac) || Number(cac) <= 0) return null;
    const c = Number(cac);
    let prev = null;
    for (const h of SUM_H) {
      const p = S.get(grp, 'profit', h), u = S.get(grp, 'packs', h);
      if (!p) break;
      if (p.value === null) return { unknown: true, h };
      const packs = u && u.value !== null ? u.value : null;
      if (p.value >= c) {
        if (!prev) return { first: true, day: h, packs, n: p.n };
        const t = (c - prev.profit) / (p.value - prev.profit);
        return { day: Math.round(prev.h + t * (h - prev.h)), n: p.n,
                 packs: packs !== null && prev.packs !== null ? prev.packs + t * (packs - prev.packs) : null };
      }
      prev = { h, profit: p.value, packs, n: p.n };
    }
    return prev ? { day: null, lastH: prev.h, share: prev.profit / c, packs: prev.packs, n: prev.n } : null;
  }

  function paybackCellHtml(r) {
    if (!r) return '<td class="num muted">—</td>';
    if (r.unknown) return '<td class="num muted" title="Прибыль неизвестна: есть заказ без себестоимости">?</td>';
    const weak = r.n < SUM_MIN_N ? ' muted' : '';
    const n = ' · шаг ' + byClients(r.n) + (r.n < SUM_MIN_N ? ' — мало, число шумное' : '');
    if (r.day === null) {
      return '<td class="num bad' + weak + '" title="' + esc('За ' + r.lastH + ' дней прибыль набрала ' + pctInt(r.share) + ' CAC' + n) + '">' +
        'не за ' + r.lastH + NBSP + 'дн.<div class="where">набрано ' + pctInt(r.share) + '</div></td>';
    }
    const when = r.first ? 'в первые 30' + NBSP + 'дн.' : '≈' + NBSP + int(r.day) + NBSP + 'дн.';
    const mon = r.first ? '' : ' (' + nf1.format(r.day / 30) + NBSP + 'мес.)';
    return '<td class="num good' + weak + '" title="' + esc('Окупается ' + (r.first ? 'в первые 30 дней' : 'примерно на ' + r.day + '-й день') + n) + '">' +
      when + mon + '<div class="where">' + (isNum(r.packs) ? nf2.format(r.packs) + NBSP + 'пачки к этому дню' : '') + '</div></td>';
  }

  // Таблица окупаемости: строки — варианты CAC, столбцы — группы. cac — свой
  // CAC из поля (строка или число), пустое — строки нет. Отдельной функцией:
  // поле CAC перерисовывает только её, и фокус с курсором не прыгают.
  function renderSummaryPayback(rows, cac) {
    const S = summaryIndex(rows);
    if (!S.size) return empty('Сводки пока нет.');
    const opts = [];
    const last = S.cohorts('cac_blended').slice(-1)[0];
    if (last) {
      const all = S.get('all', 'cac_blended', null, last), meta = S.get('all', 'cac_meta', null, last);
      if (all) opts.push({ label: 'CAC ' + monthName(last) + ', вся реклама', value: all.value });
      if (meta) opts.push({ label: 'CAC ' + monthName(last) + ', только Meta', value: meta.value });
    }
    const avg = S.get('all', 'cac_blended');
    if (avg && opts.length) opts.push({ label: 'Средний CAC всех когорт, вся реклама', value: avg.value });
    const own = String(cac === null || cac === undefined ? '' : cac).replace(/[\s\u00a0₸]/g, '').replace(',', '.');
    if (own !== '' && isNum(own) && Number(own) > 0) opts.push({ label: 'Свой CAC', value: Number(own), own: true });
    if (!opts.length) return empty('Расходов на рекламу в базе нет — введите свой CAC выше.');
    const groups = Object.keys(SUM_GROUPS);
    const body = opts.map(o =>
      '<tr' + (o.own ? ' class="sum-own"' : '') + '><th scope="row">' + esc(o.label) + '<div class="where">' + money(o.value) + '</div></th>' +
        groups.map(g => paybackCellHtml(paybackOf(S, g, o.value))).join('') + '</tr>').join('');
    return '<div class="table-scroll"><table class="grid sticky-first sum-pay">' +
      '<thead><tr><th scope="col">Если клиент стоит</th>' + groups.map(g => '<th scope="col">' + esc(SUM_GROUPS[g]) + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  // Месяц: кто покупал (из разбора месяца, sql/29) и как новые этого месяца
  // купили за первые 30 дней против обычного (sql/30, когорта).
  function sumMonthHtml(S, mixList, month, grp) {
    const m = (mixList || []).find(x => x.month === month);
    if (!m) return '';
    const newAll = m.newTotal.buyers, back = m.backTotal.buyers, total = m.total.buyers;
    const coh = S.get(grp, 'packs', 30, month), cohRev = S.get(grp, 'revenue', 30, month);
    const cohN = S.get(grp, 'clients', null, month);
    const usual = S.get(grp, 'packs', 30), usualRev = S.get(grp, 'revenue', 30);
    let q;
    if (coh && coh.value !== null) {
      const diff = usual && usual.value ? coh.value / usual.value - 1 : null;
      q = card('Новые за первые 30 дней', nf2.format(coh.value) + NBSP + 'пачки',
        'выручка ' + money(cohRev && cohRev.value) + ' на клиента' +
        (usual ? ' · обычно ' + nf2.format(usual.value) + ' и ' + money(usualRev && usualRev.value) : '') +
        (isNum(diff) ? ' (' + (diff >= 0 ? '+' : '−') + pctInt(Math.abs(diff)) + ')' : '') +
        (cohN && coh.n < cohN.value ? ' · по ' + int(coh.n) + ' из ' + int(cohN.value) + ': у остальных 30 дней ещё не прошло' : ''),
        isNum(diff) && diff <= -0.1 ? 'warn' : '');
    } else {
      q = card('Новые за первые 30 дней', '—', 'у новых этого месяца 30 дней ещё не прошло');
    }
    return '<h3 class="sum-title">' + esc(monthName(m.month).replace(/^./, c => c.toUpperCase())) +
        (m.complete ? '' : ' <span class="muted">· месяц идёт</span>') + '</h3>' +
      '<div class="kpi-grid sum-kpis">' +
        card('Покупателей', int(total), m.complete ? 'за месяц' : 'пока, месяц идёт') +
        card('Новых', int(newAll), (m.quick.buyers ? int(m.quick.buyers) + ' из них купили ещё раз в этом месяце' : 'второй раз в этом месяце никто') +
             ' · с мини-пака ' + pctInt(share(m.newTotal.mini, newAll))) +
        card('Повторных', int(back), 'вернулись из прошлых месяцев · ' + pctInt(share(back, total)) + ' покупателей') +
        q +
      '</div>';
  }

  function sumTableHtml(S, grp) {
    const hs = SUM_H.filter(h => S.get(grp, 'purchases', h));
    if (!hs.length) return empty('Пока нет клиентов, с первой покупки которых прошло 30 дней.');
    const defs = [['packs', 'Больших пачек', v => nf2.format(v)], ['purchases', 'Покупок', v => nf2.format(v)],
                  ['revenue', 'Выручка', v => money(v)], ['profit', 'Прибыль', v => money(v)]];
    const what = { packs: 'больших пачек', purchases: 'покупок', revenue: 'выручки', profit: 'прибыли' };
    const cell = (metric, fmt, h) => {
      const x = S.get(grp, metric, h);
      if (!x) return '<td class="num na"></td>';
      const weak = x.n < SUM_MIN_N;
      const title = SUM_GROUPS[grp] + ', первые ' + h + ' дней: ' + (x.value === null ? 'неизвестно' : fmt(x.value)) + ' ' + what[metric] +
        ' на клиента · шаг ' + byClients(x.n) + (weak ? ' — мало, число шумное' : '');
      return '<td class="num' + (weak ? ' muted' : '') + '" title="' + esc(title) + '">' + (x.value === null ? '?' : fmt(x.value)) + '</td>';
    };
    return '<div class="table-scroll"><table class="grid sticky-first sum-table">' +
      '<thead><tr><th scope="col">Первые</th>' + hs.map(h => '<th scope="col">' + h + NBSP + 'дн.</th>').join('') + '</tr></thead><tbody>' +
      defs.map(([metric, label, fmt]) => '<tr><th scope="row">' + esc(label) + '</th>' + hs.map(h => cell(metric, fmt, h)).join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }

  function sumFreqHtml(S, grp) {
    const med = S.get(grp, 'to2_median');
    if (!med) return empty('Вторых покупок пока нет.');
    const bs = [1, 2, 3, 4, 5].map(b => S.get(grp, 'to2_bucket', b));
    const max = Math.max(1, ...bs.map(b => (b ? b.value : 0)));
    const bars = bs.map((b, i) =>
      '<div class="bar-row"><div class="bar-label">' + SUM_BUCKETS[i] + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + (100 * (b ? b.value : 0) / max).toFixed(1) + '%"></div></div>' +
        '<div class="bar-value">' + int(b ? b.value : 0) + ' · ' + pctInt(share(b ? b.value : 0, med.n)) + '</div></div>').join('');
    const rep = [30, 60, 90, 180].map(h => [h, S.get(grp, 'repeat', h)]).filter(x => x[1]);
    const gm = S.get(grp, 'gap_median'), g25 = S.get(grp, 'gap_p25'), g75 = S.get(grp, 'gap_p75'), gc = S.get(grp, 'gap_clients');
    return '<p class="sum-line"><b>Вторая покупка</b> — через ' + days(med.value) + ' (медиана ' + byClients(med.n) + ')</p>' +
      '<div class="bars">' + bars + '</div>' +
      (rep.length ? '<p class="sum-line">Делают вторую покупку: ' + rep.map(([h, x]) =>
        '<span class="sum-pill' + (x.n < SUM_MIN_N ? ' muted' : '') + '" title="' + esc(byClients(x.n) + ', с первой покупки которых прошло ' + h + ' дней') + '">за ' +
        h + NBSP + 'дн. — <b>' + pctInt(x.value) + '</b></span>').join(' ') + '</p>' : '') +
      (gm && gm.value !== null ? '<p class="sum-line"><b>У постоянных</b> (купили 3 раза и больше) между покупками — ' + days(gm.value) +
        (g25 && g75 ? ', у половины интервалов — от ' + int(g25.value) + ' до ' + days(g75.value) : '') +
        (gm.value > 0 ? ': примерно ' + nf1.format(30 / gm.value) + ' покупки в месяц' : '') +
        ' <span class="muted">(' + int(gm.n) + ' ' + ru(gm.n, 'интервал', 'интервала', 'интервалов') + ' у ' + int(gc && gc.value) + ' ' +
        ru(gc && gc.value, 'клиента', 'клиентов', 'клиентов') + ')</span></p>' : '');
  }

  function sumStayHtml(S, grp) {
    const pts = SUM_H.filter(h => h >= 60).map(h => [h, S.get(grp, 'active', h)]).filter(x => x[1]);
    if (!pts.length) return empty('Пока нет клиентов, с первой покупки которых прошло 60 дней.');
    const rowsHtml = [[30, { value: 1, n: null }]].concat(pts).map(([h, x]) =>
      '<div class="bar-row' + (x.n !== null && x.n < SUM_MIN_N ? ' weak' : '') + '"' +
        (x.n !== null ? ' title="' + esc(byClients(x.n) + ', с первой покупки которых прошло ' + h + ' дней') + '"' : '') + '>' +
        '<div class="bar-label">' + (h / 30) + '-й месяц</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + (100 * x.value).toFixed(1) + '%"></div></div>' +
        '<div class="bar-value">' + pctInt(x.value) + '</div></div>').join('');
    const months = 1 + pts.reduce((s, [, x]) => s + x.value, 0);
    return '<div class="bars">' + rowsHtml + '</div>' +
      '<p class="sum-line">В среднем новый клиент покупает в <b>' + nf1.format(months) + '</b> из первых ' + (1 + pts.length) + ' месяцев</p>';
  }

  function sumMiniHtml(S) {
    const conv = [30, 60, 90, 180].map(h => [h, S.get('mini', 'conv_pack', h)]).filter(x => x[1]);
    if (!conv.length) return empty('Клиентов, начавших с мини-пака, пока нет.');
    const med = S.get('mini', 'to_pack_median');
    const cell = (g, m, h, fmt) => {
      const x = S.get(g, m, h);
      return x ? '<td class="num' + (x.n < SUM_MIN_N ? ' muted' : '') + '" title="' + esc(byClients(x.n) + ', с первой пачки которых прошло ' + h + ' дней') + '">' +
        fmt(x.value) + '</td>' : '<td class="num muted">—</td>';
    };
    const nOf = (g, h) => { const x = S.get(g, 'after_pack_packs', h); return x ? int(x.n) : '—'; };
    const line = (g, label) => '<tr><th scope="row">' + label + '<div class="where">клиентов: ' + nOf(g, 30) + ' и ' + nOf(g, 90) + '</div></th>' +
      cell(g, 'after_pack_purchases', 30, v => nf2.format(v)) + cell(g, 'after_pack_packs', 30, v => nf2.format(v)) +
      cell(g, 'after_pack_purchases', 90, v => nf2.format(v)) + cell(g, 'after_pack_packs', 90, v => nf2.format(v)) + '</tr>';
    return '<p class="sum-line">Купили большую пачку: ' + conv.map(([h, x]) =>
        '<span class="sum-pill' + (x.n < SUM_MIN_N ? ' muted' : '') + '" title="' + esc(byClients(x.n) + ', с первой покупки которых прошло ' + h + ' дней') + '">за ' +
        h + NBSP + 'дн. — <b>' + pctInt(x.value) + '</b></span>').join(' ') + '</p>' +
      (med ? '<p class="sum-line">До первой пачки — ' + days(med.value) + ' (медиана по ' + int(med.n) + ' ' + ru(med.n, 'купившему', 'купившим', 'купившим') + ')</p>' : '') +
      '<div class="table-scroll"><table class="grid sticky-first sum-after"><thead><tr><th scope="col">После первой пачки</th>' +
        '<th scope="col">Покупок за 30' + NBSP + 'дн.</th><th scope="col">Пачек за 30' + NBSP + 'дн.</th>' +
        '<th scope="col">Покупок за 90' + NBSP + 'дн.</th><th scope="col">Пачек за 90' + NBSP + 'дн.</th></tr></thead><tbody>' +
        line('mini', 'Начали с мини-пака') + line('regular', 'Начали с пачки') +
      '</tbody></table></div>' +
      '<p class="note">Это люди, которые сами заплатили за мини-пак на Kaspi. Подарок от врача — другой случай: человек не платил ' +
      '(может брать хуже), зато ему посоветовал врач (может брать лучше). Настоящую конверсию подарка покажет только пилот. ' +
      'Строки «после первой пачки» отвечают на второй вопрос КП: если мама всё-таки купила пачку, сколько она покупает дальше.</p>';
  }

  // opts: grp — группа; month — 'YYYY-MM' для блока месяца; mix — месяцы из
  // monthMix() (разбор месяца, sql/29; нет — блока месяца нет); months —
  // какие месяцы показывать кнопками; cac — свой CAC из поля.
  function renderSummary(rows, opts) {
    const S = summaryIndex(rows);
    if (!S.size) return empty('Сводки пока нет.');
    const o = opts || {};
    const grp = SUM_GROUPS[o.grp] ? o.grp : 'all';
    const mix = o.mix || [];
    const seg = (action, attr, val, on, label) => '<button type="button" data-action="' + action + '" ' + attr + '="' + val + '"' +
      ' aria-pressed="' + on + '" class="seg' + (on ? ' on' : '') + '">' + esc(label) + '</button>';
    const monthBar = mix.length
      ? '<div class="toolbar" role="group" aria-label="Месяц"><span class="toolbar-label">Месяц:</span>' +
        mix.map(m => seg('sum-month', 'data-month', m.month, m.month === o.month,
                         MONTHS[Number(m.month.slice(5, 7)) - 1].slice(0, 3) + (m.complete ? '' : '*'))).join('') + '</div>'
      : '';
    const grpBar = '<div class="toolbar" role="group" aria-label="Кто"><span class="toolbar-label">Новые клиенты:</span>' +
      Object.keys(SUM_GROUPS).map(g => seg('sum-grp', 'data-grp', g, g === grp, SUM_GROUPS[g])).join('') + '</div>';
    const base = S.get(grp, 'clients');
    const block = (title, sub, inner, cls) => '<div class="sum-block' + (cls ? ' ' + cls : '') + '"><h3 class="sum-title">' + esc(title) +
      (sub ? ' <span class="muted">' + sub + '</span>' : '') + '</h3>' + inner + '</div>';
    const cacVal = o.cac === null || o.cac === undefined ? '' : String(o.cac);
    return monthBar + (mix.length ? sumMonthHtml(S, mix, o.month, grp) : '') + grpBar +
      '<div class="sum-grid">' +
        block('Новый клиент в среднем', '· ' + esc(SUM_GROUPS[grp].toLowerCase()) + (base ? ', ' + int(base.value) + ' ' + ru(base.value, 'человек', 'человека', 'человек') : ''),
              sumTableHtml(S, grp) +
              '<p class="note">Сколько в среднем принёс ОДИН новый клиент за первые 30 … 180 дней с первой покупки — в том числе тот, ' +
              'кто больше не вернулся. Каждое окно — по клиентам, с первой покупки которых прошло столько дней; длинные окна — ' +
              'цепочкой: прирост за каждые следующие 30 дней берётся у тех, кто до них дожил. Серым — шаг меньше чем по ' + SUM_MIN_N +
              ' клиентам. Покупка — день: два заказа в один день — одна покупка. Прибыль — верхняя оценка: бонусы Kaspi ' +
              '(около 6 % выручки) не вычтены.</p>', 'sum-wide') +
        block('Как часто покупают', '', sumFreqHtml(S, grp)) +
        block('Сколько остаются', '· доля новых, кто покупал в этом месяце жизни', sumStayHtml(S, grp) +
              '<p class="note">Месяц жизни — 30 дней от первой покупки клиента; доля — от тех, кто его уже прожил. Полную ' +
              'продолжительность пока не измерить: самым старым клиентам около полугода, и часть из них ещё покупает.</p>') +
        block('Окупаемость', '· через сколько дней и пачек прибыль догоняет цену клиента',
              '<div class="toolbar sum-cac"><label for="sumCac" class="toolbar-label">Свой CAC, ₸:</label>' +
              '<input id="sumCac" type="text" inputmode="numeric" autocomplete="off" placeholder="например, 3000" value="' + esc(cacVal) + '"></div>' +
              '<div id="sumPayback">' + renderSummaryPayback(rows, o.cac) + '</div>' +
              '<p class="note">У групп своего CAC нет — откуда пришёл клиент, Kaspi не говорит. Ячейка отвечает «если бы клиент этой ' +
              'группы стоил столько». «Свой CAC» — для своего сценария, например клиента от педиатра: мини-пак и выплаты врачу на ' +
              'одну купившую маму. Зелёным — окупился за известные 180 дней, красным — нет. Прибыль — без бонусов Kaspi.</p>', 'sum-wide') +
        block('Мини-пак → большая пачка', '· ближайший аналог подарка от педиатра', sumMiniHtml(S), 'sum-wide') +
      '</div>';
  }

  root.NietteClients = {
    esc, int, money, pct, times, days, date, monthName, isNum,
    computeKpis, renderKpis, renderCohorts, renderRepeat, riskRows, renderRisk,
    renderMonthly, renderEntry, SORTS, filterBase, renderBaseTable, renderNotes,
    sectionError, empty, RET_MODES, RET_ENTRIES, RET_HEAT_MAX, retentionGrid, renderRetention,
    monthKey, fromMonth, monthMix, renderMonthMix,
    LTV_METRICS, LTV_DIMS, LTV_GROUPS, LTV_MIN_N, ltvCurves, renderLtvCurve,
    SUM_GROUPS, SUM_H, SUM_MIN_N, summaryIndex, paybackOf, renderSummary, renderSummaryPayback
  };
})(typeof window !== 'undefined' ? window : globalThis);
