/* Экран «Kaspi» на снимках Postgres: расчёты и разметка.
 *
 * Как clients.js и overview.js — только чистые функции: строки снимков на
 * вход, числа и строка HTML на выход. Сеть, состояние и события — в app.js.
 * Проверяется в Node (tests/app_kaspi_test.js).
 *
 * Источники (sql/19_kaspi.sql), страница читает их снимки:
 *   snap_kaspi_daily        строка на день, вся история: выручка ровно как
 *                           строка Kaspi «Обзора», заказы, отмены, возвраты,
 *                           комиссия, себестоимость, прибыль по посчитанным
 *   snap_kaspi_client_days  пары «клиент × день покупки» — новых и повторных
 *                           за любой период из сумм по дням не сложить
 *   snap_kaspi_now          в работе сейчас (одна строка)
 *   snap_kaspi_remote       удалённые оплаты, с пометкой «вошла в выручку»
 *
 * Период, группировка и даты — общие с «Обзором» (NietteOverview): те же
 * пресеты, то же сравнение с прошлым периодом, те же недели и декады.
 */
(function (root) {
  'use strict';

  const C = root.NietteClients;
  const O = root.NietteOverview;
  const esc = C.esc, money = C.money, int = C.int, pct = C.pct, isNum = C.isNum;
  const NBSP = ' ';
  const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function num(v) { return isNum(v) ? Number(v) : 0; }
  function inRange(day, rg) { return !!rg && day >= rg.from && day <= rg.to; }
  function plural(n, one, few, many) {
    const a = Math.abs(Math.round(n)) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    return b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  }

  // Колонки снимка, которые за период складываются. Всё прочее — производное
  // и считается ниже из сумм, а не суммой производных: средний чек месяца —
  // это выдано месяца / заказы месяца, а не сумма дневных чеков.
  const SUM_COLS = ['revenue', 'gross', 'returns', 'extra', 'orders', 'qty', 'remote_n',
    'cancels_n', 'cancels_amount', 'returned_n', 'returned_amount', 'commission',
    'delivery_seller', 'delivery_buyer', 'counted_orders', 'counted_revenue',
    'counted_commission', 'counted_delivery', 'counted_cogs', 'nocogs_orders',
    'nocogs_revenue', 'new_clients'];

  function sumRange(rows, rg) {
    const t = {};
    SUM_COLS.forEach(c => { t[c] = 0; });
    rows.forEach(r => {
      if (!inRange(r.day, rg)) return;
      SUM_COLS.forEach(c => { t[c] += num(r[c]); });
    });
    return t;
  }

  // ── Клиенты: новые и повторные за любой период ────────────────────────────
  // Первый день клиента — по ВСЕЙ истории, а не по загруженному периоду:
  // иначе «новым» стал бы каждый, кто не покупал внутри периода раньше.
  function clientIndex(rows) {
    const first = new Map();
    rows.forEach(r => {
      const f = first.get(r.cid);
      if (f === undefined || r.day < f) first.set(r.cid, r.day);
    });
    return { rows, first };
  }

  // Новый — первый заказ пришёлся на период; повторный — покупал в периоде,
  // но впервые раньше. Как calculateClientStats_ в старом дашборде.
  function clientsIn(idx, rg) {
    if (!idx || !rg) return { active: null, fresh: null, repeat: null };
    const active = new Set();
    idx.rows.forEach(r => { if (inRange(r.day, rg)) active.add(r.cid); });
    let fresh = 0;
    active.forEach(cid => { if (idx.first.get(cid) >= rg.from) fresh++; });
    return { active: active.size, fresh, repeat: active.size - fresh };
  }

  // ── Метрики периода ───────────────────────────────────────────────────────
  // Прибыль — только по заказам, где известно всё (counted_*): неизвестная
  // себестоимость не превращается в ноль. Нет ни одного посчитанного
  // заказа — прибыль null, и карточка покажет прочерк, а не «0 ₸».
  function metrics(rows, idx, rg) {
    if (!rg) return null;
    const t = sumRange(rows, rg);
    const days = O.spanDays(rg.from, rg.to);
    const profit = t.counted_revenue - t.counted_commission - t.counted_delivery - t.counted_cogs;
    const sold = t.gross + t.extra;             // всё проданное, без вычета возвратов
    const feeBase = t.gross - t.returns;
    return Object.assign(t, {
      days,
      avgDay: days > 0 ? t.revenue / days : null,
      avgCheck: t.orders > 0 ? t.gross / t.orders : null,
      cancelPct: t.orders + t.cancels_n > 0 ? 100 * t.cancels_n / (t.orders + t.cancels_n) : null,
      returnPct: t.orders + t.returned_n > 0 ? 100 * t.returned_n / (t.orders + t.returned_n) : null,
      commissionRate: feeBase > 0 ? 100 * t.commission / feeBase : null,
      profit: t.counted_orders > 0 ? profit : null,
      margin: t.counted_orders > 0 && t.counted_revenue > 0 ? 100 * profit / t.counted_revenue : null,
      coverage: sold > 0 ? 100 * t.counted_revenue / sold : null,
      clients: clientsIn(idx, rg)
    });
  }

  // ── Бакеты графика и таблицы ──────────────────────────────────────────────
  // Та же сетка, что у «Обзора» (O.bucketOf), и пустые бакеты тоже: день без
  // продаж — ноль на оси. Поля total и by.kaspi нужны общему графику.
  function buildSeries(rows, rg, grouping, today) {
    const map = new Map();
    for (let d = rg.from, guard = 0; d <= rg.to && guard < 5000; d = O.addDays(d, 1), guard++) {
      const b = O.bucketOf(d, grouping);
      if (!map.has(b.key)) map.set(b.key, { key: b.key, label: b.label, revenue: 0, gross: 0, orders: 0, qty: 0, new_clients: 0 });
    }
    rows.forEach(r => {
      if (!inRange(r.day, rg)) return;
      const e = map.get(O.bucketOf(r.day, grouping).key);
      if (!e) return;
      e.revenue += num(r.revenue);
      e.gross += num(r.gross);
      e.orders += num(r.orders);
      e.qty += num(r.qty);
      e.new_clients += num(r.new_clients);
    });
    const cur = today ? O.bucketOf(today, grouping).key : null;
    return Array.from(map.values())
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(e => Object.assign(e, { total: e.revenue, by: { kaspi: e.revenue }, current: e.key === cur }));
  }

  // ── Разметка ──────────────────────────────────────────────────────────────
  // Изменение к прошлому периоду. Направление несут стрелка и знак, цвет —
  // только подсказка: для людей, которые цвета не различают, он ничего не
  // скажет. Сравнивать не с чем (нет периода или там ноль) — пусто.
  function change(cur, prev) {
    if (!isNum(cur) || !isNum(prev) || !(Math.abs(Number(prev)) > 0)) return null;
    return 100 * (Number(cur) - Number(prev)) / Math.abs(Number(prev));
  }
  function deltaHtml(d) {
    if (d === null) return '';
    const up = d >= 0;
    return '<div class="kpi-delta ' + (up ? 'up' : 'down') + '"><span aria-hidden="true">' + (up ? '▲' : '▼') +
      '</span> ' + (up ? '+' : '−') + nf1.format(Math.abs(d)) + NBSP + '%</div>';
  }

  function card(label, value, sub, d, tone) {
    return '<div class="kpi' + (tone ? ' kpi-' + tone : '') + '">' +
      '<div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-value">' + value + '</div>' +
      deltaHtml(d === undefined ? null : d) +
      (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') +
    '</div>';
  }

  function renderKpis(k, pk, now) {
    const p = pk || null;
    const cl = k.clients, pcl = p ? p.clients : null;
    const shareRepeat = isNum(cl.active) && cl.active > 0 ? 100 * cl.repeat / cl.active : null;
    const rate = isNum(k.commissionRate) ? pct(k.commissionRate) + ' с выданного' : 'с выданного';
    const nowCard = now
      ? card('В работе', int(now.in_work_orders) + NBSP + 'зак.',
             money(now.in_work_amount) + ' · сейчас, не за период' +
             (num(now.in_work_stale) > 0 ? '<br>дольше 14 дней: ' + int(now.in_work_stale) + ' на ' + money(now.in_work_stale_amount) : ''),
             null, num(now.in_work_stale) > 0 ? 'warn' : '')
      : card('В работе', '—', 'нет данных');
    return '<div class="kpi-grid">' +
      card('В среднем за день', money(k.avgDay), 'за ' + int(k.days) + ' ' + plural(k.days, 'день', 'дня', 'дней'),
           change(k.avgDay, p && p.avgDay)) +
      card('Заказов', int(k.orders), int(k.qty) + ' ' + plural(k.qty, 'товар', 'товара', 'товаров'),
           change(k.orders, p && p.orders)) +
      card('Средний чек', money(k.avgCheck), 'выдано / заказов', change(k.avgCheck, p && p.avgCheck)) +
      card('Новые клиенты', int(cl.fresh), 'первый заказ в периоде', change(cl.fresh, pcl && pcl.fresh)) +
      card('Повторные клиенты', int(cl.repeat),
           isNum(shareRepeat) ? pct(shareRepeat) + ' покупателей периода' : 'покупали и раньше',
           change(cl.repeat, pcl && pcl.repeat)) +
      card('% отмен', pct(k.cancelPct), int(k.cancels_n) + NBSP + 'зак. · ' + money(k.cancels_amount)) +
      card('Возвраты', k.returned_n ? int(k.returned_n) + NBSP + 'зак.' : '—',
           k.returned_n ? money(k.returned_amount) + ' · ' + pct(k.returnPct) + ' · в выручку не входят' : 'нет возвратов') +
      nowCard +
      card('Комиссия Kaspi', money(k.commission), rate) +
      (k.nocogs_orders
        ? card('Себестоимость', money(k.counted_cogs),
               'известна не везде: ' + int(k.nocogs_orders) + NBSP + 'зак. на ' + money(k.nocogs_revenue) + ' без неё', null, 'warn')
        : card('Себестоимость', money(k.counted_cogs), 'с довесками')) +
    '</div>';
  }

  // Из чего сложена выручка — под крупной суммой: то же определение, что у
  // строки Kaspi на «Обзоре», только по частям. Пустые части не показываются.
  function renderRevenueParts(k) {
    const rows = [line('выдано · ' + int(k.orders) + NBSP + plural(k.orders, 'заказ', 'заказа', 'заказов'), money(k.gross))];
    if (k.extra) rows.push(line('удалённые оплаты · ' + int(k.remote_n) + NBSP + 'шт.', '+' + money(k.extra)));
    if (k.returns) rows.push(line('возвраты выданных', minus(k.returns)));
    return '<table class="pnl hero-parts"><caption class="sr-only">Из чего сложена выручка</caption><tbody>' +
      rows.join('') + '</tbody></table>';
  }

  // Прибыль до расходов — лестницей, и лестница обязана сходиться: каждая
  // строка — то, из чего число внизу посчитано. Всё, что в расчёт не вошло,
  // названо над ним строкой со своей суммой, а не спрятано в проценте.
  function line(label, value, cls, sub) {
    return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><th scope="row">' + label +
      (sub ? '<div class="pnl-sub">' + sub + '</div>' : '') + '</th><td class="num">' + value + '</td></tr>';
  }
  function minus(v) { return '−' + money(v); }

  function renderProfit(k, pk, prg) {
    if (!(k.gross > 0) && !(k.extra > 0) && !k.counted_orders) return C.empty('За период продаж нет.');
    const out = [];
    out.push(line('Выручка Kaspi', money(k.revenue), 'strong'));
    if (k.extra) out.push(line('удалённые оплаты', minus(k.extra), 'off', 'себестоимость проданного по ним неизвестна'));
    if (k.nocogs_orders) out.push(line('заказы без себестоимости: ' + int(k.nocogs_orders), minus(k.nocogs_revenue), 'off',
                                       'в прибыль не входят — неизвестное не считается нулём'));
    if (k.returns) out.push(line('возвраты', '+' + money(k.returns), 'off', 'прибыль считается по выданному'));
    const partial = k.extra || k.nocogs_orders || k.returns;
    if (partial) out.push(line('В расчёте прибыли', money(k.counted_revenue), 'strong',
                               isNum(k.coverage) ? pct(k.coverage) + ' проданного' : ''));
    out.push(line('комиссия Kaspi', minus(k.counted_commission)));
    out.push(line('доставка, платит продавец', minus(k.counted_delivery)));
    out.push(line('себестоимость с довесками', minus(k.counted_cogs)));
    out.push(line('Прибыль до расходов', money(k.profit), 'total',
                  isNum(k.margin) ? 'маржа ' + pct(k.margin) + (partial ? ' от посчитанного' : ' от выручки') : ''));
    // Сравнение — как под крупной выручкой: стрелка, знак, прошлое значение.
    let cmp = '';
    if (prg && pk) {
      const d = change(k.profit, pk.profit);
      cmp = d === null
        ? '<div class="hero-delta pnl-delta muted">За ' + esc(O.rangeLabel(prg)) + ' сравнить не с чем.</div>'
        : '<div class="hero-delta pnl-delta ' + (d >= 0 ? 'up' : 'down') + '"><span aria-hidden="true">' +
          (d >= 0 ? '▲' : '▼') + '</span> ' + (d >= 0 ? '+' : '−') + nf1.format(Math.abs(d)) + NBSP + '% к ' +
          esc(O.rangeLabel(prg)) + ' <span class="muted">· было ' + money(pk.profit) + '</span></div>';
    }
    const buyer = k.delivery_buyer > 0
      ? '<p class="note">Покупатели доплатили за доставку ' + money(k.delivery_buyer) +
        '. Старая вкладка вычитала это из расходов на доставку, здесь — нет, как и в прибыли клиентов.</p>'
      : '';
    return '<table class="pnl"><caption class="sr-only">Прибыль до расходов</caption><tbody>' + out.join('') +
      '</tbody></table>' + cmp + buyer;
  }

  function tooltipHtml(e) {
    return '<div class="tip-head">' + esc(e.label) + (e.current ? ' · идёт' : '') + '</div>' +
      '<div class="tip-total"><b>' + money(e.revenue) + '</b> <span class="muted">выручка</span></div>' +
      '<div class="tip-row"><b>' + int(e.orders) + '</b> <span class="muted">' + plural(e.orders, 'заказ', 'заказа', 'заказов') +
        ' · ' + int(e.qty) + ' ' + plural(e.qty, 'товар', 'товара', 'товаров') + '</span></div>' +
      (e.orders ? '<div class="tip-row"><b>' + money(e.gross / e.orders) + '</b> <span class="muted">средний чек</span></div>' : '') +
      (e.new_clients ? '<div class="tip-row"><b>' + int(e.new_clients) + '</b> <span class="muted">' +
        plural(e.new_clients, 'новый клиент', 'новых клиента', 'новых клиентов') + '</span></div>' : '');
  }

  // Таблица периодов — двойник графика: итог внизу обязан совпасть с
  // крупной выручкой сверху. Средний чек — выдано / заказов, как в карточке.
  function renderTable(series) {
    if (!series.length) return C.empty('За период нет данных.');
    const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
    const body = series.map((e, i) => {
      const p = i > 0 ? series[i - 1].revenue : null;
      const d = p === null ? null : e.revenue - p;
      const dp = p === null || !p ? null : 100 * d / Math.abs(p);
      const cls = v => (v === null ? 'muted' : v >= 0 ? 'good' : 'bad');
      return '<tr><th scope="row">' + esc(e.label) + (e.current ? ' <span class="live-tag">· идёт</span>' : '') + '</th>' +
        '<td class="num strong">' + money(e.revenue) + '</td>' +
        '<td class="num ' + cls(d) + '">' + (d === null ? '—' : (d > 0 ? '+' : d < 0 ? '−' : '') + money(Math.abs(d))) + '</td>' +
        '<td class="num ' + cls(dp) + '">' + (dp === null ? '—' : (dp >= 0 ? '+' : '−') + nf.format(Math.abs(dp)) + NBSP + '%') + '</td>' +
        '<td class="num">' + int(e.orders) + '</td>' +
        '<td class="num">' + int(e.qty) + '</td>' +
        '<td class="num">' + (e.orders ? money(e.gross / e.orders) : '—') + '</td>' +
        '<td class="num">' + int(e.new_clients) + '</td></tr>';
    }).reverse().join('');
    const sum = f => series.reduce((a, e) => a + e[f], 0);
    const g = sum('gross'), o = sum('orders');
    const foot = '<tr><th scope="row">Итого</th><td class="num strong">' + money(sum('revenue')) + '</td><td></td><td></td>' +
      '<td class="num">' + int(o) + '</td><td class="num">' + int(sum('qty')) + '</td>' +
      '<td class="num">' + (o ? money(g / o) : '—') + '</td><td class="num">' + int(sum('new_clients')) + '</td></tr>';
    return '<div class="table-scroll tall"><table class="grid sticky-first"><thead><tr>' +
      ['Период', 'Выручка', 'Δ к пред.', 'Δ, %', 'Заказов', 'Товаров', 'Ср. чек', 'Новых клиентов']
        .map(h => '<th scope="col">' + esc(h) + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>';
  }

  // Удалённые оплаты периода — те же строки, что сложились в выручку
  // (in_revenue), поэтому итог списка равен сумме «удалённых оплат» в
  // лестнице прибыли. Строки, которые в выручку не вошли, — предупреждением
  // за всё время: их дату и сумму надо исправить в листе.
  function remoteInRange(rows, rg) {
    return rows.filter(r => r.in_revenue === true && inRange(r.day, rg))
      .sort((a, b) => String(b.day).localeCompare(String(a.day)) || String(b.id || '').localeCompare(String(a.id || '')));
  }

  function renderRemote(rows, rg) {
    const list = remoteInRange(rows, rg);
    const bad = rows.filter(r => r.in_revenue !== true);
    const warn = bad.length
      ? '<p class="note warn-text">Не вошли в выручку — нет даты или сумма не число: ' +
        bad.map(r => esc(r.id || 'без ID') + (r.client ? ' (' + esc(r.client) + ')' : '')).join(', ') +
        '. Исправляется в листе «Удаленные_оплаты».</p>'
      : '';
    if (!list.length) return C.empty('За период удалённых оплат нет.') + warn;
    const body = list.map(r =>
      '<tr><th scope="row">' + C.date(r.day) + '</th>' +
        '<td class="wrap">' + esc(r.client || '—') + '</td>' +
        '<td class="wrap">' + esc(r.product || '') + '</td>' +
        '<td class="num">' + money(r.amount) + '</td>' +
        '<td class="wrap">' + esc(r.comment || '') + '</td>' +
        '<td>' + esc(r.added_by || '') + '</td></tr>').join('');
    const total = list.reduce((a, r) => a + num(r.amount), 0);
    return '<div class="table-scroll"><table class="grid sticky-first"><thead><tr>' +
      ['Дата', 'Клиент', 'Товар', 'Сумма', 'Комментарий', 'Кто внёс'].map(h => '<th scope="col">' + h + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody><tfoot><tr><th scope="row">Итого · ' + int(list.length) + NBSP + 'шт.</th>' +
      '<td></td><td></td><td class="num strong">' + money(total) + '</td><td></td><td></td></tr></tfoot></table></div>' + warn;
  }

  function renderNotes() {
    return '<ul class="notes">' +
      '<li><b>Выручка</b> — ровно строка Kaspi на «Обзоре»: выдано по дню выдачи, минус возвраты выданных, плюс удалённые оплаты по дню оплаты (без комиссии).</li>' +
      '<li><b>Возвращённый заказ</b> выпадает из выданных целиком: его дня выдачи в выручке больше нет. Поэтому «Возвраты» — справка, а не второй вычет.</li>' +
      '<li><b>Прибыль до расходов</b> — выручка минус комиссия, доставка и себестоимость с довесками, только по заказам с известной себестоимостью. Неизвестное не считается нулём: такие заказы и удалённые оплаты названы в расчёте отдельной строкой. Реклама, зарплаты и прочие расходы из «Вводных» сюда не входят — их в базе пока нет.</li>' +
      '<li><b>Доставка</b> — сколько платит продавец. Старая вкладка вычитала из неё то, что доплатил покупатель.</li>' +
      '<li><b>Новые</b> — первый выданный заказ Kaspi пришёлся на период; <b>повторные</b> — покупали в периоде, но впервые раньше. Клиент тот же, что на экране «Клиенты».</li>' +
      '<li><b>В работе</b> — заказы, которые сейчас не выданы и не отменены, на момент последнего опроса Kaspi. От периода не зависит.</li>' +
      '<li>Пока нет: «Поступило с 17:00» и «В доставке» (живые запросы к Kaspi), фильтра по городу (город в приёме не хранится отдельно), «Чистой прибыли». Удалённую оплату пока вносят в старом дашборде — сюда она приезжает с синхронизацией таблицы.</li>' +
    '</ul>';
  }

  root.NietteKaspi = {
    SUM_COLS, sumRange, clientIndex, clientsIn, metrics, buildSeries, change,
    renderKpis, renderRevenueParts, renderProfit, tooltipHtml, renderTable, remoteInRange, renderRemote, renderNotes
  };
})(typeof window !== 'undefined' ? window : globalThis);
