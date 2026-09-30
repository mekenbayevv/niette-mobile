/* Экран «Склад» на снимках Postgres: расчёты и разметка.
 *
 * Как kaspi.js и ozon.js — только чистые функции: строки снимков на вход,
 * числа и строка HTML на выход. Сеть, состояние и события — в app.js.
 * Проверяется в Node (tests/app_stock_test.js).
 *
 * Источники (sql/23_stock_screen.sql):
 *   snap_stock            строка на строку листа «Склад»: остаток и из чего он
 *                         сложился — ровно восемь расчётных колонок старого
 *                         дашборда (22 доказан равным ему, 13 строк из 13)
 *   snap_stock_writeoffs  журнал списаний за 90 дней
 *   v_stock_freshness     когда приехали лист «Склад» и продажи
 *
 * Первая редакция экрана = старый таб по СТАРЫМ определениям (⚑ — в
 * renderNotes и в шапке sql/22). Группы, короткие имена и цвета сроков
 * перенесены из Dashboard.html (invSkuGroup, invSkuDisplayName, invStatus),
 * чтобы экраны читались одинаково, пока живут рядом.
 */
(function (root) {
  'use strict';

  const C = root.NietteClients;
  const esc = C.esc, int = C.int, isNum = C.isNum;
  const NBSP = '\u00a0';   // U+00A0 escape-последовательностью: сам символ невидим и теряется при записи файла
  const nf01 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const INF = 999;                         // так старый код пишет «расхода нет»
  const GROUPS = ['Упаковки', 'Минипаки', 'Другое'];

  function num(v) { return isNum(v) ? Number(v) : 0; }
  // Штуки: остаток бывает дробным (дробное количество в продаже), старый таб
  // показывал его как есть — «42,5», а не округлял.
  function qty(v) { return isNum(v) ? nf01.format(Number(v)) : '—'; }
  function plural(n, one, few, many) {
    const a = Math.abs(Math.round(n)) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    return b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  }
  function packQty(name) {
    const m = String(name || '').toLowerCase().match(/(\d+)\s*шт/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // ── Группа и короткое имя — как invSkuGroup / invSkuDisplayName ──────────
  function groupOf(name) {
    const n = String(name || '').toLowerCase();
    if (n.indexOf('подгузник') !== -1) {
      const q = packQty(name);
      return q > 0 && q < 10 ? 'Минипаки' : 'Упаковки';
    }
    return 'Другое';
  }

  function displayName(name, sku) {
    const full = String(name || sku || '');
    const n = full.toLowerCase();
    const m = full.match(/\b(XXL|XL|L|M|S)\b/i);
    const size = m ? m[1].toUpperCase() : '';
    if (n.indexOf('подгузник') !== -1) {
      const q = packQty(full);
      if (q >= 10) return 'Упаковка' + (size ? ' ' + size : '');
      if (q > 0) return 'Минипак' + (size ? ' ' + size : '');
      return size ? 'Упаковка ' + size : full;
    }
    if (n.indexOf('салфетк') !== -1) return 'Влажные салфетки';
    if (n.indexOf('плед') !== -1) return 'Плед';
    if (n.indexOf('гифт') !== -1 || n.indexOf('gift') !== -1 ||
        (n.indexOf('бокс') !== -1 && n.indexOf('подгузник') === -1)) return 'Гифтбокс';
    return full;
  }

  // ── Сроки — как invStatus / invEndDate ────────────────────────────────────
  function days(r) { return isNum(r.days_remaining) ? Number(r.days_remaining) : INF; }
  function status(d) { return d < 7 ? 'bad' : d < 14 ? 'warn' : 'good'; }
  function daysLabel(d) {
    if (d === INF) return '∞ дней';
    return int(d) + NBSP + 'дн' + (d < 7 ? ' — срочно' : d < 14 ? ' — внимание' : '');
  }
  // Год — когда дата не в этом году. Старый таб пишет только день и месяц, и
  // 30.09.2026 «Минипак M: 369 дн — закончится ~4 окт.» читалось как «через
  // четыре дня», хотя это октябрь 2027-го.
  function endDate(d, now) {
    if (d === INF) return '∞';
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    return t.toLocaleDateString('ru-RU', t.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function byDays(a, b) { return days(a) - days(b) || a.pos - b.pos; }

  // ── Сводка — как renderInventoryKpi ───────────────────────────────────────
  // «Списано за 30 дней» — по журналу, а не по колонке строки: так и в старом
  // табе, и журнал видит строки, чей SKU на «Складе» не нашёлся.
  function isoDay(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function woff30(list, now) {
    const from = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29));
    return (list || []).filter(w => w.day && String(w.day) >= from);
  }

  // woffs === null — журнал не загрузился: списания прочерком, а не нулём.
  function kpis(rows, woffs, now) {
    const finite = rows.filter(r => days(r) !== INF && num(r.avg_daily_rate) > 0);
    const w = woffs === null ? [] : woff30(woffs, now);
    const people = new Set(w.map(x => x.taken_by).filter(Boolean));
    const counts = rows.map(r => r.count_date).filter(Boolean).sort();
    return {
      items: rows.length,
      total: rows.reduce((s, r) => s + num(r.current_stock), 0),
      critical: rows.filter(r => days(r) < 7).length,
      warn: rows.filter(r => days(r) >= 7 && days(r) < 14).length,
      avgDays: finite.length ? Math.round(finite.reduce((s, r) => s + days(r), 0) / finite.length) : null,
      woffQty: woffs === null ? null : w.reduce((s, x) => s + num(x.qty), 0), woffN: w.length, woffPeople: people.size,
      countFrom: counts[0] || null, countTo: counts[counts.length - 1] || null
    };
  }

  function dm(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : '—';
  }

  function card(label, value, sub, tone) {
    return '<div class="kpi' + (tone ? ' kpi-' + tone : '') + '">' +
      '<div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-value">' + value + '</div>' +
      (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div>';
  }

  function renderKpis(k) {
    const counted = k.countFrom
      ? 'пересчёт ' + (k.countFrom === k.countTo ? dm(k.countFrom) : dm(k.countFrom) + '–' + dm(k.countTo))
      : 'пересчёта нет';
    return '<div class="kpi-grid">' +
      card('На складе', qty(k.total) + NBSP + 'шт', int(k.items) + ' ' + plural(k.items, 'товар', 'товара', 'товаров') + ' · ' + counted) +
      card('Срочно', int(k.critical) + NBSP + 'SKU', 'хватит меньше чем на неделю', k.critical ? 'bad' : '') +
      card('Внимание', int(k.warn) + NBSP + 'SKU', 'от недели до двух', k.warn ? 'warn' : '') +
      card('В среднем хватит', isNum(k.avgDays) ? int(k.avgDays) + NBSP + 'дн' : '—', 'по товарам с расходом') +
      (isNum(k.woffQty)
        ? card('Списано за 30 дней', qty(k.woffQty) + NBSP + 'шт',
               k.woffQty > 0 ? int(k.woffN) + ' ' + plural(k.woffN, 'запись', 'записи', 'записей') + ' · ' +
                               int(k.woffPeople) + NBSP + 'чел.' : 'мимо продаж')
        : card('Списано за 30 дней', '—', 'журнал не загрузился')) +
    '</div>';
  }

  // ── Что не сходится — как блок сверки старого таба ───────────────────────
  function problems(rows) {
    return {
      deficits: rows.filter(r => num(r.deficit) > 0),
      noDate: rows.filter(r => r.no_count_date)
    };
  }

  function renderProblems(p) {
    if (!p.deficits.length && !p.noDate.length) return '';
    const items = [];
    if (p.deficits.length) {
      items.push('<li><b>Расход превысил пересчёт</b> у ' + int(p.deficits.length) + ' ' +
        plural(p.deficits.length, 'товара', 'товаров', 'товаров') + ': ' +
        p.deficits.map(r => esc(displayName(r.name, r.sku)) + ' −' + qty(r.deficit)).join(', ') +
        '. Физически так не бывает: после пересчёта не внесён приход, пересчёт устарел или расход вычтен дважды. Остаток показан нулём.</li>');
    }
    if (p.noDate.length) {
      items.push('<li><b>Без даты пересчёта</b> — ' + p.noDate.map(r => esc(displayName(r.name, r.sku))).join(', ') +
        ': расход по ним не вычитается вовсе, остаток равен пересчёту.</li>');
    }
    return '<section class="card gaps" role="status"><h2>Что не сходится</h2><ul class="notes">' + items.join('') + '</ul></section>';
  }

  // ── Карточки по группам — как renderInvSkuGrid ────────────────────────────
  function skuCard(r, now) {
    const d = days(r), st = status(d);
    const pct = d === INF ? 100 : Math.max(0, Math.min(100, Math.round(d / 30 * 100)));
    const rate = num(r.avg_daily_rate) > 0 ? qty(r.avg_daily_rate) + NBSP + 'шт/день' : 'расхода нет';
    return '<article class="sku-card st-' + st + '">' +
      '<div class="sku-name" title="' + esc(r.name || r.sku || '') + '">' + esc(displayName(r.name, r.sku)) + '</div>' +
      '<div class="sku-value">' + qty(r.current_stock) + '</div>' +
      '<div class="sku-unit">шт на складе</div>' +
      '<div class="sku-track" aria-hidden="true"><div class="sku-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="sku-row"><span class="sku-days">' + esc(daysLabel(d)) + '</span><span class="sku-rate">' + rate + '</span></div>' +
      '<div class="sku-end">Закончится ~' + esc(endDate(d, now)) + '</div>' +
      (num(r.deficit) > 0 ? '<div class="sku-note bad">Расход больше пересчёта на ' + qty(r.deficit) + NBSP + 'шт</div>' : '') +
      (r.no_count_date ? '<div class="sku-note warn">Нет даты пересчёта — расход не вычитается</div>' : '') +
      (num(r.written_off_30) > 0 ? '<div class="sku-note">Списано за 30 дней: ' + qty(r.written_off_30) + NBSP + 'шт</div>' : '') +
    '</article>';
  }

  function renderCards(rows, now) {
    if (!rows.length) return C.empty('Лист «Склад» пуст — пересчёт не внесён.');
    return GROUPS.map(g => {
      const items = rows.filter(r => groupOf(r.name || r.sku) === g).sort(byDays);
      if (!items.length) return '';
      const total = items.reduce((s, r) => s + num(r.current_stock), 0);
      return '<div class="sku-group"><h3 class="sku-group-title">' + esc(g) +
        ' <span class="muted">' + int(items.length) + NBSP + 'SKU · ' + qty(total) + NBSP + 'шт</span></h3>' +
        '<div class="sku-grid">' + items.map(r => skuCard(r, now)).join('') + '</div></div>';
    }).join('');
  }

  // ── Как сложился остаток — расчётные колонки листа «Склад» ────────────────
  // Сверять со старым можно глазами: колонки те же и в том же порядке, что
  // на листе, только «Расход Kaspi» назван честно — это все маркетплейсы.
  function renderTable(rows) {
    if (!rows.length) return C.empty('Строк нет.');
    const cell = (v, cls) => '<td class="num' + (cls ? ' ' + cls : '') + '">' + v + '</td>';
    const signed = (v, sign) => num(v) ? sign + qty(v) : '<span class="muted">0</span>';
    const body = rows.slice().sort((a, b) => a.pos - b.pos).map(r =>
      '<tr><th class="who">' + esc(displayName(r.name, r.sku)) +
        '<div class="where">' + esc(r.sku || 'без SKU') + '</div></th>' +
        cell(qty(r.count_qty) + '<div class="where">' + (r.count_date ? dm(r.count_date) : 'нет даты') + '</div>') +
        cell(signed(r.arrived_since, '+')) +
        cell(signed(r.sold_mp_since, '−')) +
        cell(signed(r.sold_b2b_since, '−')) +
        cell(signed(r.bundled_since, '−')) +
        cell(signed(r.written_off_since, '−')) +
        cell(qty(r.current_stock), 'strong') +
        cell(num(r.deficit) > 0 ? '−' + qty(r.deficit) : '<span class="muted">—</span>', num(r.deficit) > 0 ? 'bad' : '') +
        cell(num(r.avg_daily_rate) > 0 ? qty(r.avg_daily_rate) : '<span class="muted">—</span>') +
        cell(days(r) === INF ? '∞' : int(days(r)), status(days(r))) +
      '</tr>').join('');
    return '<div class="table-scroll"><table class="grid sticky-first"><thead><tr>' +
      '<th>Товар</th><th>Пересчёт</th><th>Приход</th><th>Маркетплейсы</th><th>B2B</th><th>Вложено</th>' +
      '<th>Списано</th><th>Остаток</th><th>Дефицит</th><th>Расход в день</th><th>Дней</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  // ── Журнал списаний за 30 дней ────────────────────────────────────────────
  function renderWriteoffs(list, now) {
    const rows = woff30(list, now).slice().sort((a, b) => String(b.day).localeCompare(String(a.day)));
    if (!rows.length) return C.empty('За 30 дней списаний не было.');
    return '<div class="table-scroll"><table class="grid"><thead><tr>' +
      '<th>Дата</th><th class="txt">Товар</th><th>Штук</th><th class="txt">Причина</th>' +
      '<th class="txt">Кто взял</th><th class="txt">Кто внёс</th>' +
      '</tr></thead><tbody>' + rows.map(w =>
        '<tr><td>' + esc(dm(w.day)) + '</td>' +
        '<td class="wrap">' + esc(w.name ? displayName(w.name, w.sku) : (w.sku || '—')) + '</td>' +
        '<td class="num">' + qty(w.qty) + '</td>' +
        '<td class="wrap">' + esc(w.reason || '—') + '</td>' +
        '<td>' + esc(w.taken_by || '—') + '</td>' +
        '<td>' + esc(w.added_by || '—') + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  function renderNotes() {
    return '<ul class="notes">' +
      '<li><b>Остаток</b> = пересчёт + приходы − продажи − B2B − вложено в упаковки − списано, всё после даты пересчёта. Ровно так считает старый таб: цифры сверены с листом «Склад», 13 строк из 13 (29.09.2026).</li>' +
      '<li><b>Маркетплейсы</b> — в старом табе колонка «Расход Kaspi», но в ней все площадки: Kaspi, Ozon и WB. Teez не вычитается.</li>' +
      '<li><b>Ozon FBO и WB</b> сейчас вычитаются в день продажи покупателю, хотя коробка ушла со склада раньше — в день отгрузки на площадку. Пока отгрузки нигде не фиксируются, остаток врёт в обе стороны. Следующий шаг — отгрузки по API и отдельной строкой разница со старым расчётом.</li>' +
      '<li><b>Вложено</b> — пачки салфеток, которые едут в каждой большой упаковке с 25.07.2026 (лист «Довески»). Входят и в остаток, и в расход в день.</li>' +
      '<li><b>Расход в день</b> — продажи, B2B и вложения за 30 дней, включая сегодня. Списания в него не входят: разовый брак не должен сдвигать дату обнуления.</li>' +
      '<li><b>Приход</b> вносят в старом дашборде, на табе «Склад»; сюда он приезжает с синхронизацией таблицы. Не внесённая после пересчёта партия занижает остаток на всю партию.</li>' +
      '<li>Пока нет: остатков на площадках (WB, Ozon FBO и FBS), сверки и расхода по точкам Kaspi, форм прихода и списания — они переедут следующими шагами.</li>' +
    '</ul>';
  }

  root.NietteStock = {
    INF, GROUPS, groupOf, displayName, status, daysLabel, endDate, kpis, woff30, problems,
    renderKpis, renderProblems, renderCards, renderTable, renderWriteoffs, renderNotes
  };
})(typeof window !== 'undefined' ? window : globalThis);
