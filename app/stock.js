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
 *   snap_stock_recon      сверка (sql/24): какой расход не доехал до остатка и
 *                         сколько ушло с каждого склада Kaspi — отчёт на окно
 *                         30 и 90 дней, той же формы, что inventoryHealthReport_
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
  // rep — отчёт сверки (sql/24) или null: «не вычлось с пересчёта» не зависит
  // от окна, поэтому годится любой из двух.
  function problems(rows, rep) {
    const sc = rep && !rep.fatal && rep.sinceCount ? rep.sinceCount : null;
    return {
      deficits: rows.filter(r => num(r.deficit) > 0),
      noDate: rows.filter(r => r.no_count_date),
      notDeducted: sc && sc.lost ? num(sc.lost.total) : 0,
      countDate: sc ? sc.date : null,
      upperBound: !!sc && sc.exact === false
    };
  }

  function renderProblems(p) {
    if (!p.deficits.length && !p.noDate.length && !p.notDeducted) return '';
    const items = [];
    if (p.notDeducted) {
      items.push('<li><b>Не вычлось с пересчёта ' + qty(p.notDeducted) + NBSP + 'шт</b>' +
        (p.countDate ? ' (с ' + dm(p.countDate) + ')' : '') +
        ' — продажи и отгрузки, которые не сошлись с листом «Склад». ' +
        (p.upperBound ? 'Остаток выше реального не больше чем на столько: даты пересчёта у строк разные. '
                      : 'На столько остаток выше реального. ') +
        'Разбор — в «Сверке» ниже.</li>');
    }
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

  // ── Сверка: какой расход не доехал до остатка (sql/24) ─────────────────────
  // Порт renderInvHealth и renderInvPoints старого таба. Отчёт той же формы,
  // что отдавал inventoryHealthReport_ (24 доказан равным ему на 121
  // проверке), строка снимка на окно: 30 и 90 дней.
  const PLAT = { kaspi: 'Kaspi', ozon: 'Ozon', wb: 'Wildberries', teez: 'Teez' };

  function reconFor(list, win) {
    const r = (list || []).find(x => Number(x.window_days) === Number(win));
    if (!r) return null;
    return typeof r.report === 'string' ? JSON.parse(r.report) : r.report;
  }

  // Первый день окна. Старый отчёт отдаёт since = «сейчас минус N суток», и
  // в окно попадают дни ПОСЛЕ этой даты — старый таб подписывал «с 31.08», а
  // считал с 01.09. Здесь подпись совпадает с тем, что посчитано.
  function winFrom(rep) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(rep && rep.since || ''));
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
  }

  function winToolbar(win) {
    const b = w => '<button type="button" data-action="st-win" data-win="' + w + '" aria-pressed="' + (win === w) +
      '" class="seg' + (win === w ? ' on' : '') + '">' + w + NBSP + 'дней</button>';
    return '<div class="toolbar" role="group" aria-label="Окно сверки">' + b(30) + b(90) + '</div>';
  }

  function alertBox(tone, html) { return '<div class="st-alert st-alert-' + tone + '">' + html + '</div>'; }
  function subhead(t) { return '<h3 class="st-subhead">' + esc(t) + '</h3>'; }
  function pcs(v) { return qty(Math.round(num(v))) + NBSP + 'шт'; }

  function reconSub(rep, win) {
    if (!rep || rep.fatal) return 'окно ' + win + NBSP + 'дней';
    const sc = rep.sinceCount || {};
    return 'окно ' + win + NBSP + 'дней, с ' + winFrom(rep) +
      (sc.date ? ' · завышение остатка — с пересчёта ' + dm(sc.date) : '');
  }

  function renderRecon(rep, win) {
    if (!rep) return C.empty('Сверки в снимке нет — выполните sql/24_stock_recon.sql.');
    if (rep.fatal) return '<div class="error" role="alert">' + esc(rep.fatal) + '</div>';
    const H = [];
    const map = rep.mapping || {}, b = rep.b2b || {}, inv = rep.inventory || {};
    const sc = rep.sinceCount || {}, scl = sc.lost || {}, lost = rep.lost || {};
    const scLost = num(scl.total), winLost = num(lost.total);

    // Справочники — первыми: без них сопоставление не работает вовсе, и это
    // объясняет расхождение раньше любых других причин.
    if (!map.ready) {
      H.push(alertBox('bad', '<b>Справочники сопоставления пусты.</b> Листов «Артикулы» (' + int(map.aliasRows) +
        ' ' + plural(map.aliasRows, 'строка', 'строки', 'строк') + ') или «Комплекты» (' + int(map.kitRows) +
        ') нет или они пусты — артикулы площадок не переводятся в SKU склада, и расход Ozon и WB не вычитается. ' +
        'Выполнить <code>setupInventoryMapping</code> в редакторе Apps Script.'));
    }
    if (!map.nomenSkuCol && num(b.unmatchedQty) > 0) {
      H.push(alertBox('bad', '<b>В «Номенклатуре» нет колонки «SKU склада»</b> — расход B2B не вычитается. «Код» для ' +
        'этого не годится: там бухгалтерский код для счетов, а остаток сходится по артикулу Kaspi. ' +
        'Выполнить <code>setupInventoryMapping</code>.'));
    } else if (map.nomenSkuCol && !num(map.nomenCodes) && num(b.unmatchedQty) > 0) {
      H.push(alertBox('warn', '<b>Колонка «SKU склада» в «Номенклатуре» пуста.</b> B2B сравнивается по названию, а ' +
        'названия в отгрузке и на складе разные — расход не вычитается.'));
    }
    if ((map.nomenBad || []).length) {
      H.push(alertBox('warn', '<b>В «Номенклатуре» SKU, которого нет на складе: ' + int(map.nomenBad.length) + '.</b> ' +
        'По этим позициям расход не вычтется — опечатка или чужая нумерация: ' +
        esc(map.nomenBad.slice(0, 8).map(x => x.name + ' → ' + x.sku).join(', '))));
    }

    // Итог. Зелёный — только когда чисто и за окно, и с пересчёта: старый таб
    // показывал «всё сматчилось» по одному окну, даже если с пересчёта что-то
    // не вычлось.
    if (!winLost && !scLost) {
      H.push(alertBox('ok', '<b>Весь расход сошёлся с листом «Склад».</b> И за ' + win + NBSP +
        'дней, и с пересчёта остаток вычитается по всем площадкам и B2B.'));
    } else {
      H.push('<div class="kpi-grid st-recon-kpis">' +
        card('Остаток завышен на', pcs(scLost),
             'не вычлось с пересчёта' + (sc.date ? ' ' + dm(sc.date) + ', ' + int(sc.days) + NBSP + 'дн назад' : ''),
             scLost > 0 ? 'bad' : '') +
        card('Не сошлось за ' + win + NBSP + 'дней', pcs(winLost), 'мера качества сопоставления', winLost > 0 ? 'warn' : '') +
        card('Маркетплейсы', pcs(lost.marketplaces), 'артикул не найден на «Складе»') +
        card('Без артикула', pcs(lost.noSku), 'пустой артикул в продаже') +
        card('B2B', pcs(lost.b2b), 'позиция отгрузки не сошлась') +
        '</div>');
      H.push('<p class="st-explain">Из остатка расход вычитается только с даты пересчёта' +
        (sc.date ? ' — с ' + dm(sc.date) + ', это ' + int(sc.days) + NBSP + 'дн' : '') +
        '. Всё, что уехало раньше, уже внутри пересчитанного количества, поэтому «завышен» и «не сошлось за окно» ' +
        'не совпадают и не должны. Перед закупкой смотрят на первую цифру.' +
        (sc.exact === false
          ? ' <b>Даты пересчёта у строк разные</b> (разброс ' + int(sc.spreadDays) + NBSP + 'дн), поэтому «завышен» — ' +
            'верхняя граница: чьей строке принадлежит несошедшийся расход, неизвестно — её артикула на «Складе» нет.'
          : '') + '</p>');
    }

    // Площадки
    const plats = Object.keys(rep.platforms || {}).sort();
    const ign = rep.ignored || {};
    if (plats.length) {
      let t = subhead('По площадкам') + '<div class="table-scroll"><table class="grid"><thead><tr>' +
        '<th>Площадка</th><th>Сошлось</th><th>Потеряно</th><th>Доля потерь</th><th class="txt">Что это значит</th>' +
        '</tr></thead><tbody>';
      plats.forEach(p => {
        const d = rep.platforms[p], ok = num(d.matchedQty), miss = num(d.unmatchedQty), tot = ok + miss;
        const share = tot > 0 ? Math.round(miss / tot * 100) : 0;
        const cls = share >= 90 ? 'bad' : share >= 20 ? 'warn' : '';
        t += '<tr><th class="who">' + esc(PLAT[p] || p) + '</th>' +
          '<td class="num">' + pcs(ok) + '</td>' +
          '<td class="num' + (cls ? ' ' + cls : '') + '">' + pcs(miss) + '</td>' +
          '<td class="num' + (cls ? ' ' + cls : '') + '">' + share + NBSP + '%</td>' +
          '<td class="wrap muted">' + (share >= 90 ? 'артикулы не стыкуются вообще' :
                                       share >= 20 ? 'часть артикулов не заведена' : 'в порядке') + '</td></tr>';
      });
      t += '<tr class="rest"><th class="who">' + esc((ign.platforms || []).map(x => PLAT[x] || x).join(', ') || '—') +
        ' <span class="where">исключено</span></th><td class="num">—</td><td class="num">' + pcs(ign.qty) + '</td>' +
        '<td class="num">—</td><td class="wrap">сознательно не сопоставляем, в потери не входит</td></tr>';
      H.push(t + '</tbody></table></div>');
    }

    // Артикулы, по которым теряется расход: это и есть список «что завести».
    const misses = [];
    plats.forEach(p => (rep.platforms[p].misses || []).forEach(m => misses.push(m)));
    misses.sort((a, b2) => num(b2.qty) - num(a.qty));
    if (misses.length) {
      let t = subhead('Артикулы, которых нет на «Складе»') +
        '<div class="table-scroll tall"><table class="grid"><thead><tr>' +
        '<th>Площадка</th><th class="txt">Артикул площадки</th><th class="txt">После псевдонима</th>' +
        '<th>Потеряно</th><th class="txt">Товар</th></tr></thead><tbody>';
      misses.slice(0, 20).forEach(m => {
        t += '<tr><th class="who">' + esc(PLAT[m.platform] || m.platform) + '</th>' +
          '<td><b>' + esc(m.sku) + '</b></td>' +
          '<td class="muted">' + (m.aliased ? esc(m.resolved) : 'псевдонима нет') + '</td>' +
          '<td class="num strong">' + pcs(m.qty) + '</td>' +
          '<td class="wrap muted">' + esc(m.name || '') + '</td></tr>';
      });
      H.push(t + '</tbody></table></div>' +
        '<p class="st-explain">Чинится строкой в листе «Артикулы»: <code>Площадка | Артикул площадки | SKU склада</code>. ' +
        'Цифры сойдутся после синхронизации таблицы и пересчёта снимка' +
        (misses.length > 20 ? ' · показаны 20 худших из ' + int(misses.length) : '') + '.</p>');
    }

    // B2B
    if (num(b.matchedQty) || num(b.unmatchedQty) || (b.misses || []).length || (b.parserGap || []).length) {
      let t = subhead('B2B') + '<p class="st-explain">Сошлось <b>' + pcs(b.matchedQty) + '</b>, потеряно <b class="' +
        (num(b.unmatchedQty) > 0 ? 'st-bad-text' : 'st-good-text') + '">' + pcs(b.unmatchedQty) + '</b>' +
        ' · из «Позиций поставки» ' + int(b.itemsRows) + ' ' + plural(b.itemsRows, 'строка', 'строки', 'строк') +
        (num(b.textOnlyShipments) ? ', ещё ' + int(b.textOnlyShipments) + ' ' +
          plural(b.textOnlyShipments, 'поставка читается', 'поставки читаются', 'поставок читаются') +
          ' из текста «Товары»' : '') + '</p>';
      if ((b.misses || []).length) {
        t += '<div class="table-scroll"><table class="grid"><thead><tr><th>Позиция из отгрузки</th><th>Потеряно</th>' +
          '<th class="txt">Как сравнивали</th></tr></thead><tbody>';
        b.misses.slice(0, 15).forEach(m => {
          t += '<tr><th class="who">' + esc(String(m.name || '').trim() || '—') + '</th>' +
            '<td class="num strong">' + pcs(m.qty) + '</td><td class="wrap muted">' +
            (m.viaCode ? 'по «SKU склада» из «Номенклатуры» — такого SKU нет на листе «Склад»'
                       : 'по названию — в «Номенклатуре» не проставлен «SKU склада»') + '</td></tr>';
        });
        t += '</tbody></table></div>';
      }
      if ((b.parserGap || []).length) {
        t += alertBox('warn', '<b>Строк, которые понял B2B, но не понял склад: ' + int(b.parserGap.length) + '.</b> ' +
          'Склад считает только «шт», B2B — ещё уп/кг/л/усл, и такая отгрузка со склада не вычитается. ' +
          'Например: ' + esc(b.parserGap[0].line));
      }
      H.push(t);
    }

    // Сам лист «Склад»
    const warn = [];
    if ((inv.noCountDate || []).length) warn.push(['Без даты пересчёта: ' + int(inv.noCountDate.length),
      'по этим строкам расход не вычитается вовсе, а «расход в день» считается — строка выглядит здоровой: ' +
      inv.noCountDate.slice(0, 8).join(', ')]);
    if ((inv.dupSku || []).length) warn.push(['Повторяющийся SKU: ' + int(inv.dupSku.length),
      'каждая строка вычтет весь расход по артикулу — он вычтется несколько раз, остаток станет ниже реального: ' +
      inv.dupSku.join(', ')]);
    if ((inv.dupName || []).length) warn.push(['Повторяющееся название: ' + int(inv.dupName.length),
      'то же для B2B, который сходится по названию: ' + inv.dupName.join(', ')]);
    if ((inv.noSku || []).length) warn.push(['Без SKU: ' + int(inv.noSku.length),
      'такая строка не поймает ни одной продажи маркетплейса: ' + inv.noSku.slice(0, 8).join(', ')]);
    if ((inv.staleRows || []).length) warn.push(['Пересчёт старше 60 дней: ' + int(inv.staleRows.length),
      'чем дальше от пересчёта, тем больше накопилось ошибки. Самый старый — ' + int(inv.staleDays) + NBSP +
      'дн назад: ' + inv.staleRows.slice(0, 8).join(', ')]);
    H.push(subhead('Лист «Склад» · ' + int(inv.rows) + ' ' + plural(inv.rows, 'строка', 'строки', 'строк')) +
      (warn.length
        ? warn.map(w => alertBox('warn', '<b>' + esc(w[0]) + '.</b> ' + esc(w[1]))).join('')
        : '<p class="st-explain st-good-text">Лист в порядке: у всех строк есть SKU и дата пересчёта, дублей нет.</p>'));

    return H.join('');
  }

  // ── Склады отгрузки Kaspi — renderInvPoints ──────────────────────────────
  function pointsSub(rep, win) {
    return 'сколько штук ушло с каждого склада · только Kaspi · ' + win + NBSP + 'дней' +
      (rep && !rep.fatal ? ', с ' + winFrom(rep) : '');
  }

  function renderPoints(rep) {
    if (!rep) return C.empty('Сверки в снимке нет — выполните sql/24_stock_recon.sql.');
    if (rep.fatal) return C.empty('Лист «Склад» пуст — считать не с чем.');
    const pts = rep.points || {};
    if (!pts.available) {
      return alertBox('warn', '<b>В «База_продаж» ещё нет колонки «Склад передачи КД».</b> Она появляется при ' +
        'пересборке базы продаж — после ближайшего импорта выгрузки Kaspi блок посчитается сам.');
    }
    const unk = pts.unknown || { qty: 0, rows: 0, items: [] };
    const cols = (pts.list || []).slice();
    if (num(unk.qty) > 0) cols.push({ code: '', name: '', qty: unk.qty, rows: unk.rows, items: unk.items || [], unknown: true });
    if (!cols.length) return C.empty('За окно выданных заказов Kaspi не было.');
    const total = num(pts.qty);
    const label = c => c.unknown ? 'Склад не указан' : c.code + (c.name ? ' · ' + c.name : '');

    const H = ['<div class="kpi-grid">' + cols.map(c => card(label(c), pcs(c.qty),
      c.unknown ? 'колонка «Склад передачи КД» пустая — показано отдельно, а не выброшено'
                : int(c.rows) + ' ' + plural(c.rows, 'строка', 'строки', 'строк') + ' · ' +
                  (total ? Math.round(num(c.qty) / total * 100) : 0) + NBSP + '% расхода Kaspi',
      c.unknown ? 'warn' : '')).join('') + '</div>'];

    // Товар × склад: позиции разных складов склеиваются по артикулу, без него —
    // по названию, как в старом табе.
    const prod = {}, order = [];
    cols.forEach((c, ci) => (c.items || []).forEach(it => {
      const k = it.sku || it.name || '—';
      if (!prod[k]) { prod[k] = { name: it.name || it.sku || '—', sku: it.sku || '', total: 0, cells: [] }; order.push(k); }
      const r = prod[k];
      r.cells[ci] = (r.cells[ci] || 0) + num(it.qty);
      r.total += num(it.qty);
      if ((r.name === '—' || r.name === r.sku) && it.name) r.name = it.name;
    }));
    const rows = order.map(k => prod[k]).sort((a, b) => b.total - a.total);
    let t = '<div class="table-scroll tall"><table class="grid sticky-first"><thead><tr><th>Товар</th>' +
      cols.map(c => '<th>' + esc(label(c)) + '</th>').join('') + '<th>Итого</th></tr></thead><tbody>';
    rows.forEach(r => {
      t += '<tr><th class="who">' + esc(r.name) + (r.sku ? '<div class="where">' + esc(r.sku) + '</div>' : '') + '</th>' +
        cols.map((c, ci) => r.cells[ci] ? '<td class="num">' + qty(Math.round(r.cells[ci])) + '</td>'
                                         : '<td class="num muted">—</td>').join('') +
        '<td class="num strong">' + qty(Math.round(r.total)) + '</td></tr>';
    });
    t += '</tbody><tfoot><tr><th>Всего</th>' + cols.map(c => '<td class="num">' + qty(Math.round(num(c.qty))) + '</td>').join('') +
      '<td class="num">' + qty(Math.round(total)) + '</td></tr></tfoot></table></div>';
    H.push(t);
    H.push('<p class="st-explain">По выданным заказам Kaspi за окно сверки. Ozon, Wildberries, Teez и B2B сюда не ' +
      'входят: склад отгрузки есть только в данных Kaspi, поэтому это каспийская часть расхода, а не весь. ' +
      'Остаток по городам не считается — лист «Склад» держит все склады одним числом.</p>');
    return H.join('');
  }

  function renderNotes() {
    return '<ul class="notes">' +
      '<li><b>Остаток</b> = пересчёт + приходы − продажи − B2B − вложено в упаковки − списано, всё после даты пересчёта. Ровно так считает старый таб: цифры сверены с листом «Склад», 13 строк из 13 (29.09.2026).</li>' +
      '<li><b>Маркетплейсы</b> — в старом табе колонка «Расход Kaspi», но в ней все площадки: Kaspi, Ozon и WB. Teez не вычитается.</li>' +
      '<li><b>Ozon FBO и WB</b> сейчас вычитаются в день продажи покупателю, хотя коробка ушла со склада раньше — в день отгрузки на площадку. Пока отгрузки нигде не фиксируются, остаток врёт в обе стороны. Следующий шаг — отгрузки по API и отдельной строкой разница со старым расчётом.</li>' +
      '<li><b>Вложено</b> — пачки салфеток, которые едут в каждой большой упаковке с 25.07.2026 (лист «Довески»). Входят и в остаток, и в расход в день.</li>' +
      '<li><b>Расход в день</b> — продажи, B2B и вложения за 30 дней, включая сегодня. Списания в него не входят: разовый брак не должен сдвигать дату обнуления.</li>' +
      '<li><b>Приход</b> вносят в старом дашборде, на табе «Склад»; сюда он приезжает с синхронизацией таблицы. Не внесённая после пересчёта партия занижает остаток на всю партию.</li>' +
      '<li><b>Сверка</b> — какой расход не доехал до остатка: артикул площадки не нашёлся на листе «Склад», пустой артикул, позиция B2B не сошлась. «Остаток завышен на» считается с даты пересчёта — это то, что смотрят перед закупкой; «не сошлось за окно» — мера качества сопоставления.</li>' +
      '<li>Пока нет: остатков на площадках (WB, Ozon FBO и FBS) и форм прихода, списания и пересчёта — они переедут следующими шагами.</li>' +
    '</ul>';
  }

  root.NietteStock = {
    INF, GROUPS, groupOf, displayName, status, daysLabel, endDate, kpis, woff30, problems,
    renderKpis, renderProblems, renderCards, renderTable, renderWriteoffs, renderNotes,
    reconFor, winFrom, winToolbar, reconSub, renderRecon, pointsSub, renderPoints
  };
})(typeof window !== 'undefined' ? window : globalThis);
