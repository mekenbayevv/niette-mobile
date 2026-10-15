/* «Обзор» по референсу (15.10.2026): восемь плиток со спарклайнами,
 * динамика выручки против прошлого периода, вклад площадок, топ товаров,
 * клиенты и структура заказов.
 *
 * Только чистые функции, как overview.js: снимки на вход, модель и HTML на
 * выход. Сеть и события — в app.js. Проверяется в Node
 * (tests/app_overview_board_test.js).
 *
 * ЧТО НЕ ВЫДУМЫВАЕТСЯ. Каждая цифра — из того же снимка и той же функции,
 * что на экране своего канала, чтобы «Обзор» и Kaspi/Ozon не расходились:
 *   · выручка, заказы, средний чек — snap_overview_daily, все каналы;
 *   · штуки, прибыль, маржа — Kaspi (K.metrics) + Ozon (Z.metrics). У WB и
 *     B2B в снимках нет себестоимости, поэтому плитка так и подписана;
 *     себестоимость Ozon неизвестна хоть у одной строки — прибыль и маржа
 *     только по Kaspi, и это написано в подписи, а не спрятано;
 *   · маржа — после комиссий и доставки, ДО рекламы (решение 15.10.2026);
 *   · покупатели — опознанные клиенты Kaspi, как на «Клиентах» и Kaspi;
 *   · топ товаров и структура заказов — Kaspi по дню ЗАКАЗА («Аналитика»).
 * Нет данных — прочерк, а не ноль.
 */
