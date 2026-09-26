/* Экран «Аналитика» на снимках Postgres: спрос Kaspi по дню заказа.
 *
 * Как kaspi.js и ozon.js — только чистые функции: строки снимков на вход,
 * числа и строка HTML на выход. Сеть, состояние и события — в app.js.
 * Проверяется в Node (tests/app_analytics_test.js).
 *
 * Источники (sql/21_analytics.sql), страница читает их снимки:
 *   snap_an_demand    строка на день заказа: поступило и что с этими заказами
 *                     сейчас — выдано, в работе, отменено, возвращено
 *   snap_an_sku       то же по товарам, в штуках
 *   snap_an_city      то же по городам доставки
 *   snap_an_delivery  то же по способам доставки, с доставкой продавца
 *
 * ОДНА ОСЬ — ДЕНЬ ЗАКАЗА. Любая сумма здесь — про заказы, сделанные в
 * выбранные дни. Деньги по дню выдачи — экран Kaspi.
 *
 * Тождество дня и периода: поступило = выдано + в работе + отменено +
 * возвращено. Итоги таблиц обязаны совпасть с карточками сверху.
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
  function share(part, whole) { return whole > 0 ? 100 * part / whole : null; }

  // Исходы заказа — в порядке стопки столбца снизу вверх. Цвета — в
  // style.css (--oc-*): выдано зелёным, в работе серым, возврат и отмена —
  // янтарный и красный; зелёный и красный не соседи.
  const OUTCOMES = [
    { key: 'delivered', label: 'Выдано' },
    { key: 'work',      label: 'В работе' },
    { key: 'returned',  label: 'Возвращено' },
    { key: 'cancelled', label: 'Отменено' }
  ];

  const SUM_COLS = ['placed_orders', 'placed_amount', 'placed_qty', 'delivered_orders', 'delivered_amount',
    'work_orders', 'work_amount', 'cancelled_orders', 'cancelled_amount', 'returned_orders', 'returned_amount'];

  function sumRange(rows, rg) {
    const t = { days_with_data: 0 };
    SUM_COLS.forEach(c => { t[c] = 0; });
    rows.forEach(r => {
      if (!inRange(r.day, rg)) return;
      t.days_with_data++;
      SUM_COLS.forEach(c => { t[c] += num(r[c]); });
    });
    return t;
  }

  // Выкуп — среди ЗАВЕРШЁННЫХ (выдано + отменено + возвращено): заказ, ещё
  // едущий к покупателю, не провал и не успех. Нет завершённых — прочерк.
  function metrics(rows, rg) {
    if (!rg) return null;
    const t = sumRange(rows, rg);
    const days = O.spanDays(rg.from, rg.to);
    const resolved = t.delivered_orders + t.cancelled_orders + t.returned_orders;
    return Object.assign(t, {
      days, resolved,
      perDay: days > 0 ? t.placed_orders / days : null,
      avgCheck: t.placed_orders > 0 ? t.placed_amount / t.placed_orders : null,
      buyout: share(t.delivered_orders, resolved),
      cancelShare: share(t.cancelled_orders, resolved),
      returnShare: share(t.returned_orders, resolved)
    });
  }

  // ── Бакеты графика и таблицы — та же сетка, что у «Обзора» ───────────────
  function buildSeries(rows, rg, grouping, today) {
    const map = new Map();
    for (let d = rg.from, guard = 0; d <= rg.to && guard < 5000; d = O.addDays(d, 1), guard++) {
      const b = O.bucketOf(d, grouping);
      if (!map.has(b.key)) {
        const e = { key: b.key, label: b.label };
        SUM_COLS.forEach(c => { e[c] = 0; });
        map.set(b.key, e);
      }
    }
    rows.forEach(r => {
      if (!inRange(r.day, rg)) return;
      const e = map.get(O.bucketOf(r.day, grouping).key);
      if (e) SUM_COLS.forEach(c => { e[c] += num(r[c]); });
    });
    const cur = today ? O.bucketOf(today, grouping).key : null;
    return Array.from(map.values())
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(e => {
        const resolved = e.delivered_orders + e.cancelled_orders + e.returned_orders;
        return Object.assign(e, {
          total: e.placed_orders, current: e.key === cur, resolved,
          buyout: share(e.delivered_orders, resolved),
          by: { delivered: e.delivered_orders, work: e.work_orders, returned: e.returned_orders, cancelled: e.cancelled_orders }
        });
      });
  }

  // ── Дни недели ────────────────────────────────────────────────────────────
  // Среднее на КАЛЕНДАРНЫЙ день: понедельник без заказов — это ноль в
  // среднем, а не выпавший понедельник. Меньше недели — сравнивать нечего.
  const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const DOW_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  function dowOf(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return (d.getUTCDay() + 6) % 7;
  }
  function weekdays(rows, rg) {
    const out = DOW.map((label, i) => ({ i, label, full: DOW_FULL[i], days: 0, orders: 0, amount: 0 }));
    for (let d = rg.from, guard = 0; d <= rg.to && guard < 5000; d = O.addDays(d, 1), guard++) out[dowOf(d)].days++;
    rows.forEach(r => {
      if (!inRange(r.day, rg)) return;
      const e = out[dowOf(r.day)];
      e.orders += num(r.placed_orders);
      e.amount += num(r.placed_amount);
    });
    const total = out.reduce((a, e) => a + e.orders, 0);
    out.forEach(e => {
      e.avgOrders = e.days > 0 ? e.orders / e.days : null;
      e.avgAmount = e.days > 0 ? e.amount / e.days : null;
      e.share = share(e.orders, total);
    });
    return out;
  }

  // ── Разрезы за период ────────────────────────────────────────────────────
  function group(rows, rg, keyOf, cols, init) {
    const by = new Map();
    rows.forEach(r => {
      if (!inRange(r.day, rg)) return;
      const k = keyOf(r);
      let e = by.get(k);
      if (!e) { e = init(k, r); cols.forEach(c => { e[c] = 0; }); by.set(k, e); }
      cols.forEach(c => { e[c] += num(r[c]); });
      if (!e.name && r.name) e.name = r.name;
    });
    return Array.from(by.values());
  }

  const SKU_COLS = ['placed_orders', 'placed_qty', 'placed_amount', 'delivered_qty', 'delivered_amount',
                    'work_qty', 'cancelled_qty', 'returned_qty'];
  function skuTotals(rows, rg) {
    return group(rows, rg, r => r.sku, SKU_COLS, k => ({ sku: k, name: '' }))
      .map(e => Object.assign(e, { buyout: share(e.delivered_qty, e.delivered_qty + e.cancelled_qty + e.returned_qty) }))
      .sort((a, b) => b.placed_amount - a.placed_amount || String(a.sku).localeCompare(String(b.sku)));
  }

  const CITY_COLS = ['placed_orders', 'placed_amount', 'delivered_orders', 'delivered_amount',
                     'work_orders', 'cancelled_orders', 'returned_orders'];
  function withBuyout(e) {
    return Object.assign(e, { buyout: share(e.delivered_orders, e.delivered_orders + e.cancelled_orders + e.returned_orders) });
  }
  // Город NULL — «не известен»: он в итоге, но не в рейтинге.
  function cityTotals(rows, rg) {
    return group(rows, rg, r => (r.city === null || r.city === undefined || r.city === '' ? '' : r.city), CITY_COLS,
                 k => ({ city: k }))
      .map(withBuyout)
      .sort((a, b) => b.placed_orders - a.placed_orders || b.delivered_amount - a.delivered_amount ||
                      String(a.city).localeCompare(String(b.city)));
  }

  // Код Kaspi → слова. Незнакомый код показывается как есть: лучше сырое
  // слово, чем выдуманная подпись.
  const METHODS = {
    DELIVERY_LOCAL: 'Доставка по городу',
    DELIVERY_PICKUP: 'Самовывоз, постамат',
    DELIVERY_REGIONAL_TODOOR: 'Доставка в другой город',
    DELIVERY_REGIONAL_PICKUP: 'Постамат в другом городе'
  };
  function methodLabel(code) {
    const c = String(code || '');
    return METHODS[c.toUpperCase()] || (c && c !== '—' ? c : 'не указан');
  }
  const DELIV_COLS = CITY_COLS.concat(['delivered_cost_known', 'delivery_seller']);
  function deliveryTotals(rows, rg) {
    return group(rows, rg, r => r.method || '—', DELIV_COLS, k => ({ method: k }))
      .map(e => Object.assign(withBuyout(e), {
        label: methodLabel(e.method),
        // средняя — по заказам с известной доставкой: неизвестная не ноль
        costPerOrder: e.delivered_cost_known > 0 ? e.delivery_seller / e.delivered_cost_known : null
      }))
      .sort((a, b) => b.placed_orders - a.placed_orders || String(a.method).localeCompare(String(b.method)));
  }

  // ── Разметка ──────────────────────────────────────────────────────────────
  function change(cur, prev) {
    if (!isNum(cur) || !isNum(prev) || !(Math.abs(Number(prev)) > 0)) return null;
    return 100 * (Number(cur) - Number(prev)) / Math.abs(Number(prev));
  }
  function arrow(d, good, text) {
    return '<div class="kpi-delta ' + (good ? 'up' : 'down') + '"><span aria-hidden="true">' + (d >= 0 ? '▲' : '▼') +
      '</span> ' + text + '</div>';
  }
  // Относительное изменение — для количеств и сумм.
  function deltaHtml(d, invert) {
    if (d === null || d === undefined) return '';
    if (Math.abs(d) < 0.05) return '<div class="kpi-delta flat">без изменений</div>';
    return arrow(d, invert ? d <= 0 : d >= 0, (d >= 0 ? '+' : '−') + nf1.format(Math.abs(d)) + NBSP + '%');
  }
  // Доли — в процентных пунктах: «выкуп 88 → 90 %» — это +2 п.п., а не
  // «+2,3 %», которые читатель принял бы за проценты от процента.
  function ppHtml(cur, prev, invert) {
    if (!isNum(cur) || !isNum(prev)) return '';
    const d = Number(cur) - Number(prev);
    if (Math.abs(d) < 0.05) return '<div class="kpi-delta flat">без изменений</div>';
    return arrow(d, invert ? d <= 0 : d >= 0, (d >= 0 ? '+' : '−') + nf1.format(Math.abs(d)) + NBSP + 'п.п.');
  }
  function card(label, value, sub, delta, tone) {
    return '<div class="kpi' + (tone ? ' kpi-' + tone : '') + '">' +
      '<div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-value">' + value + '</div>' + (delta || '') +
      (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div>';
  }

  function renderKpis(k, pk) {
    const p = pk || null;
    return '<div class="kpi-grid">' +
      card('Поступило заказов', int(k.placed_orders),
           (isNum(k.perDay) ? nf1.format(k.perDay) + ' в день · ' : '') + int(k.placed_qty) + NBSP + 'шт.',
           deltaHtml(change(k.placed_orders, p && p.placed_orders))) +
      card('Сумма заказов', money(k.placed_amount), 'средний чек ' + money(k.avgCheck),
           deltaHtml(change(k.placed_amount, p && p.placed_amount))) +
      card('Выкуп', isNum(k.buyout) ? pct(k.buyout) : '—',
           k.resolved ? 'выдано ' + int(k.delivered_orders) + ' из ' + int(k.resolved) + ' завершённых' : 'завершённых заказов нет',
           ppHtml(k.buyout, p && p.buyout)) +
      card('Отмены', isNum(k.cancelShare) ? pct(k.cancelShare) : '—',
           int(k.cancelled_orders) + ' ' + plural(k.cancelled_orders, 'заказ', 'заказа', 'заказов') + ' на ' + money(k.cancelled_amount) +
           (k.returned_orders ? '<br>возвращено после выдачи: ' + int(k.returned_orders) : ''),
           ppHtml(k.cancelShare, p && p.cancelShare, true)) +
      card('В работе', int(k.work_orders), k.work_orders ? money(k.work_amount) + ' · ещё не завершены' : 'все заказы завершены') +
    '</div>';
  }

  function swatch(key) { return '<span class="sw sq ch-' + esc(key) + '" aria-hidden="true"></span>'; }

  // Подписи цветов — просто подписи: скрывать исходы на графике незачем,
  // стопка без одного из них перестала бы означать «все поступившие».
  function renderLegend() {
    return '<div class="legend static" aria-hidden="true">' +
      OUTCOMES.map(o => '<span class="chip">' + swatch(o.key) + esc(o.label) + '</span>').join('') + '</div>';
  }

  function tooltipHtml(e) {
    const rows = OUTCOMES.filter(o => e.by[o.key]).map(o =>
      '<div class="tip-row">' + '<span class="sw line ch-' + o.key + '" aria-hidden="true"></span><b>' + int(e.by[o.key]) +
      '</b> <span class="muted">' + o.label.toLowerCase() + '</span></div>').join('');
    return '<div class="tip-head">' + esc(e.label) + (e.current ? ' · идёт' : '') + '</div>' +
      '<div class="tip-total"><b>' + int(e.placed_orders) + '</b> <span class="muted">' +
        plural(e.placed_orders, 'заказ', 'заказа', 'заказов') + ' на ' + money(e.placed_amount) + '</span></div>' +
      (rows || '<div class="muted">заказов нет</div>') +
      (isNum(e.buyout) ? '<div class="tip-row"><b>' + pct(e.buyout) + '</b> <span class="muted">выкуп</span></div>' : '');
  }

  function renderTable(series) {
    if (!series.length) return C.empty('За период нет данных.');
    const cell = (v, cls) => '<td class="num' + (cls ? ' ' + cls : '') + (v ? '' : ' muted') + '">' + (v ? int(v) : '—') + '</td>';
    const body = series.map(e =>
      '<tr' + (e.current ? ' class="live-row"' : '') + '><th scope="row">' + esc(e.label) +
        (e.current ? ' <span class="live-tag">· идёт</span>' : '') + '</th>' +
        '<td class="num strong">' + int(e.placed_orders) + '</td>' +
        '<td class="num">' + money(e.placed_amount) + '</td>' +
        cell(e.delivered_orders) +
        '<td class="num">' + (isNum(e.buyout) ? pct(e.buyout) : '—') + '</td>' +
        cell(e.cancelled_orders) + cell(e.returned_orders) + cell(e.work_orders) + '</tr>').reverse().join('');
    const sum = f => series.reduce((a, e) => a + e[f], 0);
    const resolved = sum('delivered_orders') + sum('cancelled_orders') + sum('returned_orders');
    const foot = '<tr><th scope="row">Итого</th><td class="num strong">' + int(sum('placed_orders')) + '</td>' +
      '<td class="num">' + money(sum('placed_amount')) + '</td><td class="num">' + int(sum('delivered_orders')) + '</td>' +
      '<td class="num">' + (resolved ? pct(100 * sum('delivered_orders') / resolved) : '—') + '</td>' +
      '<td class="num">' + int(sum('cancelled_orders')) + '</td><td class="num">' + int(sum('returned_orders')) + '</td>' +
      '<td class="num">' + int(sum('work_orders')) + '</td></tr>';
    return '<div class="table-scroll tall"><table class="grid sticky-first"><thead><tr>' +
      ['Период', 'Поступило', 'Сумма', 'Выдано', 'Выкуп', 'Отменено', 'Возвращено', 'В работе']
        .map(h => '<th scope="col">' + h + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>';
  }

  function renderWeekdays(list, rg) {
    const span = O.spanDays(rg.from, rg.to);
    if (span < 7) return C.empty('Выберите период от 7 дней: за ' + span + ' ' + plural(span, 'день', 'дня', 'дней') +
                                 ' дни недели не с чем сравнить.');
    const total = list.reduce((a, e) => a + e.orders, 0);
    if (!total) return C.empty('За период заказов нет.');
    const max = Math.max(...list.map(e => e.avgOrders || 0));
    let peak = 0;
    list.forEach((e, i) => { if ((e.avgOrders || 0) > (list[peak].avgOrders || 0)) peak = i; });
    const mean = total / span;
    const bars = list.map((e, i) =>
      '<div class="bar-row' + (i === peak ? ' peak' : '') + '">' +
        '<div class="bar-label">' + esc(e.label) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + (max > 0 ? 100 * (e.avgOrders || 0) / max : 0).toFixed(1) + '%"></div></div>' +
        '<div class="bar-value">' + (isNum(e.avgOrders) ? nf1.format(e.avgOrders) : '—') + ' в день · ' + money(e.avgAmount) + '</div>' +
      '</div>').join('');
    const p = list[peak];
    const above = share(p.avgOrders - mean, mean);
    return '<div class="bars">' + bars + '</div>' +
      '<p class="note">Больше всего заказов — ' + esc(p.full) + ': ' + nf1.format(p.avgOrders) + ' в день' +
      (isNum(above) && above >= 0.5 ? ', на ' + Math.round(above) + NBSP + '% выше среднего по периоду' : '') +
      '. Среднее — на календарный день: день без заказов считается нулём, а не пропускается.</p>';
  }

  function renderSkus(list) {
    if (!list.length) return C.empty('За период заказов нет.');
    const q = v => (v ? int(v) : '—');
    const body = list.map(e =>
      '<tr><th scope="row"><div class="who">' + esc(e.name || e.sku) + '</div><div class="where">' + esc(e.sku) + '</div></th>' +
        '<td class="num strong">' + int(e.placed_qty) + '</td>' +
        '<td class="num">' + money(e.placed_amount) + '</td>' +
        '<td class="num">' + q(e.delivered_qty) + '</td>' +
        '<td class="num">' + (isNum(e.buyout) ? pct(e.buyout) : '—') + '</td>' +
        '<td class="num' + (e.cancelled_qty ? '' : ' muted') + '">' + q(e.cancelled_qty) + '</td>' +
        '<td class="num' + (e.work_qty ? '' : ' muted') + '">' + q(e.work_qty) + '</td></tr>').join('');
    const tot = f => list.reduce((a, e) => a + e[f], 0);
    const res = tot('delivered_qty') + tot('cancelled_qty') + tot('returned_qty');
    const foot = '<tr><th scope="row">Итого</th><td class="num strong">' + int(tot('placed_qty')) + '</td>' +
      '<td class="num">' + money(tot('placed_amount')) + '</td><td class="num">' + int(tot('delivered_qty')) + '</td>' +
      '<td class="num">' + (res ? pct(100 * tot('delivered_qty') / res) : '—') + '</td>' +
      '<td class="num">' + int(tot('cancelled_qty')) + '</td><td class="num">' + int(tot('work_qty')) + '</td></tr>';
    return '<div class="table-scroll"><table class="grid sticky-first"><thead><tr>' +
      ['Товар', 'Заказано, шт.', 'Сумма заказов', 'Выдано, шт.', 'Выкуп', 'Отменено, шт.', 'В работе, шт.']
        .map(h => '<th scope="col">' + h + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>' +
      '<p class="note">Выкуп товара — в штуках: выдано / (выдано + отменено + возвращено).</p>';
  }

  // Рейтинг городов: первые limit, остальные одной строкой, «не известен»
  // отдельно. Итог — все заказы периода: он обязан совпасть с карточкой.
  function renderCities(list, limit) {
    const total = list.reduce((a, e) => a + e.placed_orders, 0);
    if (!total) return C.empty('За период заказов нет.');
    const known = list.filter(e => e.city !== '');
    const unknown = list.find(e => e.city === '');
    const top = known.slice(0, limit || 15);
    const rest = known.slice(limit || 15);
    const delivered = list.reduce((a, e) => a + e.delivered_amount, 0);
    const cells = (label, e) => '<th scope="row">' + label + '</th>' +
      '<td class="num strong">' + int(e.placed_orders) + '</td>' +
      '<td class="num">' + int(e.delivered_orders) + '</td>' +
      '<td class="num">' + (isNum(e.buyout) ? pct(e.buyout) : '—') + '</td>' +
      '<td class="num">' + money(e.delivered_amount) + '</td>' +
      '<td class="num muted">' + (delivered > 0 ? pct(100 * e.delivered_amount / delivered) : '—') + '</td>';
    const row = (label, e, cls) => '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + cells(label, e) + '</tr>';
    const merge = arr => withBuyout(arr.reduce((a, e) => { CITY_COLS.forEach(c => { a[c] += e[c]; }); return a; },
                                               CITY_COLS.reduce((a, c) => { a[c] = 0; return a; }, {})));
    let body = top.map(e => row(esc(e.city), e)).join('');
    if (rest.length) body += row('Остальные · ' + int(rest.length) + ' ' + plural(rest.length, 'город', 'города', 'городов'), merge(rest), 'rest');
    if (unknown) body += row('Город не известен', unknown, 'rest');
    const cover = share(total - (unknown ? unknown.placed_orders : 0), total);
    return '<div class="table-scroll"><table class="grid sticky-first"><thead><tr>' +
      ['Город', 'Поступило', 'Выдано', 'Выкуп', 'Сумма выданных', 'Доля'].map(h => '<th scope="col">' + h + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody><tfoot>' + row('Итого', merge(list)) + '</tfoot></table></div>' +
      '<p class="note">Город — из адреса доставки в заказе Kaspi, у самовывоза — город пункта выдачи. Известен у ' +
      pct(cover) + ' заказов периода.</p>';
  }

  function renderDelivery(list) {
    if (!list.length) return C.empty('За период заказов нет.');
    const body = list.map(e =>
      '<tr><th scope="row"><div class="who">' + esc(e.label) + '</div>' +
        (METHODS[String(e.method).toUpperCase()] ? '<div class="where">' + esc(e.method) + '</div>' : '') + '</th>' +
        '<td class="num strong">' + int(e.placed_orders) + '</td>' +
        '<td class="num">' + (isNum(e.buyout) ? pct(e.buyout) : '—') + '</td>' +
        '<td class="num' + (e.cancelled_orders ? '' : ' muted') + '">' + (e.cancelled_orders ? int(e.cancelled_orders) : '—') + '</td>' +
        '<td class="num">' + (isNum(e.costPerOrder) ? money(e.costPerOrder) : '—') +
          (e.delivered_orders > e.delivered_cost_known ? '<div class="where">известна у ' + int(e.delivered_cost_known) +
            ' из ' + int(e.delivered_orders) + '</div>' : '') + '</td></tr>').join('');
    return '<div class="table-scroll"><table class="grid sticky-first"><thead><tr>' +
      ['Способ', 'Поступило', 'Выкуп', 'Отменено', 'Доставка на выданный'].map(h => '<th scope="col">' + h + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="note">Доставка — сколько платит продавец, по выданным заказам, как в прибыли экрана Kaspi. Доплата покупателя — деньги Kaspi.</p>';
  }

  function renderNotes() {
    return '<ul class="notes">' +
      '<li><b>Весь экран — по дню заказа:</b> заказы, сделанные в выбранные дни, и что с ними сейчас. Деньги по дню выдачи — на экране Kaspi, поэтому «сумма заказов» здесь и выручка там за один период не совпадают, и не должны.</li>' +
      '<li><b>Свежие дни дозревают.</b> Вчерашний заказ ещё в работе и станет выданным через день-два; «в работе» у незакрытого периода — норма.</li>' +
      '<li><b>Выкуп</b> — выдано / (выдано + отменено + возвращено): доля среди завершённых. Старая вкладка делила на все поступившие, и незакрытый период выглядел провалом; в закрытом это одно и то же.</li>' +
      '<li><b>Отменено и возвращено</b> — по текущему статусу заказа в Kaspi. Возвращено — отказ после выдачи. Причин отмен в приёме по API нет: они приходили только с Excel-выгрузкой.</li>' +
      '<li><b>Город</b> — из адреса доставки: у доставки до двери — город адреса, у самовывоза — город пункта выдачи. Улицы с именами городов («улица Алматы» в Астане) городом не считаются.</li>' +
      '<li>Только Kaspi, как в старой вкладке. Часов заказа пока нет: в базе дни, а не время.</li>' +
    '</ul>';
  }

  root.NietteAnalytics = {
    OUTCOMES, SUM_COLS, METHODS, sumRange, metrics, buildSeries, weekdays, skuTotals, cityTotals, deliveryTotals,
    methodLabel, change, renderKpis, renderLegend, tooltipHtml, renderTable, renderWeekdays, renderSkus,
    renderCities, renderDelivery, renderNotes
  };
})(typeof window !== 'undefined' ? window : globalThis);
