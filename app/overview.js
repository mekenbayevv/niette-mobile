/* Экран «Обзор» на снимках Postgres: расчёты и разметка.
 *
 * Как и clients.js — только чистые функции: строки таблицы на вход, строка
 * HTML на выход. Сеть, состояние и события живут в app.js. Поэтому всё здесь
 * проверяется в Node (tests/app_overview_test.js).
 *
 * Источник — снимок snap_overview_daily (sql/16_overview.sql): строка на
 * «день × канал», вся история сразу. Период, группировка и скрытые каналы
 * считаются здесь, в браузере: смена периода в базу не ходит вовсе.
 *
 * ДАТЫ — ТОЛЬКО СТРОКИ 'YYYY-MM-DD', арифметика в UTC. Старый «Обзор» дважды
 * уезжал на сутки из-за часовых поясов (ovIsoDay в Dashboard.html): полночь
 * Алматы в ISO с 'Z' выглядит как 19:00 предыдущего дня. Здесь объект Date
 * появляется только внутри сложения дней, в UTC, и наружу не выходит.
 */
(function (root) {
  'use strict';

  const C = root.NietteClients;

  // Порядок = порядок в стопке столбца, в полосе долей и в легенде. Цвета —
  // в style.css (--ch-*), проверены валидатором палитры в ЭТОМ порядке:
  // соседние пары различимы и при дальтонизме, у тёмной темы свои ступени.
  // Цвет привязан к каналу, а не к месту: скрыл Ozon — Kaspi остаётся синим.
  const CHANNELS = [
    { key: 'kaspi',  label: 'Kaspi' },
    { key: 'ozon',   label: 'Ozon' },
    { key: 'apteki', label: 'B2B' },
    { key: 'wb',     label: 'Wildberries' },
    { key: 'teez',   label: 'Teez' }
  ];
  const KNOWN = {};
  CHANNELS.forEach(c => { KNOWN[c.key] = c; });

  const PRESETS = [
    { key: 'today', label: 'Сегодня' },
    { key: '7d',    label: '7 дней' },
    { key: '30d',   label: '30 дней' },
    { key: 'month', label: 'Этот месяц' },
    { key: 'all',   label: 'Всё время' }
  ];
  const GROUPINGS = [
    { key: 'day',    label: 'Дни' },
    { key: 'week',   label: 'Недели' },
    { key: 'decade', label: 'Декады' },
    { key: 'month',  label: 'Месяцы' }
  ];
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  const esc = C.esc, money = C.money, isNum = C.isNum;
  function num(v) { return isNum(v) ? Number(v) : 0; }

  // ── Даты ──────────────────────────────────────────────────────────────────
  function pad(n) { return String(n).padStart(2, '0'); }
  function parts(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function utc(iso) { const p = parts(iso); return new Date(Date.UTC(p.y, p.m - 1, p.d)); }
  function ofUtc(dt) { return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()); }
  function addDays(iso, n) { const d = utc(iso); d.setUTCDate(d.getUTCDate() + n); return ofUtc(d); }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function spanDays(from, to) { return Math.round((utc(to) - utc(from)) / 86400000) + 1; }
  // Сегодня — по часам браузера: пользователь в Астане, дни в данных — по Алматы.
  function todayIso(now) {
    const d = now || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dmy(iso) { const p = parts(iso); return p ? pad(p.d) + '.' + pad(p.m) + '.' + p.y : '—'; }
  function dm(iso) { const p = parts(iso); return p ? pad(p.d) + '.' + pad(p.m) : '—'; }
  function rangeLabel(r) {
    if (!r) return '';
    if (r.from === r.to) return dmy(r.from);
    const a = parts(r.from), b = parts(r.to);
    return (a.y === b.y ? dm(r.from) : dmy(r.from)) + '–' + dmy(r.to);
  }

  // ── Период ────────────────────────────────────────────────────────────────
  // «Всё время» начинается с первого дня в данных, а не с 23 марта строкой:
  // константа однажды разошлась бы с данными молча.
  function presetRange(preset, today, minDay) {
    if (preset === 'today') return { from: today, to: today };
    if (preset === '7d') return { from: addDays(today, -6), to: today };
    if (preset === '30d') return { from: addDays(today, -29), to: today };
    if (preset === 'month') { const p = parts(today); return { from: p.y + '-' + pad(p.m) + '-01', to: today }; }
    return { from: minDay && minDay < today ? minDay : today, to: today };
  }

  // С чем сравнивать. «Этот месяц» — с теми же числами прошлого месяца
  // (1–24 сентября против 1–24 августа), а не с 24 днями подряд до 1-го:
  // иначе незакрытый месяц сравнивался бы с хвостом прошлого и начала
  // позапрошлого. Остальное — с отрезком той же длины прямо перед периодом.
  function prevRange(preset, r) {
    if (!r || preset === 'all') return null;
    if (preset === 'month') {
      const f = parts(r.from), t = parts(r.to);
      const py = f.m === 1 ? f.y - 1 : f.y, pm = f.m === 1 ? 12 : f.m - 1;
      return { from: py + '-' + pad(pm) + '-01',
               to: py + '-' + pad(pm) + '-' + pad(Math.min(t.d, daysInMonth(py, pm))) };
    }
    const n = spanDays(r.from, r.to);
    return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
  }

  // ── Группировка ───────────────────────────────────────────────────────────
  // Неделя — с понедельника, декады — 1–10, 11–20, 21–конец месяца: так же,
  // как в старом «Обзоре» (ovBucket), чтобы суммы сверялись один в один.
  function bucketOf(iso, g) {
    const p = parts(iso);
    if (g === 'month') return { key: p.y + '-' + pad(p.m), label: MONTHS_SHORT[p.m - 1] + ' ' + p.y };
    if (g === 'decade') {
      const s = p.d <= 10 ? 1 : p.d <= 20 ? 11 : 21;
      const e = s === 21 ? daysInMonth(p.y, p.m) : s + 9;
      return { key: p.y + '-' + pad(p.m) + '-' + pad(s), label: s + '–' + e + ' ' + MONTHS_SHORT[p.m - 1] };
    }
    if (g === 'week') {
      const wd = (utc(iso).getUTCDay() + 6) % 7;
      const mon = addDays(iso, -wd), sun = addDays(mon, 6);
      const a = parts(mon), b = parts(sun);
      const label = a.m === b.m ? a.d + '–' + b.d + ' ' + MONTHS_SHORT[a.m - 1]
                                : a.d + ' ' + MONTHS_SHORT[a.m - 1] + ' – ' + b.d + ' ' + MONTHS_SHORT[b.m - 1];
      return { key: mon, label };
    }
    return { key: iso, label: dm(iso) };
  }

  // Сколько календарных месяцев захватывает период: «Месяцы» на одном
  // месяце — один столбик, а не динамика (правило старого «Обзора»).
  function monthsSpanned(r) {
    const a = parts(r.from), b = parts(r.to);
    return (b.y - a.y) * 12 + (b.m - a.m) + 1;
  }

  // ── Расчёты ───────────────────────────────────────────────────────────────
  function minDay(rows) { return rows.reduce((m, r) => (!m || r.day < m ? r.day : m), ''); }
  function inRange(r, rg) { return rg && r.day >= rg.from && r.day <= rg.to; }

  // Каналы, которые есть в данных, но не описаны выше, не теряются: они
  // входят в итог и показываются под своим именем серым. Итог обязан
  // сходиться с суммой строк легенды — иначе одна из цифр врёт.
  function channelsOf(rows) {
    const out = CHANNELS.slice();
    rows.forEach(r => {
      if (!KNOWN[r.channel] && !out.some(c => c.key === r.channel)) {
        out.push({ key: r.channel, label: r.channel || '?', other: true });
      }
    });
    return out;
  }

  function totals(rows, rg) {
    const by = {};
    let total = 0, count = 0;
    rows.forEach(r => {
      if (!inRange(r, rg)) return;
      const v = num(r.revenue);
      by[r.channel] = (by[r.channel] || 0) + v;
      total += v;
      count++;
    });
    return { total, by, count };
  }

  // Бакеты периода по порядку, включая пустые: день без продаж — это ноль
  // на оси, а не выпавшая дата, из-за которой соседние столбцы слипаются.
  function buildSeries(rows, rg, grouping, today) {
    const map = new Map();
    for (let d = rg.from, guard = 0; d <= rg.to && guard < 5000; d = addDays(d, 1), guard++) {
      const b = bucketOf(d, grouping);
      if (!map.has(b.key)) map.set(b.key, { key: b.key, label: b.label, total: 0, by: {}, orders: 0, gross: 0 });
    }
    rows.forEach(r => {
      if (!inRange(r, rg)) return;
      const e = map.get(bucketOf(r.day, grouping).key);
      if (!e) return;
      const v = num(r.revenue);
      e.by[r.channel] = (e.by[r.channel] || 0) + v;
      e.total += v;
      e.orders += num(r.orders);      // подсказке плитки канала: заказы и средний чек бакета
      e.gross += num(r.gross);
    });
    const cur = today ? bucketOf(today, grouping).key : null;
    return Array.from(map.values())
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(e => Object.assign(e, { current: e.key === cur }));
  }

  // Рекорд — только среди ЗАКРЫТЫХ бакетов: незакрытый день или месяц
  // рекордом быть не может, завтра он ещё вырастет. И только если есть с чем
  // сравнить (два закрытых бакета и больше).
  function recordIndex(series) {
    let best = -1, closed = 0;
    series.forEach((e, i) => {
      if (e.current || !(e.total > 0)) return;
      closed++;
      if (best < 0 || e.total > series[best].total) best = i;
    });
    return closed >= 2 ? best : -1;
  }

  // ── Числа ─────────────────────────────────────────────────────────────────
  const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  function compact(v) {
    const a = Math.abs(v), s = v < 0 ? '−' : '';
    if (a >= 1e6) return s + nf1.format(a / 1e6) + ' млн';
    if (a >= 1e3) return s + Math.round(a / 1e3) + ' тыс';
    return s + nf1.format(a);        // середина шкалы в 25 заказов — «12,5», а не «13»
  }
  // Верх шкалы — круглое число: 1, 2, 2,5, 5 × 10ⁿ.
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const k of [1, 2, 2.5, 5, 10]) if (v <= k * p) return k * p;
    return 10 * p;
  }
  function signedMoney(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + money(Math.abs(v)); }
  function pctOf(part, whole) { return whole ? 100 * part / whole : null; }

  // ── Разметка ──────────────────────────────────────────────────────────────
  function swatch(key, shape) {
    return '<span class="sw ' + (shape || 'sq') + ' ch-' + esc(key) + '" aria-hidden="true"></span>';
  }

  // Полоса фильтров под шапкой — как в старом дашборде: быстрые периоды,
  // даты с подписью сверху, группировка «пилюлей». opts.groupings — показать
  // группировку: она одна на все графики экрана, поэтому живёт здесь, а не
  // над каждым графиком.
  function renderFilters(ui, rg, opts) {
    const o = opts || {};
    const btn = p => '<button type="button" class="seg' + (ui.preset === p.key ? ' on' : '') +
      '" data-action="ov-preset" data-preset="' + p.key + '" aria-pressed="' + (ui.preset === p.key) + '">' +
      esc(p.label) + '</button>';
    return '<div class="filters" role="group" aria-label="Период">' +
      '<div class="seg-row quick">' + PRESETS.map(btn).join('') + '</div>' +
      '<div class="dates">' +
        '<div class="f-group"><label class="f-label" for="ovFrom">Дата с</label>' +
          '<input id="ovFrom" type="date" value="' + esc(rg.from) + '"></div>' +
        '<div class="f-group"><label class="f-label" for="ovTo">Дата по</label>' +
          '<input id="ovTo" type="date" value="' + esc(rg.to) + '"></div>' +
      '</div>' +
      (o.groupings ? '<div class="f-group"><span class="f-label" aria-hidden="true">Группировка</span>' +
        renderGroupings(ui.grouping) + '</div>' : '') +
      '</div>';
  }

  // Изменение к прошлому периоду одной строкой: стрелка и знак несут
  // направление, цвет — только подсказка. Сравнивать не с чем — сказано.
  function deltaLine(cur, prev, prg, cls) {
    const c = 'hero-delta' + (cls ? ' ' + cls : '');
    if (!prg || prev === null || prev === undefined) {
      return '<div class="' + c + ' muted">Сравнивать не с чем: период — всё время.</div>';
    }
    if (!(Math.abs(prev) > 0)) {
      return '<div class="' + c + ' muted">За ' + esc(rangeLabel(prg)) + ' выручки не было — сравнивать не с чем.</div>';
    }
    const d = pctOf(cur - prev, Math.abs(prev));
    const up = d >= 0;
    return '<div class="' + c + ' ' + (up ? 'up' : 'down') + '">' +
      '<span aria-hidden="true">' + (up ? '▲' : '▼') + '</span> ' +
      (up ? '+' : '−') + nf1.format(Math.abs(d)) + ' % к ' + esc(rangeLabel(prg)) +
      ' <span class="muted">· было ' + money(prev) + '</span></div>';
  }

  // label — подпись над суммой: «Общая выручка» на «Обзоре», «Выручка Kaspi»
  // на экране Kaspi. parts — разметка под суммой (из чего она сложена);
  // тогда содержимое прижимается к верху карточки, а не висит посередине.
  // opts.bare — без своей карточки: итог стоит внутри квадранта или ленты.
  function renderHero(t, prevT, rg, prg, label, parts, opts) {
    const bare = !!(opts && opts.bare);
    const delta = deltaLine(t.total, prg && prevT ? prevT.total : null, prg);
    return '<' + (bare ? 'div' : 'section') + ' class="' + (bare ? 'hero hero-bare' : 'card hero') +
      (parts ? ' has-parts' : '') + '" aria-labelledby="ovHeroLabel">' +
      '<div class="hero-label" id="ovHeroLabel">' + esc(label || 'Общая выручка') + ' · ' + esc(rangeLabel(rg)) + '</div>' +
      '<div class="hero-value">' + money(t.total) + '</div>' + delta + (parts || '') + '</' + (bare ? 'div' : 'section') + '>';
  }

  // Лента итогов «Обзора» над квадрантами: общая выручка всех каналов с
  // полосой долей и по плитке на канал — сумма, доля, изменение к прошлому
  // периоду. Канал, у которого выручка была только в прошлом периоде, тоже
  // здесь: «0 ₸ ▼ −100 %» честнее, чем пропавшая плитка. Плитки — по убыванию
  // выручки; цвет плитки — цвет канала на графиках.
  function renderRibbon(t, pt, rg, prg, chans) {
    const has = c => Math.abs(t.by[c.key] || 0) > 0 || !!(pt && Math.abs(pt.by[c.key] || 0) > 0);
    const list = chans.filter(has).sort((a, b) => (t.by[b.key] || 0) - (t.by[a.key] || 0));
    const pos = list.filter(c => (t.by[c.key] || 0) > 0);
    const posSum = pos.reduce((a, c) => a + t.by[c.key], 0);
    const bar = pos.length ? '<div class="share-bar" aria-hidden="true">' + pos.map(c =>
      '<span class="share-seg ch-' + esc(c.key) + '" style="flex-grow:' +
      (t.by[c.key] / posSum).toFixed(6) + '"></span>').join('') + '</div>' : '';
    const tile = c => {
      const v = t.by[c.key] || 0;
      const pv = pt ? pt.by[c.key] || 0 : null;
      const d = prg && pt && Math.abs(pv) > 0 ? pctOf(v - pv, Math.abs(pv)) : null;
      const dl = d === null ? '' : '<span class="rb-delta ' + (d >= 0 ? 'up' : 'down') + '"><span aria-hidden="true">' +
        (d >= 0 ? '▲' : '▼') + '</span> ' + (d >= 0 ? '+' : '−') + nf1.format(Math.abs(d)) + ' %</span>';
      return '<div class="rb-ch ch-' + esc(c.key) + (c.other ? ' rb-other' : '') + '">' +
        '<div class="rb-name">' + swatch(c.key) + esc(c.label) + '</div>' +
        '<div class="rb-val">' + money(v) + '</div>' +
        '<div class="rb-sub"><span class="rb-share">' + C.pct(pctOf(v, t.total)) + '</span>' + dl + '</div></div>';
    };
    return '<div class="ribbon" id="ovRibbon">' +
      '<div class="rb-total">' + renderHero(t, pt, rg, prg, 'Общая выручка', bar, { bare: true }) + '</div>' +
      (list.length ? list.map(tile).join('') : '<div class="rb-ch rb-empty">' + C.empty('За период выручки нет.') + '</div>') +
      '</div>';
  }

  // Квадранты A и B «Обзора»: один канал — сумма за период, изменение к
  // прошлому, заказы и средний чек. Источник тот же, что у ленты итогов
  // (snap_overview_daily), поэтому сумма плитки равна плитке канала в ленте.
  function channelStats(rows, key, rg, prg) {
    const sum = r0 => {
      const t = { revenue: 0, gross: 0, orders: 0 };
      rows.forEach(r => {
        if (r.channel !== key || !inRange(r, r0)) return;
        t.revenue += num(r.revenue); t.gross += num(r.gross); t.orders += num(r.orders);
      });
      return t;
    };
    const cur = sum(rg);
    return Object.assign(cur, { prev: prg ? sum(prg) : null, prg,
                                avgCheck: cur.orders > 0 ? cur.gross / cur.orders : null });
  }
  function renderChannelStat(st) {
    return '<div class="qp-stat">' +
      '<div class="qp-big">' + money(st.revenue) + '</div>' +
      deltaLine(st.revenue, st.prev ? st.prev.revenue : null, st.prg, 'qp-delta') +
      '<div class="qp-meta">' + C.int(st.orders) + ' ' + plural(st.orders, 'заказ', 'заказа', 'заказов') +
        (st.avgCheck === null ? '' : ' · средний чек ' + money(st.avgCheck)) + '</div></div>';
  }
  // Подсказка столбика канала: выручка, заказы, средний чек.
  function channelTooltipHtml(e, key) {
    const v = e.by[key] || 0;
    return '<div class="tip-head">' + esc(e.label) + (e.current ? ' · идёт' : '') + '</div>' +
      '<div class="tip-total"><b>' + money(v) + '</b> <span class="muted">выручка</span></div>' +
      '<div class="tip-row"><b>' + C.int(e.orders) + '</b> <span class="muted">' + plural(e.orders, 'заказ', 'заказа', 'заказов') + '</span></div>' +
      (e.orders > 0 ? '<div class="tip-row"><b>' + money(e.gross / e.orders) + '</b> <span class="muted">средний чек</span></div>' : '');
  }
  function plural(n, one, few, many) {
    const a = Math.abs(Math.round(n)) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    return b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  }

  function renderLegend(chans, hidden, present) {
    return '<div class="legend" role="group" aria-label="Каналы на графике">' + chans
      .filter(c => present[c.key])
      .map(c => '<button type="button" class="chip' + (hidden[c.key] ? ' off' : '') +
        '" data-action="ov-ch" data-ch="' + esc(c.key) + '" aria-pressed="' + !hidden[c.key] + '">' +
        swatch(c.key) + esc(c.label) + '</button>').join('') + '</div>';
  }

  function renderGroupings(g) {
    return '<div class="seg-row pill" role="group" aria-label="Группировка">' + GROUPINGS.map(x =>
      '<button type="button" class="seg' + (g === x.key ? ' on' : '') + '" data-action="ov-group" data-group="' +
      x.key + '" aria-pressed="' + (g === x.key) + '">' + esc(x.label) + '</button>').join('') + '</div>';
  }

  // Путь столбика с круглым ВЕРХОМ и прямым низом: у основания всё ровно,
  // скругление только на конце данных.
  function topRounded(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h));
    const f = n => Math.round(n * 100) / 100;
    return 'M' + f(x) + ',' + f(y + h) + 'V' + f(y + r) + 'Q' + f(x) + ',' + f(y) + ' ' + f(x + r) + ',' + f(y) +
      'H' + f(x + w - r) + 'Q' + f(x + w) + ',' + f(y) + ' ' + f(x + w) + ',' + f(y + r) + 'V' + f(y + h) + 'Z';
  }

  // Столбики по каналам в стопку. Отрицательный день (возвраты больше
  // выдачи) рисуется нулём — шкала одна и от нуля, — а точная сумма со знаком
  // живёт в подсказке и в таблице ниже. noun — что в столбиках, для чтения
  // с экрана: «Выручка» по умолчанию, «Заказы» у «Аналитики».
  // opts.id — id графика (по умолчанию ovChart: главный график экрана, его
  // ищут тесты и подсказка), opts.height — высота: в квадранте график
  // растягивается на всю свободную высоту, на телефоне — 250 px, как раньше.
  // opts.tail — последняя фраза описания для чтения с экрана.
  function renderChart(series, chans, hidden, width, grouping, noun, opts) {
    const o = opts || {};
    const id = o.id || 'ovChart', tipId = id === 'ovChart' ? 'ovTip' : id + 'Tip';
    const vis = chans.filter(c => !hidden[c.key]);
    const W = Math.max(300, Math.round(width || 640)), H = Math.max(150, Math.round(o.height || 250));
    const padL = 58, padR = 10, padT = 26, padB = 28;
    const iw = W - padL - padR, ih = H - padT - padB, base = padT + ih;
    const n = series.length;
    const tops = series.map(e => vis.reduce((a, c) => a + Math.max(0, e.by[c.key] || 0), 0));
    const max = niceMax(Math.max(0, ...tops));
    const band = iw / Math.max(1, n);
    const bw = Math.max(1, Math.min(24, band * 0.72));
    const GAP = 2;
    const y = v => base - v / max * ih;
    const rec = recordIndex(series.map((e, i) => Object.assign({}, e, { total: tops[i] })));

    let grid = '';
    [0, 0.5, 1].forEach(k => {
      const yy = Math.round(y(max * k)) + 0.5;
      grid += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '"/>' +
        '<text class="tick" x="' + (padL - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + esc(compact(max * k)) + '</text>';
    });

    let bars = '';
    series.forEach((e, i) => {
      const x = padL + i * band + (band - bw) / 2;
      let acc = 0;
      const segs = vis.map(c => ({ c, v: Math.max(0, e.by[c.key] || 0) })).filter(s => s.v > 0);
      segs.forEach((s, k) => {
        const h = s.v / max * ih;
        const top = base - acc - h;
        const hh = h - (k > 0 ? GAP : 0);
        acc += h;
        if (hh < 0.75) return;             // тоньше пикселя — видно в подсказке и таблице
        const cls = 'bar ch-' + esc(s.c.key) + (e.current ? ' live' : '');
        bars += k === segs.length - 1
          ? '<path class="' + cls + '" d="' + topRounded(x, top, bw, hh, 4) + '"/>'
          : '<rect class="' + cls + '" x="' + x.toFixed(2) + '" y="' + top.toFixed(2) + '" width="' + bw.toFixed(2) +
            '" height="' + hh.toFixed(2) + '"/>';
      });
    });

    // Подпись одна — у рекорда. Число над каждым столбиком не читает никто.
    let label = '';
    if (rec >= 0) {
      const cx = padL + rec * band + band / 2;
      const anchor = cx < padL + 40 ? 'start' : cx > W - padR - 40 ? 'end' : 'middle';
      label = '<text class="rec" x="' + cx.toFixed(1) + '" y="' + (y(tops[rec]) - 6).toFixed(1) + '" text-anchor="' + anchor + '">' +
        'рекорд · ' + esc(compact(tops[rec])) + '</text>';
    }

    // Подписи по оси X — не больше восьми, равномерно, последний всегда.
    // Шаг ещё и не меньше ширины подписи с зазором: на телефоне месяц по
    // дням — полоса в 11 px, а «05.09» шириной в 32, и соседние подписи
    // слипались. Влезает подпись в свою полосу (месяцы на широком экране) —
    // по центру столбика; не влезает — крайние прижаты к краям, чтобы не
    // обрезаться об рамку.
    let xl = '';
    const labelW = Math.max(0, ...series.map(e => String(e.label).length * 6.3));
    const step = Math.max(1, Math.ceil(n / 8), Math.ceil((labelW + 12) / band));
    const fits = series.every(e => String(e.label).length * 6.3 <= band * 0.95);
    series.forEach((e, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      // не налезать на последний: ближе полного шага к нему — пропуск. С
      // «половиной шага» на телефоне «25.09» и «27.09» ложились друг на друга.
      if (i !== n - 1 && n - 1 - i < step) return;
      const cx = padL + i * band + band / 2;
      const anchor = fits || n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      const tx = anchor === 'start' ? padL + i * band : anchor === 'end' ? padL + (i + 1) * band : cx;
      xl += '<text class="tick" x="' + tx.toFixed(1) + '" y="' + (base + 18) + '" text-anchor="' + anchor + '">' +
        esc(e.label) + '</text>';
    });

    // Мишень наведения — вся полоса столбика по высоте, а не закрашенные
    // пиксели: в тонкий дневной столбик мышью не попасть.
    let hits = '';
    series.forEach((e, i) => {
      hits += '<rect class="hit" data-i="' + i + '" x="' + (padL + i * band).toFixed(2) + '" y="' + padT +
        '" width="' + band.toFixed(2) + '" height="' + ih + '"/>';
    });

    const summary = (noun || 'Выручка') + ' по ' + ({ day: 'дням', week: 'неделям', decade: 'декадам', month: 'месяцам' })[grouping || 'day'] +
      ', ' + n + ' столбцов. ' + (o.tail || 'Точные ' + (noun ? 'числа' : 'суммы') + ' — в таблице ниже.');
    return '<div class="chart" id="' + esc(id) + '" tabindex="0" aria-label="' + esc(summary) + '">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="' + esc(summary) + '">' +
      grid + '<line class="axis" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (base + 0.5) + '" y2="' + (base + 0.5) + '"/>' +
      bars + label + xl + '<g class="hits">' + hits + '</g></svg>' +
      '<div class="tip" id="' + esc(tipId) + '" role="status" hidden></div></div>';
  }

  // Подсказка: сначала сумма, потом канал — читатель уже знает, где он, ему
  // нужно число. Ключ канала — короткая линия его цвета, не квадрат.
  function tooltipHtml(e, chans, hidden) {
    const rows = chans.filter(c => !hidden[c.key] && (e.by[c.key] || 0) !== 0).map(c =>
      '<div class="tip-row">' + swatch(c.key, 'line') + '<b>' + money(e.by[c.key]) + '</b> <span class="muted">' +
      esc(c.label) + '</span></div>').join('');
    return '<div class="tip-head">' + esc(e.label) + (e.current ? ' · идёт' : '') + '</div>' +
      '<div class="tip-total"><b>' + money(chans.filter(c => !hidden[c.key]).reduce((a, c) => a + (e.by[c.key] || 0), 0)) +
      '</b> <span class="muted">всего</span></div>' + (rows || '<div class="muted">выручки нет</div>');
  }

  // Таблица периодов — табличный двойник графика и контрольная цифра: итог
  // внизу обязан совпасть с крупной суммой сверху. Разошлись — значит бакеты
  // потеряли день, и это видно сразу.
  function renderTable(series, chans) {
    if (!series.length) return C.empty('За период нет данных.');
    const cols = chans.filter(c => series.some(e => (e.by[c.key] || 0) !== 0));
    const head = '<tr><th scope="col">Период</th><th scope="col">Выручка</th><th scope="col">Δ к пред.</th>' +
      '<th scope="col">Δ, %</th>' + cols.map(c => '<th scope="col">' + esc(c.label) + '</th>').join('') + '</tr>';
    const body = series.map((e, i) => {
      const p = i > 0 ? series[i - 1].total : null;
      const d = p === null ? null : e.total - p;
      const dp = p === null || !p ? null : 100 * d / Math.abs(p);
      const cls = v => (v === null ? 'muted' : v >= 0 ? 'good' : 'bad');
      return '<tr' + (e.current ? ' class="live-row"' : '') + '><th scope="row">' + esc(e.label) +
        (e.current ? ' <span class="live-tag">· идёт</span>' : '') + '</th>' +
        '<td class="num strong">' + money(e.total) + '</td>' +
        '<td class="num ' + cls(d) + '">' + (d === null ? '—' : signedMoney(d)) + '</td>' +
        '<td class="num ' + cls(dp) + '">' + (dp === null ? '—' : (dp >= 0 ? '+' : '−') + nf1.format(Math.abs(dp)) + ' %') + '</td>' +
        cols.map(c => { const v = e.by[c.key] || 0; return '<td class="num' + (v ? '' : ' muted') + '">' + (v ? money(v) : '—') + '</td>'; }).join('') +
        '</tr>';
    }).reverse().join('');
    const grand = series.reduce((a, e) => a + e.total, 0);
    const foot = '<tr class="total-row"><th scope="row">Итого</th><td class="num strong">' + money(grand) + '</td><td></td><td></td>' +
      cols.map(c => '<td class="num">' + money(series.reduce((a, e) => a + (e.by[c.key] || 0), 0)) + '</td>').join('') + '</tr>';
    return '<div class="table-scroll tall"><table class="grid sticky-first"><thead>' + head + '</thead><tbody>' +
      body + '</tbody><tfoot>' + foot + '</tfoot></table></div>';
  }

  function renderGaps(gaps) {
    if (!gaps || !gaps.length) return '';
    return '<section class="card gaps" role="note" aria-labelledby="ovGapsTitle">' +
      '<div class="card-head"><h2 id="ovGapsTitle"><span aria-hidden="true">⚠</span> Не вошло в выручку</h2>' +
      '<div class="card-sub">Эти суммы есть в источниках, но системе не хватило даты, суммы или однозначного статуса. Чинится в источнике.</div></div>' +
      '<ul class="notes">' + gaps.map(g => '<li>' + esc(g.what) + ': ' + C.int(g.rows) + ' шт. · ' + money(g.amount) + '</li>').join('') +
      '</ul></section>';
  }

  function renderNotes() {
    return '<ul class="notes">' +
      '<li><b>Kaspi</b> — выдано по дню выдачи, минус возвраты выданных по дню возврата, плюс удалённые оплаты по дню оплаты (без комиссии). Как в старом «Обзоре».</li>' +
      '<li><b>Ozon</b> — продажи минус возвраты по начислениям Ozon, в день начисления: ровно «Продажи» и «Возвраты» отчёта кабинета «Начисления». Опрос раз в 4 часа, поэтому сегодняшний день по нему догоняет позже Kaspi.</li>' +
      '<li><b>Wildberries</b> — выкупы минус возвраты выкупленного, по дню операции, из приёма по API. Опрос раз в 4 часа.</li>' +
      '<li><b>B2B</b> — оплаты аптек и магазинов по дню оплаты: деньги пришли — выручка есть.</li>' +
      '<li><b>Teez</b> — выдано по дню выдачи, из зеркала Apps Script.</li>' +
      '<li>Последний период помечен «· идёт»: незакрытый день или месяц всегда ниже закрытого, это не падение.</li>' +
      '<li>«Заказано» (выдано + в пути) пока не переносилось — оно есть в старом «Обзоре».</li>' +
    '</ul>';
  }

  root.NietteOverview = {
    CHANNELS, PRESETS, GROUPINGS,
    todayIso, addDays, spanDays, presetRange, prevRange, bucketOf, monthsSpanned, rangeLabel,
    minDay, channelsOf, totals, buildSeries, recordIndex, compact, niceMax, topRounded,
    renderFilters, renderHero, renderRibbon, renderLegend, renderGroupings, renderChart, deltaLine,
    channelStats, renderChannelStat, channelTooltipHtml, plural,
    tooltipHtml, renderTable, renderGaps, renderNotes
  };
})(typeof window !== 'undefined' ? window : globalThis);