(function (root) {
  'use strict';

  const C = root.NietteClients;
  const esc = C.esc, money = C.money, int = C.int, pct = C.pct, isNum = C.isNum;
  const NBSP = String.fromCharCode(160);
  const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  function num(v) { return isNum(v) ? Number(v) : 0; }
  function share(a, b) { return b > 0 ? 100 * a / b : null; }

  // ── Бакеты ────────────────────────────────────────────────────────────────
  // Та же сетка, что у графиков «Обзора» (O.buildSeries): ключи бакетов
  // периода по порядку, включая пустые.
  function bucketKeys(O, rg, grouping) {
    return O.buildSeries([], rg, grouping, null).map(e => ({ key: e.key, label: e.label }));
  }
  // Сумма fn(row) по бакетам периода. rows — строки с полем day.
  function bucketize(O, rows, rg, grouping, fn) {
    const keys = bucketKeys(O, rg, grouping), pos = new Map();
    keys.forEach((k, i) => pos.set(k.key, i));
    const out = keys.map(() => 0);
    (rows || []).forEach(r => {
      if (!(r.day >= rg.from && r.day <= rg.to)) return;
      const i = pos.get(O.bucketOf(r.day, grouping).key);
      if (i !== undefined) out[i] += fn(r);
    });
    return out;
  }
  function ratio(a, b, k) { return a.map((x, i) => (b[i] > 0 ? (k || 1) * x / b[i] : null)); }
  function add(a, b) { return a.map((x, i) => x + (b ? b[i] || 0 : 0)); }

  // ── Модель ────────────────────────────────────────────────────────────────
  // input: { O, K, Z, A, ov, kp, oz, sku, del, idx, rg, prg, prevLabel, grouping, today,
  //          errors: { kp, oz, sku, del, clients } }
  function sumOv(rows, rg) {
    const t = { revenue: 0, gross: 0, orders: 0 };
    (rows || []).forEach(r => {
      if (!(r.day >= rg.from && r.day <= rg.to)) return;
      t.revenue += num(r.revenue); t.gross += num(r.gross); t.orders += num(r.orders);
    });
    return t;
  }

  // Прибыль Kaspi + Ozon за период: Kaspi — по заказам с известной
  // себестоимостью (counted_*), Ozon — пришло на счёт минус себестоимость,
  // только если она известна у всех строк периода (правило ozon.js).
  function profitOf(I, rg) {
    const k = I.kp && !I.errors.kp ? I.K.metrics(I.kp, null, rg) : null;
    const z = I.Z && I.oz && !I.errors.oz ? I.Z.metrics(I.oz, rg) : null;
    const kOk = k && isNum(k.profit), zHas = z && z.revenue !== 0, zOk = zHas && isNum(z.profit);
    if (!kOk && !zOk) return { profit: null, base: null, kaspiOnly: false, qty: k || z ? num(k && k.qty) + num(z && z.qty) : null };
    const profit = (kOk ? k.profit : 0) + (zOk ? z.profit : 0);
    const base = (kOk ? k.counted_revenue : 0) + (zOk ? z.revenue : 0);
    return { profit, base, margin: share(profit, base), kaspiOnly: kOk && zHas && !zOk,
             qty: num(k && k.qty) + num(z && z.qty) };
  }

  function model(I) {
    const O = I.O, rg = I.rg, prg = I.prg, g = I.grouping, E = I.errors || {};
    const cur = sumOv(I.ov, rg), prev = prg ? sumOv(I.ov, prg) : null;
    const b = (rows, fn) => bucketize(O, rows, rg, g, fn);
    const revB = b(I.ov, r => num(r.revenue)), ordB = b(I.ov, r => num(r.orders)), grossB = b(I.ov, r => num(r.gross));
    const kp = E.kp ? [] : I.kp || [], oz = E.oz || !I.Z ? [] : I.oz || [];
    const qtyB = add(b(kp, r => num(r.qty)), b(oz, r => num(r.qty)));
    const kProfitB = b(kp, r => num(r.counted_revenue) - num(r.counted_commission) - num(r.counted_delivery) - num(r.counted_cogs));
    const kBaseB = b(kp, r => num(r.counted_revenue));
    const p = profitOf(I, rg), pp = prg ? profitOf(I, prg) : null;
    const withOz = !p.kaspiOnly && oz.length;
    const profitB = withOz ? add(kProfitB, b(oz, r => num(r.payout) - num(r.cogs))) : kProfitB;
    const baseB = withOz ? add(kBaseB, b(oz, r => num(r.revenue))) : kBaseB;

    const cl = I.idx && !E.clients ? I.K.clientsIn(I.idx, rg) : null;
    const pcl = I.idx && !E.clients && prg ? I.K.clientsIn(I.idx, prg) : null;
    const cliS = I.idx && !E.clients ? I.K.clientSeries(I.idx, rg, g, I.today) : [];
    const repShare = c => (c && c.active > 0 ? 100 * c.repeat / c.active : null);

    const profitSub = p.kaspiOnly ? 'только Kaspi: у Ozon не вся себестоимость' : 'Kaspi и Ozon · после комиссий и доставки';
    const kpis = [
      { key: 'revenue', label: 'Выручка', value: cur.revenue, prev: prev && prev.revenue, kind: 'money', spark: revB,
        sub: 'все каналы' + (prev && I.prevLabel ? ' · к ' + I.prevLabel + ' было ' + money(prev.revenue) : '') },
      { key: 'orders', label: 'Заказы', value: cur.orders, prev: prev && prev.orders, kind: 'int', spark: ordB, sub: 'все каналы' },
      { key: 'units', label: 'Продано, шт', value: E.kp && E.oz ? null : p.qty, prev: pp && pp.qty, kind: 'int', spark: qtyB,
        sub: 'Kaspi и Ozon' },
      { key: 'check', label: 'Средний чек', value: cur.orders > 0 ? cur.gross / cur.orders : null,
        prev: prev && prev.orders > 0 ? prev.gross / prev.orders : null, kind: 'money', spark: ratio(grossB, ordB), sub: 'все каналы' },
      { key: 'profit', label: 'Валовая прибыль', value: p.profit, prev: pp && pp.kaspiOnly === p.kaspiOnly ? pp.profit : null,
        kind: 'money', spark: profitB, sub: profitSub },
      { key: 'margin', label: 'Маржа', value: p.margin, prev: pp && pp.kaspiOnly === p.kaspiOnly ? pp.margin : null,
        kind: 'pp', spark: ratio(profitB, baseB, 100), sub: 'прибыль ÷ выручка · до рекламы' },
      { key: 'repeat', label: 'Повторные покупатели', value: repShare(cl), prev: repShare(pcl), kind: 'pp',
        spark: cliS.map(e => (e.buyers > 0 ? 100 * e.repeat / e.buyers : null)),
        sub: cl && isNum(cl.active) ? int(cl.repeat) + ' из ' + int(cl.active) + ' покупателей Kaspi' : 'покупатели Kaspi' },
      { key: 'fresh', label: 'Новые покупатели', value: cl ? cl.fresh : null, prev: pcl ? pcl.fresh : null, kind: 'int',
        spark: cliS.map(e => e.fresh), sub: 'первый заказ на Kaspi' }
    ];

    // Динамика выручки: этот период и прошлый той же длины, бакет к бакету.
    const keys = bucketKeys(O, rg, g);
    const prevB = prg ? bucketize(O, I.ov, prg, g, r => num(r.revenue)) : [];
    const curKey = I.today ? O.bucketOf(I.today, g).key : null;
    const trend = keys.map((k, i) => ({ label: k.label, cur: revB[i], prev: i < prevB.length ? prevB[i] : null, current: k.key === curKey }));

    // Вклад площадок — те же каналы и порядок, что у легенды «Обзора».
    const t = O.totals(I.ov || [], rg);
    const mix = O.channelsOf(I.ov || []).map(c => ({ key: c.key, label: c.label, value: t.by[c.key] || 0 }))
      .filter(x => x.value !== 0).map(x => Object.assign(x, { share: share(x.value, t.total) }))
      .sort((a, b) => b.value - a.value);   // по убыванию выручки; цвет — у канала, не у места

    const skus = I.A && I.sku && !E.sku ? I.A.skuTotals(I.sku, rg) : null;
    const top = skus ? skus.slice(0, 5) : null;
    const skuSum = skus ? skus.reduce((a, e) => a + num(e.placed_amount), 0) : 0;
    const del = I.A && I.del && !E.del ? I.A.deliveryTotals(I.del, rg).filter(e => e.placed_orders > 0) : null;

    return { kpis, trend, mix, total: t.total, top, skuSum, del, cl, pcl, cliS };
  }

  // ── Числа ─────────────────────────────────────────────────────────────────
  function fmt(v, kind) {
    if (!isNum(v)) return '—';
    if (kind === 'money') return money(v);
    if (kind === 'pp') return pct(v);
    return int(v);
  }
  // Изменение: деньги и штуки — в процентах и в единицах, доли — в п.п.
  function delta(k) {
    if (!isNum(k.value) || !isNum(k.prev)) return '<div class="kb-delta muted">' + (isNum(k.value) ? 'сравнивать не с чем' : NBSP) + '</div>';
    const d = k.kind === 'pp' ? k.value - k.prev : (k.prev !== 0 ? 100 * (k.value - k.prev) / Math.abs(k.prev) : null);
    if (d === null) return '<div class="kb-delta muted">было 0</div>';
    const up = d > 0, flat = Math.abs(d) < 0.05;
    const cls = flat ? 'flat' : up ? 'up' : 'down';
    const arrow = flat ? '' : '<span class="kb-arrow" aria-hidden="true">' + (up ? '↑' : '↓') + '</span>';
    const main = (up ? '+' : d < 0 ? '−' : '') + nf1.format(Math.abs(d)) + NBSP + (k.kind === 'pp' ? 'п.п.' : '%');
    let abs = '';
    if (k.kind !== 'pp') {
      const a = k.value - k.prev;
      abs = '<div class="kb-abs ' + cls + '">' + (a > 0 ? '+' : a < 0 ? '−' : '') + fmt(Math.abs(a), k.kind) + '</div>';
    }
    return '<div class="kb-delta ' + cls + '">' + arrow + main + '</div>' + abs;
  }

  // ── Спарклайн и линейный график ───────────────────────────────────────────
  // SVG тянется по ширине (viewBox + preserveAspectRatio="none"), толщина
  // линии от растяжения не меняется (vector-effect). Подписи — HTML поверх.
  function path(vals, w, h, lo, hi, pad) {
    const n = vals.length, span = hi - lo || 1, pts = [];
    vals.forEach((v, i) => {
      if (!isNum(v)) return;
      const x = n === 1 ? w / 2 : (i * w) / (n - 1);
      const y = pad + (h - 2 * pad) * (1 - (v - lo) / span);
      pts.push([x, y]);
    });
    return pts;
  }
  function xy(v) { return Number(v).toFixed(2); }
  function poly(pts) { return pts.map((p, i) => (i ? 'L' : 'M') + xy(p[0]) + ' ' + xy(p[1])).join(' '); }

  function spark(vals, tone) {
    const nums = (vals || []).filter(isNum);
    if (nums.length < 2) return '<div class="kb-spark empty" aria-hidden="true"></div>';
    let lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums);
    if (lo === hi) { lo -= 1; hi += 1; }
    const pts = path(vals, 100, 36, lo, hi, 3);
    const area = poly(pts) + ' L' + xy(pts[pts.length - 1][0]) + ' 36 L' + xy(pts[0][0]) + ' 36 Z';
    return '<svg class="kb-spark ' + tone + '" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
      '<path class="kb-area" d="' + area + '"/><path class="kb-line" d="' + poly(pts) + '" vector-effect="non-scaling-stroke"/></svg>';
  }

  function renderKpis(m) {
    return '<div class="kb-grid" role="list">' + m.kpis.map(k => {
      const d = isNum(k.value) && isNum(k.prev) ? (k.kind === 'pp' ? k.value - k.prev : k.value - k.prev) : 0;
      const tone = d < 0 ? 'down' : 'up';
      return '<div class="kb-card" role="listitem" data-kpi="' + k.key + '">' +
        '<div class="kb-top"><span class="kb-ico ki-' + k.key + '" aria-hidden="true"></span>' +
          '<span class="kb-label">' + esc(k.label) + '</span></div>' +
        '<div class="kb-row"><div class="kb-nums"><div class="kb-value">' + fmt(k.value, k.kind) + '</div>' + delta(k) + '</div>' +
          spark(k.spark, tone) + '</div>' +
        '<div class="kb-sub">' + esc(k.sub) + '</div></div>';
    }).join('') + '</div>';
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const k of [1, 2, 2.5, 5, 10]) if (v <= k * p) return k * p;
    return 10 * p;
  }
  function compact(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return nf1.format(v / 1e6) + NBSP + 'млн' + NBSP + '₸';
    if (a >= 1e3) return Math.round(v / 1e3) + NBSP + 'тыс' + NBSP + '₸';
    return int(v) + NBSP + '₸';
  }

  // Линия этого периода с заливкой, прошлый — пунктиром. Наведение — на
  // всю высоту бакета: подсказка с обеими суммами (title, без скрипта).
  function renderTrend(m, labels) {
    const tr = m.trend, L = labels || {};
    if (!tr.length) return C.empty ? C.empty('За период данных нет.') : '<p class="empty">За период данных нет.</p>';
    const all = tr.map(e => e.cur).concat(tr.map(e => e.prev)).filter(isNum);
    const top = niceMax(Math.max.apply(null, all.concat([0])));
    const W = 1000, H = 240, n = tr.length;
    const curPts = path(tr.map(e => e.cur), W, H, 0, top, 0);
    const prevPts = path(tr.map(e => e.prev), W, H, 0, top, 0);
    const area = curPts.length ? poly(curPts) + ' L' + xy(curPts[curPts.length - 1][0]) + ' ' + H + ' L' + xy(curPts[0][0]) + ' ' + H + ' Z' : '';
    const ticks = [0, .25, .5, .75, 1].map(f => top * f);
    const grid = ticks.map(v => '<line class="kb-grid-line" x1="0" x2="' + W + '" y1="' + xy(H * (1 - v / top)) + '" y2="' + xy(H * (1 - v / top)) + '" vector-effect="non-scaling-stroke"/>').join('');
    const step = Math.max(1, Math.ceil(n / 7));
    // Подписи оси — каждая step-я и последняя, если не налезает на соседнюю.
    const shown = tr.map((e, i) => i % step === 0);
    if (n > 1 && !shown[n - 1]) { if ((n - 1) % step < Math.max(2, step * 0.75)) shown[(n - 1) - ((n - 1) % step)] = false; shown[n - 1] = true; }
    const xl = tr.map((e, i) => (shown[i] ? '<span style="left:' + (n === 1 ? 50 : (100 * i) / (n - 1)).toFixed(3) + '%">' + esc(e.label) + '</span>' : '')).join('');
    const hits = tr.map((e, i) => {
      const x0 = n === 1 ? 0 : Math.max(0, ((i - 0.5) * W) / (n - 1)), x1 = n === 1 ? W : Math.min(W, ((i + 0.5) * W) / (n - 1));
      const tip = e.label + (e.current ? ' · идёт' : '') + ': ' + fmt(e.cur, 'money') +
        (isNum(e.prev) ? ' · ' + (L.prev || 'прошлый период') + ': ' + fmt(e.prev, 'money') : '');
      return '<rect class="kb-hit" x="' + xy(x0) + '" y="0" width="' + xy(x1 - x0) + '" height="' + H + '"><title>' + esc(tip) + '</title></rect>';
    }).join('');
    const last = curPts.length ? curPts[curPts.length - 1] : null;
    return '<div class="kb-trend">' +
      '<div class="kb-legend"><span class="kb-lg cur"><i aria-hidden="true"></i>' + esc(L.cur || 'Текущий период') + '</span>' +
        (prevPts.length ? '<span class="kb-lg prev"><i aria-hidden="true"></i>' + esc(L.prev || 'Прошлый период') + '</span>' : '') + '</div>' +
      '<div class="kb-plot">' +
        '<div class="kb-yax" aria-hidden="true">' + ticks.slice().reverse().map(v => '<span>' + (v === 0 ? '0' : compact(v)) + '</span>').join('') + '</div>' +
        '<div class="kb-canvas">' +
          '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' +
            esc('Выручка по периодам: ' + tr.map(e => e.label + ' ' + fmt(e.cur, 'money')).join(', ')) + '">' +
            grid +
            (area ? '<path class="kb-tarea" d="' + area + '"/>' : '') +
            (prevPts.length > 1 ? '<path class="kb-tprev" d="' + poly(prevPts) + '" vector-effect="non-scaling-stroke"/>' : '') +
            (curPts.length > 1 ? '<path class="kb-tcur" d="' + poly(curPts) + '" vector-effect="non-scaling-stroke"/>' : '') +
            hits + '</svg>' +
          (last ? '<span class="kb-dot" style="left:' + (last[0] / W * 100).toFixed(3) + '%;top:' + (last[1] / H * 100).toFixed(3) + '%" aria-hidden="true"></span>' : '') +
          '<div class="kb-xax" aria-hidden="true">' + xl + '</div>' +
        '</div></div></div>';
  }

  // ── Кольцо ────────────────────────────────────────────────────────────────
  // Сегменты по часовой стрелке с 12 часов, между ними 2 px фона. cls(item) —
  // класс цвета сегмента и кружка в легенде.
  function donut(items, center, cls, valueOf) {
    const total = items.reduce((a, x) => a + Math.max(0, valueOf(x)), 0);
    const R = 15.9155;   // pathLength = 100: длины сегментов — прямо в процентах
    let acc = 0;
    const segs = total > 0 ? items.map(x => {
      const v = Math.max(0, valueOf(x)), len = 100 * v / total, gap = items.length > 1 && len > 1.2 ? 0.8 : 0;
      const s = '<circle class="kb-seg ' + cls(x) + '" cx="21" cy="21" r="' + R + '" pathLength="100" stroke-dasharray="' +
        xy(Math.max(0, len - gap)) + ' ' + xy(100 - Math.max(0, len - gap)) + '" stroke-dashoffset="' + xy(25 - acc) + '"><title>' +
        esc(x.label + ': ' + pct(100 * v / total)) + '</title></circle>';
      acc += len;
      return s;
    }).join('') : '';
    return '<div class="kb-donut"><svg viewBox="0 0 42 42" role="img" aria-label="' +
      esc(items.map(x => x.label + ' ' + pct(total > 0 ? 100 * Math.max(0, valueOf(x)) / total : 0)).join(', ')) + '">' +
      '<circle class="kb-ring" cx="21" cy="21" r="' + R + '"/>' + segs + '</svg>' +
      '<div class="kb-center">' + center + '</div></div>';
  }

  function renderMix(m) {
    if (!m.mix.length) return '<p class="empty">За период продаж нет.</p>';
    const center = '<b>' + esc(compactBig(m.total)) + '</b><span>общая выручка</span>';
    return '<div class="kb-pie">' + donut(m.mix, center, x => 'ch-' + x.key, x => x.value) +
      '<ul class="kb-pie-legend">' + m.mix.map(x =>
        '<li><span class="sw sq ch-' + esc(x.key) + '" aria-hidden="true"></span><span class="kb-pl-name">' + esc(x.label) + '</span>' +
        '<span class="kb-pl-pct">' + pct(x.share) + '</span><span class="kb-pl-val">' + money(x.value) + '</span></li>').join('') +
      '</ul></div>';
  }
  function compactBig(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return nf2.format(v / 1e6) + NBSP + 'млн' + NBSP + '₸';
    if (a >= 1e3) return int(v / 1e3) + NBSP + 'тыс' + NBSP + '₸';
    return money(v);
  }

  // ── Топ товаров ───────────────────────────────────────────────────────────
  function renderTop(m, nameOf) {
    if (!m.top || !m.top.length) return '<p class="empty">За период заказов нет.</p>';
    const name = nameOf || (x => x.name || x.sku);
    return '<div class="table-scroll kb-top-table"><table class="grid"><thead><tr><th scope="col" class="txt">Товар</th>' +
      '<th scope="col">Шт</th><th scope="col">Сумма заказов</th><th scope="col">Доля</th><th scope="col">Выкуп</th></tr></thead><tbody>' +
      m.top.map((e, i) => '<tr><th scope="row"><span class="kb-rank">' + (i + 1) + '</span><span class="kb-pname">' +
        '<span class="kb-pn">' + esc(name(e)) + '</span><span class="where">' + esc(e.sku) + '</span></span></th>' +
        '<td class="num">' + int(e.placed_qty) + '</td><td class="num strong">' + money(e.placed_amount) + '</td>' +
        '<td class="num">' + pct(share(num(e.placed_amount), m.skuSum)) + '</td>' +
        '<td class="num">' + pct(e.buyout) + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  // ── Клиенты ───────────────────────────────────────────────────────────────
  function renderClients(m) {
    const k = key => m.kpis.filter(x => x.key === key)[0];
    if (!m.cl || !isNum(m.cl.active)) return '<p class="empty">Нет данных о покупателях Kaspi.</p>';
    const tile = (label, v, prev, sp) => {
      const kk = { value: v, prev, kind: 'int' };
      return '<div class="kb-mini"><div class="kb-label">' + esc(label) + '</div><div class="kb-row"><div class="kb-nums">' +
        '<div class="kb-value sm">' + int(v) + '</div>' + delta(kk) + '</div>' + spark(sp, isNum(prev) && v < prev ? 'down' : 'up') + '</div></div>';
    };
    const rep = k('repeat');
    const bars = m.cliS.map(e => (e.buyers > 0 ? 100 * e.repeat / e.buyers : null));
    const maxB = Math.max.apply(null, bars.filter(isNum).concat([1]));
    const barsHtml = '<div class="kb-bars" role="img" aria-label="' + esc('Доля повторных по периодам: ' +
      m.cliS.map((e, i) => e.label + ' ' + pct(bars[i])).join(', ')) + '">' +
      m.cliS.map((e, i) => '<span class="kb-bar' + (e.current ? ' cur' : '') + '" style="height:' +
        (isNum(bars[i]) ? Math.max(4, 100 * bars[i] / maxB).toFixed(1) : 0) + '%" title="' +
        esc(e.label + ': ' + pct(bars[i]) + ' повторных · ' + int(e.buyers) + ' покупателей') + '"></span>').join('') + '</div>';
    return '<div class="kb-clients">' +
      '<div class="kb-minis">' + tile('Новые', m.cl.fresh, m.pcl && m.pcl.fresh, m.cliS.map(e => e.fresh)) +
        tile('Повторные', m.cl.repeat, m.pcl && m.pcl.repeat, m.cliS.map(e => e.repeat)) + '</div>' +
      '<div class="kb-mini wide"><div class="kb-label">Доля повторных покупателей</div><div class="kb-row">' +
        '<div class="kb-nums"><div class="kb-value sm">' + pct(rep.value) + '</div>' + delta(rep) + '</div>' + barsHtml + '</div>' +
        '<div class="kb-sub">повторный — покупал на Kaspi и раньше этого периода</div></div>' +
    '</div>';
  }

  // ── Структура заказов: способы доставки Kaspi ─────────────────────────────
  const DEL_TONE = ['d1', 'd2', 'd3', 'd4', 'd5'];
  function renderOrders(m, labelOf) {
    if (!m.del || !m.del.length) return '<p class="empty">За период заказов нет.</p>';
    const total = m.del.reduce((a, e) => a + e.placed_orders, 0);
    const items = m.del.map((e, i) => ({ label: labelOf ? labelOf(e) : e.label, v: e.placed_orders, tone: DEL_TONE[Math.min(i, 4)] }));
    const center = '<b>' + int(total) + '</b><span>заказов Kaspi</span>';
    return '<div class="kb-pie col">' + donut(items, center, x => 'kb-' + x.tone, x => x.v) +
      '<ul class="kb-pie-legend">' + items.map(x =>
        '<li><span class="sw sq kb-' + x.tone + '" aria-hidden="true"></span><span class="kb-pl-name">' + esc(x.label) + '</span>' +
        '<span class="kb-pl-pct">' + pct(share(x.v, total)) + '</span></li>').join('') + '</ul></div>';
  }

  root.NietteBoard = { bucketKeys, bucketize, model, profitOf, renderKpis, renderTrend, renderMix, renderTop, renderClients, renderOrders, spark, delta, fmt };
})(typeof window !== 'undefined' ? window : globalThis);
