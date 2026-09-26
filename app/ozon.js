/* Экран «Ozon» на снимках Postgres: расчёты и разметка.
 *
 * Как kaspi.js — только чистые функции: строки снимков на вход, числа и
 * строка HTML на выход. Сеть, состояние и события — в app.js. Проверяется в
 * Node (tests/app_ozon_test.js).
 *
 * Источники (sql/20_ozon_screen.sql), страница читает их снимки:
 *   snap_ozon_daily      строка на день начислений: выручка (ровно строка Ozon
 *                        «Обзора»), продажи, возвраты, всё, что удержал Ozon,
 *                        «пришло на счёт», себестоимость
 *   snap_ozon_sku_daily  то же по товарам
 *   snap_ozon_errors     штрафы «ошибка продавца» списком, с отправлением
 *   snap_ozon_now        в работе и ждут отгрузки сейчас (одна строка)
 *
 * Тождество периода — то же, что у месяца в sql/18_ozon_pnl.sql:
 *   продажи − возвраты − вознаграждение − доставка − ошибки продавца
 *     − прочие удержания = пришло;   прибыль = пришло − себестоимость.
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

  const SUM_COLS = ['revenue', 'sales', 'returns', 'orders', 'qty', 'returned_qty', 'commission',
    'delivery', 'seller_errors', 'seller_errors_n', 'other_costs', 'payout', 'cogs',
    'lines_no_cogs', 'revenue_no_cogs'];

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

  // Прибыль за период — только если себестоимость известна у ВСЕХ строк
  // периода (правило 18): иначе прочерк, а не прибыль по части товаров.
  function metrics(rows, rg) {
    if (!rg) return null;
    const t = sumRange(rows, rg);
    const days = O.spanDays(rg.from, rg.to);
    const known = t.days_with_data > 0 && t.lines_no_cogs === 0;
    const profit = known ? t.payout - t.cogs : null;
    return Object.assign(t, {
      days,
      avgDay: days > 0 ? t.revenue / days : null,
      avgCheck: t.orders > 0 ? t.sales / t.orders : null,
      payoutPct: share(t.payout, t.revenue),
      commissionPct: share(t.commission, t.sales),
      deliveryPerOrder: t.orders > 0 ? t.delivery / t.orders : null,
      errorsPct: share(t.seller_errors, t.revenue),
      otherPct: share(t.other_costs, t.revenue),
      returnPct: share(t.returned_qty, t.qty),
      profit,
      margin: isNum(profit) ? share(profit, t.revenue) : null
    });
  }

  // ── Бакеты графика и таблицы — та же сетка, что у «Обзора» ───────────────
  function buildSeries(rows, rg, grouping, today) {
    const map = new Map();
    for (let d = rg.from, guard = 0; d <= rg.to && guard < 5000; d = O.addDays(d, 1), guard++) {
      const b = O.bucketOf(d, grouping);
      if (!map.has(b.key)) map.set(b.key, { key: b.key, label: b.label, revenue: 0, payout: 0, cogs: 0, orders: 0,
                                            seller_errors: 0, seller_errors_n: 0, lines_no_cogs: 0, n: 0 });
    }
    rows.forEach(r => {
      if (!inRange(r.day, rg)) return;
      const e = map.get(O.bucketOf(r.day, grouping).key);
      if (!e) return;
      ['revenue', 'payout', 'cogs', 'orders', 'seller_errors', 'seller_errors_n', 'lines_no_cogs']
        .forEach(f => { e[f] += num(r[f]); });
      e.n++;
    });
    const cur = today ? O.bucketOf(today, grouping).key : null;
    return Array.from(map.values())
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(e => Object.assign(e, {
        total: e.revenue, by: { ozon: e.revenue }, current: e.key === cur,
        profit: e.n > 0 && e.lines_no_cogs === 0 ? e.payout - e.cogs : null
      }));
  }

  // ── Товары за период ──────────────────────────────────────────────────────
  // Валовая прибыль товара — до ошибок продавца и прочих удержаний: их Ozon
  // начисляет не по товару, и раскладывать их по товарам — выдумывать.
  function skuTotals(rows, rg) {
    const by = new Map();
    rows.forEach(r => {
      if (!inRange(r.day, rg)) return;
      let e = by.get(r.sku);
      if (!e) {
        e = { sku: r.sku, name: r.name || '', qty: 0, returned_qty: 0, sales: 0, returns: 0,
              commission: 0, delivery: 0, cogs: 0, lines_no_cogs: 0 };
        by.set(r.sku, e);
      }
      if (!e.name && r.name) e.name = r.name;
      ['qty', 'returned_qty', 'sales', 'returns', 'commission', 'delivery', 'cogs', 'lines_no_cogs']
        .forEach(f => { e[f] += num(r[f]); });
    });
    return Array.from(by.values()).map(e => {
      const rev = e.sales - e.returns;
      const gross = e.lines_no_cogs === 0 ? rev - e.commission - e.delivery - e.cogs : null;
      return Object.assign(e, { revenue: rev, gross, margin: isNum(gross) ? share(gross, rev) : null });
    }).sort((a, b) => b.sales - a.sales || String(a.sku).localeCompare(String(b.sku)));
  }

  function errorsInRange(rows, rg) {
    return rows.filter(r => inRange(r.day, rg))
      .sort((a, b) => String(b.day).localeCompare(String(a.day)) ||
                      String(b.posting_code || '').localeCompare(String(a.posting_code || '')));
  }

  // Статус отправления словами. Незнакомый — как есть: пусть лучше будет
  // видно сырое слово, чем выдуманное.
  const STATUS = {
    cancelled: 'отменено', cancelled_from_split: 'отменено при разделении', delivered: 'доставлено',
    delivering: 'доставляется', awaiting_deliver: 'ждёт отгрузки', awaiting_packaging: 'ждёт сборки',
    awaiting_approve: 'ждёт подтверждения', awaiting_registration: 'ждёт регистрации',
    acceptance_in_progress: 'на приёмке', not_accepted: 'не принято на складе',
    sent_by_seller: 'отправлено продавцом', driver_pickup: 'у водителя',
    arbitration: 'спор', client_arbitration: 'спор с покупателем'
  };
  function statusWord(api) { return api ? (STATUS[api] || api) : 'нет в журнале'; }

  // ── Разметка ──────────────────────────────────────────────────────────────
  function change(cur, prev) {
    if (!isNum(cur) || !isNum(prev) || !(Math.abs(Number(prev)) > 0)) return null;
    return 100 * (Number(cur) - Number(prev)) / Math.abs(Number(prev));
  }
  // Стрелка показывает направление, цвет — хорошо это или плохо: рост
  // штрафов — красный треугольник вверх.
  function deltaHtml(d, invert) {
    if (d === null || d === undefined) return '';
    // Без изменений — нейтрально: зелёная стрелка вверх у «+0,0 %» штрафов
    // читалась бы как «штрафов стало больше».
    if (Math.abs(d) < 0.05) return '<div class="kpi-delta flat">без изменений</div>';
    const good = invert ? d <= 0 : d >= 0;
    return '<div class="kpi-delta ' + (good ? 'up' : 'down') + '"><span aria-hidden="true">' + (d >= 0 ? '▲' : '▼') +
      '</span> ' + (d >= 0 ? '+' : '−') + nf1.format(Math.abs(d)) + NBSP + '%</div>';
  }
  function card(label, value, sub, d, tone, invert) {
    return '<div class="kpi' + (tone ? ' kpi-' + tone : '') + '">' +
      '<div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-value">' + value + '</div>' + deltaHtml(d, invert) +
      (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div>';
  }

  function renderKpis(k, pk, now) {
    const p = pk || null;
    const nowCard = now
      ? card('В работе', int(now.in_work) + NBSP + 'отпр.',
             money(now.in_work_amount) + ' · сейчас, не за период' +
             (num(now.to_ship) > 0 ? '<br>ждут отгрузки: ' + int(now.to_ship) +
               (now.to_ship_oldest ? ', самое старое от ' + C.date(now.to_ship_oldest) : '') : '') +
             (num(now.stale) > 0 ? '<br>застыли старше 60 дней: ' + int(now.stale) : ''),
             null, num(now.stale) > 0 ? 'warn' : '')
      : card('В работе', '—', 'нет данных');
    return '<div class="kpi-grid">' +
      card('В среднем за день', money(k.avgDay), 'за ' + int(k.days) + ' ' + plural(k.days, 'день', 'дня', 'дней'),
           change(k.avgDay, p && p.avgDay)) +
      card('Заказов', int(k.orders), int(k.qty) + ' ' + plural(k.qty, 'штука', 'штуки', 'штук'), change(k.orders, p && p.orders)) +
      card('Средний чек', money(k.avgCheck), 'продажи / заказов', change(k.avgCheck, p && p.avgCheck)) +
      card('Пришло на счёт', money(k.payout), isNum(k.payoutPct) ? pct(k.payoutPct) + ' выручки' : 'всё начисленное Ozon',
           change(k.payout, p && p.payout)) +
      (k.seller_errors_n
        ? card('Ошибки продавца', int(k.seller_errors_n) + NBSP + 'шт.',
               money(k.seller_errors) + (isNum(k.errorsPct) ? ' · ' + pct(k.errorsPct) + ' выручки' : ''),
               change(k.seller_errors, p && p.seller_errors), 'warn', true)
        : card('Ошибки продавца', '—', 'штрафов нет', change(k.seller_errors, p && p.seller_errors), '', true)) +
      card('Вознаграждение Ozon', pct(k.commissionPct), money(k.commission) + ' · от продаж') +
      card('Доставка на заказ', money(k.deliveryPerOrder), money(k.delivery) + ' за период') +
      card('Прочие удержания', money(k.other_costs), (isNum(k.otherPct) ? pct(k.otherPct) + ' выручки · ' : '') +
           'реклама, услуги FBO, логистика невыкупов') +
      card('Возвраты', k.returned_qty ? int(k.returned_qty) + NBSP + 'шт.' : '—',
           k.returned_qty ? money(k.returns) + (isNum(k.returnPct) ? ' · ' + pct(k.returnPct) + ' проданных штук' : '') : 'возвратов нет') +
      nowCard +
    '</div>';
  }

  // Что Ozon продал и что из этого пришло на счёт — лестницей. Она обязана
  // сходиться: «пришло» внизу — сумма всех начислений Ozon за период.
  function line(label, value, cls, sub) {
    return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><th scope="row">' + label +
      (sub ? '<div class="pnl-sub">' + sub + '</div>' : '') + '</th><td class="num">' + value + '</td></tr>';
  }
  function signed(v, cost) {           // расход — со знаком минус, отрицательный расход — плюсом
    const x = cost ? -v : v;
    return (x < 0 ? '−' : x > 0 && cost ? '+' : '') + money(Math.abs(x));
  }

  function renderMoney(k, pk, prg) {
    if (!k.days_with_data) return C.empty('За период начислений Ozon нет.');
    const out = [];
    out.push(line('Продажи', money(k.sales), 'strong', int(k.orders) + ' ' + plural(k.orders, 'заказ', 'заказа', 'заказов')));
    if (k.returns) out.push(line('возвраты', signed(k.returns, true)));
    out.push(line('вознаграждение Ozon', signed(k.commission, true), '', isNum(k.commissionPct) ? pct(k.commissionPct) + ' продаж' : ''));
    out.push(line('услуги доставки', signed(k.delivery, true)));
    out.push(line('ошибки продавца' + (k.seller_errors_n ? ' · ' + int(k.seller_errors_n) + NBSP + 'шт.' : ''),
                  signed(k.seller_errors, true), k.seller_errors > 0 ? 'bad' : '',
                  k.seller_errors > 0 ? 'штрафы Ozon: отмена, просрочка, не тот слот отгрузки' : ''));
    out.push(line('прочие удержания', signed(k.other_costs, true), '', 'реклама, услуги FBO, логистика невыкупов'));
    out.push(line('Пришло на счёт', money(k.payout), 'strong', isNum(k.payoutPct) ? pct(k.payoutPct) + ' выручки' : ''));
    if (k.lines_no_cogs) {
      out.push(line('себестоимость', '—', 'off', 'неизвестна у ' + int(k.lines_no_cogs) + ' ' +
                    plural(k.lines_no_cogs, 'строки', 'строк', 'строк') + ' на ' + money(k.revenue_no_cogs) + ' — прибыль не считается'));
    } else {
      out.push(line('себестоимость', signed(k.cogs, true), '', 'проданное минус возвращённое, с довесками'));
    }
    out.push(line('Прибыль', money(k.profit), 'total', isNum(k.margin) ? 'маржа ' + pct(k.margin) + ' выручки' : ''));
    let cmp = '';
    if (prg && pk) {
      const d = change(k.profit, pk.profit);
      cmp = d === null
        ? '<div class="hero-delta pnl-delta muted">За ' + esc(O.rangeLabel(prg)) + ' сравнить не с чем.</div>'
        : '<div class="hero-delta pnl-delta ' + (d >= 0 ? 'up' : 'down') + '"><span aria-hidden="true">' +
          (d >= 0 ? '▲' : '▼') + '</span> ' + (d >= 0 ? '+' : '−') + nf1.format(Math.abs(d)) + NBSP + '% к ' +
          esc(O.rangeLabel(prg)) + ' <span class="muted">· было ' + money(pk.profit) + '</span></div>';
    }
    return '<table class="pnl"><caption class="sr-only">Деньги Ozon за период</caption><tbody>' + out.join('') +
      '</tbody></table>' + cmp;
  }

  function renderRevenueParts(k) {
    const rows = [line('продажи · ' + int(k.orders) + NBSP + plural(k.orders, 'заказ', 'заказа', 'заказов'), money(k.sales))];
    if (k.returns) rows.push(line('возвраты', '−' + money(k.returns)));
    return '<table class="pnl hero-parts"><caption class="sr-only">Из чего сложена выручка</caption><tbody>' +
      rows.join('') + '</tbody></table>';
  }

  function tooltipHtml(e) {
    return '<div class="tip-head">' + esc(e.label) + (e.current ? ' · идёт' : '') + '</div>' +
      '<div class="tip-total"><b>' + money(e.revenue) + '</b> <span class="muted">выручка</span></div>' +
      '<div class="tip-row"><b>' + money(e.payout) + '</b> <span class="muted">пришло на счёт</span></div>' +
      '<div class="tip-row"><b>' + int(e.orders) + '</b> <span class="muted">' + plural(e.orders, 'заказ', 'заказа', 'заказов') + '</span></div>' +
      (e.seller_errors_n ? '<div class="tip-row"><b>' + int(e.seller_errors_n) + '</b> <span class="muted">' +
        plural(e.seller_errors_n, 'штраф', 'штрафа', 'штрафов') + ' на ' + money(e.seller_errors) + '</span></div>' : '');
  }

  function renderTable(series) {
    if (!series.length) return C.empty('За период нет данных.');
    const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
    const cls = v => (v === null ? 'muted' : v >= 0 ? 'good' : 'bad');
    const body = series.map((e, i) => {
      const p = i > 0 ? series[i - 1].revenue : null;
      const d = p === null ? null : e.revenue - p;
      const dp = p === null || !p ? null : 100 * d / Math.abs(p);
      return '<tr><th scope="row">' + esc(e.label) + (e.current ? ' <span class="live-tag">· идёт</span>' : '') + '</th>' +
        '<td class="num strong">' + money(e.revenue) + '</td>' +
        '<td class="num ' + cls(d) + '">' + (d === null ? '—' : (d > 0 ? '+' : d < 0 ? '−' : '') + money(Math.abs(d))) + '</td>' +
        '<td class="num ' + cls(dp) + '">' + (dp === null ? '—' : (dp >= 0 ? '+' : '−') + nf.format(Math.abs(dp)) + NBSP + '%') + '</td>' +
        '<td class="num">' + money(e.payout) + '</td>' +
        '<td class="num' + (isNum(e.profit) && e.profit < 0 ? ' bad' : '') + '">' + (isNum(e.profit) ? money(e.profit) : '—') + '</td>' +
        '<td class="num' + (e.seller_errors > 0 ? ' warn' : ' muted') + '">' + (e.seller_errors > 0 ? money(e.seller_errors) : '—') + '</td>' +
        '<td class="num">' + int(e.orders) + '</td></tr>';
    }).reverse().join('');
    const sum = f => series.reduce((a, e) => a + e[f], 0);
    const allKnown = series.every(e => e.n === 0 || e.lines_no_cogs === 0) && series.some(e => e.n > 0);
    const foot = '<tr><th scope="row">Итого</th><td class="num strong">' + money(sum('revenue')) + '</td><td></td><td></td>' +
      '<td class="num">' + money(sum('payout')) + '</td>' +
      '<td class="num">' + (allKnown ? money(sum('payout') - sum('cogs')) : '—') + '</td>' +
      '<td class="num">' + money(sum('seller_errors')) + '</td><td class="num">' + int(sum('orders')) + '</td></tr>';
    return '<div class="table-scroll tall"><table class="grid sticky-first"><thead><tr>' +
      ['Период', 'Выручка', 'Δ к пред.', 'Δ, %', 'Пришло', 'Прибыль', 'Ошибки продавца', 'Заказов']
        .map(h => '<th scope="col">' + esc(h) + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>';
  }

  function renderSkus(list) {
    if (!list.length) return C.empty('За период продаж нет.');
    const body = list.map(e =>
      '<tr><th scope="row"><div class="who">' + esc(e.name || e.sku) + '</div><div class="where">' + esc(e.sku) + '</div></th>' +
        '<td class="num">' + int(e.qty) + '</td>' +
        '<td class="num' + (e.returned_qty ? '' : ' muted') + '">' + (e.returned_qty ? int(e.returned_qty) : '—') + '</td>' +
        '<td class="num strong">' + money(e.revenue) + '</td>' +
        '<td class="num">' + money(e.commission + e.delivery) + '</td>' +
        '<td class="num">' + (e.lines_no_cogs ? '<span class="warn">нет цены</span>' : money(e.cogs)) + '</td>' +
        '<td class="num' + (isNum(e.gross) && e.gross < 0 ? ' bad' : '') + '">' + (isNum(e.gross) ? money(e.gross) : '—') + '</td>' +
        '<td class="num">' + (isNum(e.margin) ? pct(e.margin) : '—') + '</td></tr>').join('');
    const tot = f => list.reduce((a, e) => a + e[f], 0);
    const known = list.every(e => isNum(e.gross));
    const rev = tot('revenue'), gross = known ? tot('gross') : null;
    const foot = '<tr><th scope="row">Итого</th><td class="num">' + int(tot('qty')) + '</td><td class="num">' + int(tot('returned_qty')) + '</td>' +
      '<td class="num strong">' + money(rev) + '</td><td class="num">' + money(tot('commission') + tot('delivery')) + '</td>' +
      '<td class="num">' + (known ? money(tot('cogs')) : '—') + '</td><td class="num">' + (isNum(gross) ? money(gross) : '—') + '</td>' +
      '<td class="num">' + (isNum(gross) && rev > 0 ? pct(100 * gross / rev) : '—') + '</td></tr>';
    return '<div class="table-scroll"><table class="grid sticky-first"><thead><tr>' +
      ['Товар', 'Продано, шт.', 'Возвращено', 'Выручка', 'Вознаграждение и доставка', 'Себестоимость', 'Валовая прибыль', 'Маржа']
        .map(h => '<th scope="col">' + esc(h) + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>' +
      '<p class="note">Валовая прибыль — до ошибок продавца и прочих удержаний: их Ozon начисляет не по товару.</p>';
  }

  function renderErrors(rows, rg) {
    const list = errorsInRange(rows, rg);
    if (!list.length) return C.empty('За период штрафов «ошибка продавца» нет.');
    const total = list.reduce((a, r) => a + num(r.amount), 0);
    const cancelled = list.filter(r => r.api_status === 'cancelled' || r.api_status === 'cancelled_from_split').length;
    const missing = list.filter(r => !r.api_status).length;
    const body = list.map(r =>
      '<tr><th scope="row">' + C.date(r.day) + '</th>' +
        '<td>' + esc(r.posting_code || '—') + '</td>' +
        '<td class="num strong">' + money(r.amount) + '</td>' +
        '<td class="wrap">' + esc(r.product_name || '') + (r.fee_name ? '<div class="where">' + esc(r.fee_name) + '</div>' : '') + '</td>' +
        '<td>' + esc(statusWord(r.api_status)) + '</td>' +
        '<td class="num">' + (r.ordered_day ? C.date(r.ordered_day) : '—') + '</td></tr>').join('');
    const parts = [int(list.length) + ' ' + plural(list.length, 'штраф', 'штрафа', 'штрафов') + ' на ' + money(total)];
    if (cancelled) parts.push('по отменённым отправлениям — ' + int(cancelled));
    if (missing) parts.push('отправления нет в журнале — ' + int(missing));
    return '<p class="count muted">' + parts.join(' · ') + '</p>' +
      '<div class="table-scroll tall"><table class="grid sticky-first"><thead><tr>' +
      ['Дата', 'Отправление', 'Штраф', 'Товар', 'Статус сейчас', 'Заказ от'].map(h => '<th scope="col">' + h + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function renderNotes() {
    return '<ul class="notes">' +
      '<li><b>Деньги — из начислений Ozon</b>, по дню начисления: это отчёт кабинета «Финансы → Начисления», сверенный до копейки. Опрос раз в 4 часа, ночью — глубокий.</li>' +
      '<li><b>Выручка</b> — продажи минус возвраты, ровно строка Ozon на «Обзоре». До первого дня начислений «Обзор» берёт Ozon по статусу отправлений; здесь этой истории нет.</li>' +
      '<li><b>Пришло на счёт</b> — сумма всех начислений: продажи минус всё, что удержал Ozon.</li>' +
      '<li><b>Ошибки продавца</b> — штрафы «Обработка операционных ошибок продавца»: отмена по вине продавца, отгрузка в нерекомендованный слот, просрочка.</li>' +
      '<li><b>Прочие удержания</b> — всё, что Ozon начислил не по строке продажи: реклама с оплатой за заказ, услуги FBO, логистика невыкупов, компенсации со знаком плюс. По видам пока не разбираются.</li>' +
      '<li><b>Себестоимость</b> — проданное минус возвращённое, с довесками. Нет цены хоть у одной строки — прибыль за период прочерком.</li>' +
      '<li><b>В работе</b> — отправления за 60 дней, ещё не доставленные и не отменённые, на момент опроса Ozon. От периода не зависит.</li>' +
      '<li>Пока нет: склада, рекламы и воронки «заказано → выкуплено» — они остались в кабинете Ozon старого дашборда.</li>' +
    '</ul>';
  }

  root.NietteOzon = {
    SUM_COLS, sumRange, metrics, buildSeries, skuTotals, errorsInRange, statusWord, change,
    renderKpis, renderMoney, renderRevenueParts, tooltipHtml, renderTable, renderSkus, renderErrors, renderNotes
  };
})(typeof window !== 'undefined' ? window : globalThis);
