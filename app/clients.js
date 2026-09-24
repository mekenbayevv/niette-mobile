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
 *
 * Всё строковое, что пришло из базы (имена, города), экранируется через esc():
 * имя клиента — это ввод человека, а не наш текст.
 */
(function (root) {
  'use strict';

  const NBSP = ' ';
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
  function renderMonthly(rows) {
    if (!rows.length) return empty('Нет данных.');
    const body = rows.map(r =>
      '<tr><th scope="row">' + monthName(r.month) + '</th>' +
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
    '</ul>';
  }

  root.NietteClients = {
    esc, int, money, pct, times, days, date, monthName, isNum,
    computeKpis, renderKpis, renderCohorts, renderRepeat, riskRows, renderRisk,
    renderMonthly, renderEntry, SORTS, filterBase, renderBaseTable, renderNotes,
    sectionError, empty
  };
})(typeof window !== 'undefined' ? window : globalThis);
