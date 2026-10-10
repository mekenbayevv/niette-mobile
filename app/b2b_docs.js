/* Экран «B2B»: счёт на оплату и накладная З-2 (этап 4, sql/32_b2b_docs.sql).
 *
 * Как b2b.js и b2b_forms.js — только чистые функции: снимок документа,
 * строки таблиц и состояние формы на вход, HTML, тело запроса к базе и
 * описание PDF на выход. Сеть, библиотека PDF и события — в app.js. Поэтому
 * всё проверяется в Node (tests/app_b2b_docs_test.js), а PDF — настоящим
 * pdfmake (tests/b2b_docs_pdf_test.js).
 *
 * ДОКУМЕНТ — ДАННЫЕ. Что напечатано, база замораживает в b2b_docs.snapshot в
 * момент выписки: реквизиты, покупатель, договор, строки с официальными
 * названиями и кодами 1С, итоги, прописью. Здесь из снимка собирается PDF —
 * каждый раз одинаково. Ничего не досчитывается: числа и слова — из снимка.
 * Вид — ваши шаблоны 12.08.2026 (tests/fixtures/real_templates.json), тексты
 * слово в слово; печать и подпись — руками на бумаге.
 *
 * ЧТО ЗДЕСЬ:
 *   docDefinition()   описание PDF для pdfmake по снимку (v1): счёт — А4
 *                     книжный, З-2 — альбомный, как форма. Тренировка —
 *                     «ТРЕНИРОВКА» поперёк страницы.
 *   fileName()        «Счёт 00000000038 — ТОО «Аптека Плюс».pdf».
 *   newDocForm() …    форма документа: строки — из поставок (v_b2b_doc_lines,
 *                     тот же расчёт, что у автонакладной), правятся руками.
 *   renderDocs()      раздел карточки «Счета и накладные».
 *   renderDocForm()   форма; renderSettingsForm() — реквизиты (полный доступ).
 */
(function (root) {
  'use strict';

  const C = root.NietteClients;
  const esc = C.esc, money = C.money;
  const NBSP = '\u00a0';
  const KIND = { invoice: 'Счёт на оплату', waybill: 'Накладная' };
  const SHORT = { invoice: 'Счёт', waybill: 'Накладная' };

  const s0 = v => String(v === null || v === undefined ? '' : v);
  const t0 = v => s0(v).trim();
  const num = v => { const x = Number(String(v === null || v === undefined ? '' : v).replace(/\s/g, '').replace(',', '.')); return isFinite(x) ? x : NaN; };
  const r2 = v => Math.round(v * 100) / 100;
  const r3 = v => Math.round(v * 1000) / 1000;
  const tg = v => money(Math.round(v));
  function dmy(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? m[3] + '.' + m[2] + '.' + m[1] : '—'; }
  function plural(k, one, few, many) {
    const a = Math.abs(Number(k) || 0) % 100, b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  }

  // ── Числа в документе ────────────────────────────────────────────────────
  // Своим разбором, а не Intl: разделитель тысяч — неразрывный пробел всегда
  // (число не рвётся по строкам в узкой ячейке), запятая — дробная часть.
  function groups(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP); }
  // Деньги — всегда с копейками: «107 360,00».
  function money2(v) {
    const x = Number(v) || 0, neg = x < 0, a = Math.abs(Math.round(x * 100));
    return (neg ? '-' : '') + groups(String(Math.floor(a / 100))) + ',' + String(a % 100).padStart(2, '0');
  }
  // Количество — без лишних нулей: «25», «1,5».
  function qty(v) {
    const x = r3(Number(v) || 0), i = Math.trunc(x), f = Math.round(Math.abs(x - i) * 1000);
    return (x < 0 ? '-' : '') + groups(String(Math.abs(i))) + (f ? ',' + String(f).padStart(3, '0').replace(/0+$/, '') : '');
  }

  // ── PDF: общее ───────────────────────────────────────────────────────────
  // Сетка таблиц — тонкая чёрная линия, как в шаблоне; layout — функции, их
  // pdfmake зовёт сам.
  const GRID = { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#000', vLineColor: () => '#000',
                 paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 2, paddingBottom: () => 2 };
  const PLAIN = { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 4,
                  paddingTop: () => 1, paddingBottom: () => 1 };
  const UNDER = { hLineWidth: (i, node) => (i === node.table.body.length ? 0.5 : 0), vLineWidth: () => 0, hLineColor: () => '#000',
                  paddingLeft: () => 0, paddingRight: () => 4, paddingTop: () => 1, paddingBottom: () => 1 };
  const WATERMARK = { text: 'ТРЕНИРОВКА', color: '#c62828', opacity: 0.16, bold: true, fontSize: 90, angle: -35 };
  function rule(width, w) { return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: w || 1 }] }; }
  // Строка подписей. columnGap наследуется вложенными колонками (pdfmake):
  // без явного нуля промежуток внешних колонок раздвинул бы подписи за край листа.
  function line(cols, margin) { return { columns: cols, columnGap: 0, margin: margin || [0, 0, 0, 0] }; }
  function slash() { return { text: '/', width: 8, alignment: 'center', margin: [0, 6, 0, 0] }; }
  // Подпись: линия, под ней — что на ней пишут.
  function sign(width, label, value) {
    return { width, stack: [{ text: value || ' ', alignment: 'center', margin: [0, 0, 0, 1] }, rule(width, 0.5),
                            { text: label || ' ', fontSize: 6, alignment: 'center', color: '#333', margin: [0, 1, 0, 0] }] };
  }

  // ── Счёт на оплату (А4, книжный) ─────────────────────────────────────────
  function invoiceDd(s) {
    const S = s.seller || {}, B = s.buyer || {}, T = s.texts || {}, W = 523;
    const head = (t, opt) => Object.assign({ text: t, bold: true, alignment: 'center', fillColor: '#f2f2f2' }, opt || {});
    const items = (s.items || []).map(i => [
      { text: s0(i.n), alignment: 'center' }, { text: s0(i.name) }, { text: qty(i.qty), alignment: 'right' },
      { text: s0(i.unit), alignment: 'center' }, { text: money2(i.price), alignment: 'right' }, { text: money2(i.sum), alignment: 'right' }]);
    return {
      pageSize: 'A4', pageOrientation: 'portrait', pageMargins: [36, 28, 36, 36],
      info: { title: 'Счет на оплату № ' + s.number + ' от ' + s.day_text, author: s0(S.name), subject: s0(B.title) },
      defaultStyle: { font: 'Roboto', fontSize: 9, lineHeight: 1.1 },
      watermark: s.training ? WATERMARK : undefined,
      content: [
        { table: { widths: ['*'], body: [[{ text: s0(T.notice), fontSize: 7.5, alignment: 'center', margin: [8, 3, 8, 3] }]] }, layout: GRID },
        { text: 'Образец платежного поручения', bold: true, margin: [0, 10, 0, 3] },
        { table: { widths: ['*', 150, 70], body: [
            [{ text: 'Бенефициар:', bold: true }, head('ИИК', { fillColor: null }), head('Кбе', { fillColor: null })],
            [{ stack: [{ text: s0(S.name), bold: true }, 'БИН: ' + s0(S.bin)] },
             { text: s0(S.iik), bold: true, alignment: 'center' }, { text: s0(S.kbe), bold: true, alignment: 'center' }],
            ['Банк бенефициара:', head('БИК', { fillColor: null }), head('Код назначения платежа', { fillColor: null, fontSize: 7.5 })],
            [{ text: s0(S.bank) }, { text: s0(S.bik), bold: true, alignment: 'center' }, { text: s0(S.knp), bold: true, alignment: 'center' }]
          ] }, layout: GRID },
        { text: 'Счет на оплату № ' + s.number + ' от ' + s.day_text, fontSize: 14, bold: true, margin: [0, 16, 0, 4] },
        rule(W, 1.5),
        { table: { widths: [70, '*'], body: [
            ['Поставщик:', { text: s0(S.line), bold: true }],
            ['Покупатель:', { text: s0(B.title), bold: true }],
            ['Договор:', { text: s.contract ? s0(s.contract.text) : '' }]
          ] }, layout: PLAIN, margin: [0, 8, 0, 10] },
        { table: { headerRows: 1, widths: [20, '*', 46, 34, 62, 74], body: [
            [head('№'), head('Наименование'), head('Кол-во'), head('Ед.'), head('Цена'), head('Сумма')]].concat(items) },
          layout: GRID },
        { columns: [{ text: '', width: '*' }, { text: 'Итого:', bold: true, width: 'auto', margin: [0, 0, 8, 0] },
                    { text: money2(s.amount), bold: true, alignment: 'right', width: 74 }], margin: [0, 5, 3, 0] },
        { text: 'Всего наименований ' + s.lines + ', на сумму ' + money2(s.amount) + ' KZT', margin: [0, 12, 0, 1] },
        { text: 'Всего к оплате: ' + s0(s.amount_words), bold: true },
        Object.assign(rule(W, 1.5), { margin: [0, 8, 0, 0] }),
        line([{ text: 'Исполнитель', width: 70, margin: [0, 6, 0, 0] }, sign(170, '', ''),
              { text: '/' + s0(T.signer) + '/', width: '*', margin: [8, 6, 0, 0] }], [0, 22, 0, 0])
      ]
    };
  }

  // ── Накладная на отпуск запасов на сторону, форма З-2 (А4, альбомный) ────
  function waybillDd(s) {
    const S = s.seller || {}, B = s.buyer || {}, T = s.texts || {};
    const head = (t, opt) => Object.assign({ text: t, alignment: 'center', fontSize: 7 }, opt || {});
    const items = (s.items || []).map(i => [
      { text: s0(i.n), alignment: 'center' }, { text: s0(i.name) }, { text: s0(i.code), alignment: 'center' },
      { text: s0(i.unit), alignment: 'center' }, { text: qty(i.qty), alignment: 'right' }, { text: qty(i.qty), alignment: 'right' },
      { text: money2(i.price), alignment: 'right' }, { text: money2(i.sum), alignment: 'right' }, { text: '' }]);
    const total = [{ text: '', colSpan: 3, border: [false, false, false, false] }, {}, {},
                   { text: 'Итого', bold: true, alignment: 'right' },
                   { text: qty(s.qty_total), bold: true, alignment: 'right' }, { text: qty(s.qty_total), bold: true, alignment: 'right' },
                   { text: 'х', alignment: 'center' }, { text: money2(s.amount), bold: true, alignment: 'right' }, { text: '' }];
    return {
      pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [28, 22, 28, 24],
      info: { title: 'Накладная на отпуск запасов на сторону № ' + s.number + ' от ' + s.day_text, author: s0(S.name), subject: s0(B.title) },
      defaultStyle: { font: 'Roboto', fontSize: 8, lineHeight: 1.05 },
      watermark: s.training ? WATERMARK : undefined,
      content: [
        { columns: [{ text: '', width: '*' }, { width: 170, fontSize: 7, stack: ['Приложение 26', 'к приказу Министра финансов',
                                                                               'Республики Казахстан', 'от 20 декабря 2012 года № 562'] }] },
        { text: 'Форма З-2', bold: true, alignment: 'right', margin: [0, 4, 0, 4] },
        { columns: [
            { width: '*', table: { widths: [180, '*'], body: [['Организация (индивидуальный предприниматель)', { text: s0(S.name), bold: true }]] },
              layout: UNDER },
            { width: 150, table: { widths: [50, '*'], body: [['ИИН/БИН', { text: s0(S.bin), bold: true, alignment: 'center' }]] }, layout: GRID,
              margin: [12, 0, 0, 0] }] },
        { columns: [{ text: '', width: '*' }, { width: 200, table: { widths: [100, 100], body: [
            [head('Номер документа'), head('Дата составления')],
            [{ text: s0(s.number), bold: true, alignment: 'center' }, { text: s0(s.day_text), bold: true, alignment: 'center' }]] },
            layout: GRID }], margin: [0, 8, 0, 0] },
        { text: 'НАКЛАДНАЯ НА ОТПУСК ЗАПАСОВ НА СТОРОНУ', bold: true, fontSize: 11, alignment: 'center', margin: [0, 8, 0, 8] },
        { table: { widths: ['*', '*', 130, 110, 140], body: [
            [head('Организация (индивидуальный предприниматель) - отправитель'), head('Организация (индивидуальный предприниматель) - получатель'),
             head('Ответственный за поставку (Ф.И.О.)'), head('Транспортная организация'), head('Товарно-транспортная накладная (номер, дата)')],
            [{ text: s0(S.name), alignment: 'center' }, { text: s0(B.title), alignment: 'center', bold: true },
             { text: s0(T.responsible), alignment: 'center' }, '', '']] }, layout: GRID },
        { table: { headerRows: 3, dontBreakRows: true, widths: [30, '*', 62, 46, 54, 54, 62, 70, 58], body: [
            [head('Номер по порядку', { rowSpan: 2 }), head('Наименование, характеристика', { rowSpan: 2 }), head('Номенкла-турный номер', { rowSpan: 2 }),
             head('Единица измерения', { rowSpan: 2 }), head('Количество', { colSpan: 2 }), {}, head('Цена за единицу, в KZT', { rowSpan: 2 }),
             head('Сумма с НДС, в KZT', { rowSpan: 2 }), head('Сумма НДС, в KZT', { rowSpan: 2 })],
            [{}, {}, {}, {}, head('подлежит отпуску'), head('отпущено'), {}, {}, {}],
            ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(x => head(x, { fontSize: 6.5 }))
          ].concat(items, [total]) }, layout: GRID, margin: [0, 8, 0, 0] },
        { columns: [
            { width: '*', text: ['Всего отпущено количество запасов (прописью) ', { text: s0(s.qty_words), bold: true }] },
            { width: '*', text: ['на сумму (прописью), в KZT ', { text: s0(s.amount_words), bold: true }] }], columnGap: 16, margin: [0, 8, 0, 0] },
        { columns: [
            { width: '*', stack: [
                line([{ text: 'Отпуск разрешил', width: 78, margin: [0, 6, 0, 0] }, sign(90, 'должность', ''), slash(), sign(80, 'подпись', ''), slash(),
                      sign(110, 'расшифровка подписи', s0(T.released_by))]),
                line([{ text: 'Главный бухгалтер', width: 78, margin: [0, 6, 0, 0] }, sign(90, 'подпись', ''), slash(),
                      sign(110, 'расшифровка подписи', s0(T.chief_accountant))], [0, 8, 0, 0]),
                { text: 'М.П.', bold: true, margin: [0, 10, 0, 0] },
                line([{ text: 'Отпустил', width: 78, margin: [0, 6, 0, 0] }, sign(90, 'подпись', ''), slash(), sign(110, 'расшифровка подписи', '')], [0, 8, 0, 0])] },
            { width: 330, stack: [
                { text: 'По доверенности №_____________ от "____"_____________________ 20___ года', margin: [0, 6, 0, 0] },
                line([{ text: 'выданной', width: 50, margin: [0, 6, 0, 0] }, sign(250, '', '')], [0, 6, 0, 0]),
                line([{ text: 'Запасы получил', width: 78, margin: [0, 6, 0, 0] }, sign(90, 'подпись', ''), slash(), sign(130, 'расшифровка подписи', '')],
                     [0, 44, 0, 0])] }], columnGap: 20, margin: [0, 12, 0, 0] }
      ]
    };
  }

  // Описание PDF по снимку. Неизвестная версия снимка — отказ, а не кривая
  // бумага: снимок новее страницы значит, что страницу пора обновить.
  function docDefinition(s) {
    if (!s || typeof s !== 'object') throw new Error('У документа нет снимка — его выписала старая система, PDF — в Drive.');
    if (Number(s.v) !== 1) throw new Error('Документ выписан новой версией — обновите страницу.');
    const dd = s.kind === 'invoice' ? invoiceDd(s) : s.kind === 'waybill' ? waybillDd(s) : null;
    if (!dd) throw new Error('Неизвестный вид документа: ' + s.kind);
    if (!dd.watermark) delete dd.watermark;
    return dd;
  }
  function fileName(s) {
    const t = (s && s.training ? 'ТРЕНИРОВКА ' : '') + (SHORT[s && s.kind] || 'Документ') + ' ' + s0(s && s.number) +
              ' — ' + s0(s && s.buyer && s.buyer.title);
    return t.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) + '.pdf';
  }

  // ── Строки из поставок ───────────────────────────────────────────────────
  // lines — строки v_b2b_doc_lines этого партнёра (sql/32): тот же расчёт,
  // что у автонакладной и переформирования. В счёт — то, за что платят
  // (цена больше нуля), в накладную — всё отгруженное. Одинаковые товар,
  // единица и цена из разных поставок — одной строкой (так склеит и база).
  function fillFromShipments(lines, shipIds, docKind) {
    const order = (shipIds || []).slice();
    const out = [], at = {};
    (lines || []).filter(l => order.indexOf(s0(l.shipment_id)) >= 0 && Number(l.qty) > 0 && (docKind !== 'invoice' || Number(l.price) > 0))
      .sort((a, b) => order.indexOf(s0(a.shipment_id)) - order.indexOf(s0(b.shipment_id)) || Number(a.n) - Number(b.n))
      .forEach(l => {
        const k = t0(l.product).toLowerCase() + '|' + t0(l.unit).toLowerCase() + '|' + r2(Number(l.price));
        if (at[k] !== undefined) { out[at[k]].qty = String(r3(Number(out[at[k]].qty) + Number(l.qty))); return; }
        at[k] = out.length;
        out.push({ name: t0(l.product), unit: t0(l.unit) || 'шт', qty: String(r3(Number(l.qty))), price: String(r2(Number(l.price))) });
      });
    return out;
  }

  // Поставки для выбора в форме. alloc — разнесение карточки (b2b.js): долг
  // по поставке тот же, что в таблице «Поставки». Возврат — ни в счёт, ни в
  // накладную. Счёт: с непогашенным остатком; накладная: все, свежие сверху.
  function shipChoices(cm, docKind) {
    const byShip = cm.docsByShip || {};
    return (cm.ships || []).filter(s => t0(s.status) !== 'Возврат').map(s => {
      const a = (cm.alloc && cm.alloc.byId && cm.alloc.byId[s0(s.id)]) || { sum: Number(s.amount) || 0, paid: 0, consign: false };
      const docs = byShip[s0(s.id)] || [];
      return { id: s0(s.id), day: s0(s.ship_day), sum: Math.round(a.sum), paid: Math.round(a.paid),
               debt: Math.max(0, Math.round(a.sum - a.paid)), consign: !!a.consign,
               waybill: docs.find(d => d.kind === 'waybill') || null, invoice: docs.find(d => d.kind === 'invoice') || null };
    }).sort((x, y) => (y.day || '0000').localeCompare(x.day || '0000') || y.id.localeCompare(x.id, 'ru', { numeric: true }))
      .filter((x, i) => docKind === 'invoice' ? x.debt > 0 : i < 30);
  }
  // Что отметить при открытии: счёт — самая свежая поставка с остатком;
  // накладная — самая свежая без накладной.
  function pickShip(list, docKind) {
    const l = list || [];
    const hit = docKind === 'invoice' ? l.find(x => x.debt > 0) : l.find(x => !x.waybill);
    return hit || null;
  }

  // ── Форма документа ──────────────────────────────────────────────────────
  const emptyLine = () => ({ name: '', unit: 'шт', qty: '', price: '' });
  function newDocForm(docKind, ctx, today) {
    const c = ctx || {};
    return { kind: 'doc', docKind: docKind === 'waybill' ? 'waybill' : 'invoice', cid: s0(c.cid), msg: null, busy: false,
             f: { day: '', comment: '', flat: false, flat_amount: '', flat_name: '' },
             items: [emptyLine()], ships: [], lines: null, linesErr: null, next: null, dirty: false, today: today || '' };
  }
  // Строки поставок пришли — отметить поставку и заполнить строки (если
  // человек ещё ничего не правил руками).
  function prefill(form, cm) {
    if (!form.ships.length) {
      const p = pickShip(shipChoices(cm, form.docKind), form.docKind);
      if (p) form.ships = [p.id];
    }
    if (!form.dirty && form.ships.length) {
      const it = fillFromShipments(form.lines, form.ships, form.docKind);
      form.items = it.length ? it : [emptyLine()];
    }
    return form;
  }
  function lineSum(i) { const q = num(i.qty), p = num(i.price); return q > 0 && p >= 0 ? r2(q * p) : 0; }
  const isFlat = form => form.docKind === 'invoice' && !!form.f.flat;   // одной суммой — только счёт
  function docTotal(form) {
    if (isFlat(form)) return num(form.f.flat_amount) > 0 ? r2(num(form.f.flat_amount)) : 0;
    return r2((form.items || []).reduce((a, i) => a + lineSum(i), 0));
  }
  const filled = i => t0(i.name) || t0(i.qty) || t0(i.price);
  // Что не так — до запроса; остальное скажет база своим текстом.
  function docProblem(form, contract) {
    if (form.docKind === 'invoice' && !contract) return 'Счёт без договора не выписывается: заполните № и дату договора — «Изменить партнёра».';
    if (isFlat(form)) return num(form.f.flat_amount) > 0 ? '' : 'Укажите сумму счёта.';
    const lines = (form.items || []).filter(filled);
    if (!lines.length) return 'Добавьте хотя бы одну позицию.';
    const bad = lines.findIndex(i => !t0(i.name));
    if (bad >= 0) return 'Строка ' + (bad + 1) + ': нет наименования — в документе была бы пустая строка.';
    const zero = lines.findIndex(i => !(num(i.qty) > 0));
    if (zero >= 0) return 'Строка ' + (zero + 1) + ' («' + t0(lines[zero].name) + '»): количество — больше нуля.';
    if (form.docKind === 'invoice' && !(docTotal(form) > 0)) return 'Сумма счёта нулевая — укажите цены.';
    return '';
  }
  function docPayload(form) {
    const d = { kind: form.docKind, client_id: form.cid, day: t0(form.f.day), shipment_ids: (form.ships || []).slice(),
                comment: t0(form.f.comment) };
    if (isFlat(form)) d.flat = { amount: num(form.f.flat_amount), name: t0(form.f.flat_name) };
    else d.items = (form.items || []).filter(filled).map(i => ({ name: t0(i.name), unit: t0(i.unit) || 'шт',
      qty: t0(i.qty) === '' ? '' : num(i.qty), price: t0(i.price) === '' ? '' : num(i.price) }));
    return d;
  }

  // ── Разметка: общее ──────────────────────────────────────────────────────
  function field(id, label, control, wide) {
    return '<div class="st-field' + (wide ? ' wide' : '') + '"><label for="' + id + '">' + esc(label) + '</label>' + control + '</div>';
  }
  function input(id, value, attrs) {
    return '<input id="' + id + '" ' + (attrs || 'type="text"') + ' autocomplete="off" value="' + esc(s0(value)) + '">';
  }
  function msgHtml(m) {
    return m ? '<div class="st-msg ' + (m.tone === 'bad' ? 'st-bad-text' : 'st-good-text') + '" role="status">' + esc(m.text) + '</div>' : '';
  }
  // Документ — кнопкой PDF (снимок), старый — ссылкой в Drive.
  function docLink(d, label) {
    const t = esc(label || d.number || d.id);
    if (d.has_snapshot) return '<button type="button" class="b2b-link b2b-doc-num" data-action="b2b-doc-pdf" data-id="' + esc(d.id) + '">' + t + '</button>';
    if (/^https:\/\//.test(s0(d.pdf_url))) return '<a href="' + esc(d.pdf_url) + '" target="_blank" rel="noopener">' + t + '</a>';
    return t;
  }
  // «Тренировка» — в mirror всё, что записала форма (в листе этой строки нет).
  const isTraining = (d, perm) => !!(perm && !perm.live && (d.sheet_row === null || d.sheet_row === undefined));

  // ── Раздел карточки «Счета и накладные» ──────────────────────────────────
  // act: { perm, confirm }. Готовый PDF — панелью над карточкой (app.js).
  function missingCount(cm) {
    const by = cm.docsByShip || {};
    return (cm.ships || []).filter(s => t0(s.status) !== 'Возврат' && !(by[s0(s.id)] || []).some(d => d.kind === 'waybill')).length;
  }
  function renderPdfPanel(pdf) {
    if (!pdf) return '';
    if (pdf.busy) return '<div class="b2b-pdf" id="b2bPdf" role="status">Собираю PDF…</div>';
    if (pdf.err) return '<div class="b2b-pdf b2b-pdf-bad" id="b2bPdf" role="status"><span class="st-bad-text">' + esc(pdf.err) + '</span>' +
      ' <button type="button" class="ghost small" data-action="b2b-doc-pdf-close">Закрыть</button></div>';
    return '<div class="b2b-pdf" id="b2bPdf" role="status"><span class="b2b-pdf-name">📄 ' + esc(pdf.name) + '</span>' +
      '<span class="b2b-pdf-act"><a class="button small" href="' + esc(pdf.url) + '" target="_blank" rel="noopener">Открыть</a>' +
      '<a class="button ghost small" href="' + esc(pdf.url) + '" download="' + esc(pdf.name) + '">Скачать</a>' +
      (pdf.canShare ? '<button type="button" class="ghost small" data-action="b2b-doc-share">Отправить…</button>' : '') +
      '<button type="button" class="ghost small" data-action="b2b-doc-pdf-close" aria-label="Закрыть PDF">✕</button></span></div>';
  }
  function renderDocs(cm, act) {
    const a = act || {}, p = a.perm || {}, w = !!p.write;
    const docs = cm.docs || [];
    const alive = new Set((cm.ships || []).map(s => s0(s.id)));
    const shipAt = {};
    (cm.ships || []).forEach(s => { shipAt[s0(s.id)] = s; });
    const miss = w ? missingCount(cm) : 0;
    const tools = w ? '<div class="b2b-actions b2b-doc-tools" role="toolbar" aria-label="Документы">' +
      '<button type="button" class="ghost small" data-action="b2b-f-open" data-kind="doc" data-doc="invoice">+ Счёт</button>' +
      '<button type="button" class="ghost small" data-action="b2b-f-open" data-kind="doc" data-doc="waybill">+ Накладная</button>' +
      (miss ? (a.confirm === 'docmiss:' + s0(cm.c.id)
        ? '<span class="b2b-confirm">Выписать ' + miss + ' ' + plural(miss, 'накладную', 'накладные', 'накладных') +
          ' — датами поставок? <button type="button" class="small" data-action="b2b-doc-missing-yes">Да</button> ' +
          '<button type="button" class="ghost small" data-action="b2b-del-no">Нет</button></span>'
        : '<button type="button" class="ghost small" data-action="b2b-doc-missing">Накладные на поставки без них (' + miss + ')</button>') : '') +
      '</div>' : '';
    if (!docs.length) return tools + '<p class="empty">Документов нет.</p>';
    const rows = docs.map(d => {
      const ids = (d.shipment_ids || []).map(s0);
      const warn = [];
      const gone = ids.filter(x => !alive.has(x));
      if (gone.length) warn.push('поставка ' + gone.join(', ') + ' удалена');
      const since = s0(d.updated_at || d.created_at);
      if (d.has_snapshot && since && ids.some(x => shipAt[x] && s0(shipAt[x].updated_at) > since)) warn.push('поставку меняли после выписки — переформируйте');
      const key = 'regen:' + s0(d.id), del = 'doc:' + s0(d.id);
      let actions = '';
      if (w) {
        if (a.confirm === key) actions = '<td class="b2b-row-act"><button type="button" class="small" data-action="b2b-doc-regen-yes" data-id="' + esc(d.id) +
          '">Переформировать</button> <button type="button" class="ghost small" data-action="b2b-del-no">Нет</button></td>';
        else if (a.confirm === del) actions = '<td class="b2b-row-act"><button type="button" class="danger small" data-action="b2b-del-yes" data-kind="doc" data-id="' +
          esc(d.id) + '">Удалить ' + esc(d.number || d.id) + '</button> <button type="button" class="ghost small" data-action="b2b-del-no">Нет</button></td>';
        // Переформировать есть из чего: снимок или поставки (старый документ без них — только в Drive).
        else actions = '<td class="b2b-row-act">' + ((d.kind === 'invoice' || d.kind === 'waybill') && (d.has_snapshot || ids.length)
            ? '<button type="button" class="ghost small" data-action="b2b-doc-regen" data-id="' + esc(d.id) + '" title="Тот же номер и дата, строки — заново из поставок">Переформировать</button> ' : '') +
          '<button type="button" class="ghost small" data-action="b2b-del" data-kind="doc" data-id="' + esc(d.id) + '" aria-label="Удалить ' + esc(d.number || d.id) + '">Удалить</button></td>';
      }
      const paid = w
        ? '<label class="b2b-f-check"><input type="checkbox" data-doc-paid="' + esc(d.id) + '"' + (d.paid ? ' checked' : '') + '> ' +
          (d.paid ? 'да' + (d.paid_day ? ', ' + dmy(d.paid_day) : '') : 'нет') + '</label>'
        : (d.paid ? '<span class="good">да' + (d.paid_day ? ', ' + dmy(d.paid_day) : '') + '</span>' : '<span class="muted">нет</span>');
      const pdfCell = d.has_snapshot ? '<button type="button" class="ghost small" data-action="b2b-doc-pdf" data-id="' + esc(d.id) + '">PDF</button>'
        : /^https:\/\//.test(s0(d.pdf_url)) ? '<a href="' + esc(d.pdf_url) + '" target="_blank" rel="noopener">в Drive</a>' : '<span class="muted">—</span>';
      // Номер — сам открывает PDF: на телефоне колонки «PDF» за краем экрана.
      return '<tr><th scope="row">' + esc(d.kind_label || KIND[d.kind] || d.kind) + ' ' + (d.number ? docLink(d, d.number) : '') +
          (isTraining(d, p) ? ' <span class="badge warn">тренировка</span>' : '') +
          '<div class="where b2b-doc-mob">' + dmy(d.day) + ' · ' + esc(tg(Number(d.amount) || 0)) + (d.paid ? ' · оплачен' : '') + '</div>' +
          (ids.length ? '<div class="where">' + esc(ids.join(', ')) + '</div>' : '') +
          warn.map(x => '<div class="where st-bad-text">⚠ ' + esc(x) + '</div>').join('') + '</th>' +
        '<td>' + dmy(d.day) + '</td><td class="num">' + tg(Number(d.amount) || 0) + '</td><td>' + paid + '</td><td>' + pdfCell + '</td>' + actions + '</tr>';
    }).join('');
    return tools + '<div class="table-scroll"><table class="grid b2b-docs"><thead><tr><th scope="col">Документ</th>' +
      '<th scope="col" class="txt">Дата</th><th scope="col">Сумма</th><th scope="col" class="txt">Оплачено</th><th scope="col" class="txt">PDF</th>' +
      (w ? '<th scope="col"><span class="sr-only">Действия</span></th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  // Под номером поставки в таблице «Поставки»: её документы и «+ накладная».
  function shipDocsHtml(cm, s, act) {
    const docs = (cm.docsByShip || {})[s0(s.id)] || [];
    const w = !!(act && act.perm && act.perm.write);
    const links = docs.map(d => docLink(d, (d.kind === 'invoice' ? 'счёт ' : '') + (d.number || d.id)));
    if (w && t0(s.status) !== 'Возврат' && !docs.some(d => d.kind === 'waybill')) {
      links.push('<button type="button" class="ghost small b2b-doc-ship" data-action="b2b-doc-ship" data-id="' + esc(s.id) + '">+ накладная</button>');
    }
    return links.length ? '<div class="where b2b-ship-docs">' + links.join(' ') + '</div>' : '';
  }

  // ── Форма документа: разметка ────────────────────────────────────────────
  // opts: { today, perm, nomen, cm, contract }
  function renderDocForm(form, m, opts) {
    const o = opts || {}, f = form.f, cm = o.cm, c = cm ? cm.c : ((m && m.byId && m.byId[form.cid]) || {});
    const inv = form.docKind === 'invoice', ct = o.contract || null;
    const H = [];
    H.push('<div class="st-form b2b-f b2b-doc-f" id="b2bForm" data-kind="doc"><div class="b2b-f-head"><h3 class="st-subhead">' +
      esc((inv ? 'Счёт на оплату' : 'Накладная З-2') + ' · ' + (c.name || c.id || '')) +
      '</h3><button type="button" class="ghost small" data-action="b2b-f-close">Закрыть</button></div>');
    if (o.perm && o.perm.training) {
      H.push('<p class="st-explain b2b-f-train">Тренировка: документ выпишется с пометкой «ТРЕНИРОВКА» поперёк страницы, и его сотрёт следующий перенос из листов. ' +
             'Настоящие счета и накладные — пока в старом табе.</p>');
    }
    // Договор и покупатель — основание счёта; без договора кнопка не нажмётся.
    const who = '<b>' + esc(t0(c.counterparty) || t0(c.name) || s0(c.id)) + '</b>' +
      (t0(c.counterparty) ? '' : ' <span class="muted">(контрагент не заполнен — в документ уйдёт название точки)</span>');
    H.push('<div class="st-alert ' + (inv && !ct ? 'st-alert-bad' : 'st-alert-info') + ' b2b-doc-plate">' +
      (inv ? 'Покупатель: ' : 'Получатель: ') + who +
      (inv ? (ct ? '<br>Основание: <b>' + esc(ct.text) + '</b>'
                 : '<br><b>Договор не заполнен — счёт не выписывается.</b> Карточка → «Изменить партнёра» → № и дата договора.') : '') + '</div>');
    H.push('<div class="st-fields">');
    // Поставки.
    const ch = cm ? shipChoices(cm, form.docKind) : [];
    const picked = new Set(form.ships || []);
    const extra = (form.ships || []).filter(id => !ch.some(x => x.id === id));
    if (ch.length || extra.length) {
      H.push('<div class="st-field wide"><span class="b2b-f-label">' + esc(inv ? 'Поставки с остатком — по ним счёт' : 'Поставка — по ней накладная') +
        '</span><div class="st-pick b2b-doc-ships">' + ch.map(x => {
          const marks = [];
          if (inv && x.consign) marks.push('под реализацию');
          if (x.waybill) marks.push((inv ? '' : '⚠ уже есть ') + 'накладная ' + (x.waybill.number || ''));
          if (x.invoice) marks.push((inv ? '⚠ уже есть ' : '') + 'счёт ' + (x.invoice.number || ''));
          return '<div class="st-pick-row"><label><input type="checkbox" data-doc-ship="' + esc(x.id) + '"' + (picked.has(x.id) ? ' checked' : '') + '>' +
            '<span class="st-pick-name">' + esc(x.id) + ' · ' + dmy(x.day) + ' · ' + esc(tg(x.sum)) +
            '<span class="st-pick-sub">' + esc((inv ? 'остаток ' + tg(x.debt) : x.debt > 0 ? 'не оплачено ' + tg(x.debt) : 'оплачена') +
              (marks.length ? ' · ' + marks.join(' · ') : '')) + '</span></span></label></div>';
        }).join('') + extra.map(id => '<div class="st-pick-row"><label><input type="checkbox" data-doc-ship="' + esc(id) + '" checked>' +
          '<span class="st-pick-name">' + esc(id) + '</span></label></div>').join('') + '</div>' +
        (form.dirty ? '<div class="st-form-actions"><button type="button" class="ghost small" data-action="b2b-doc-fill">↻ Подставить строки из отмеченных поставок</button>' +
          '<span class="muted b2b-f-note">строки правились руками — отметки их не меняют</span></div>' : '') + '</div>');
    } else if (cm) {
      H.push('<div class="st-field wide"><p class="st-explain">' + esc(inv ? 'Поставок с остатком нет — строки впишите руками.' : 'Поставок нет — строки впишите руками.') + '</p></div>');
    }
    if (form.lines === null && form.cid) H.push('<div class="st-field wide"><p class="st-explain" role="status">Загружаю строки поставок…</p></div>');
    if (form.linesErr) H.push('<div class="st-field wide"><div class="st-alert st-alert-bad">' + esc(form.linesErr) + '</div></div>');
    // Строки.
    if (inv) {
      H.push('<div class="st-field wide"><label class="b2b-f-check"><input id="bdFlat" type="checkbox"' + (f.flat ? ' checked' : '') +
        '> Одной суммой — одной строкой, без разбивки по товарам</label></div>');
    }
    if (inv && f.flat) {
      H.push(field('bdFlatAmount', 'Сумма, ₸', input('bdFlatAmount', f.flat_amount, 'type="number" inputmode="decimal" min="0" step="any"')),
             field('bdFlatName', 'Строка в счёте', input('bdFlatName', f.flat_name, 'type="text" maxlength="300" placeholder="' +
               esc(ct ? 'Оплата по ' + ct.text.replace(/^Договор/, 'договору') : 'Оплата по договору') + '"'), true));
    } else {
      H.push(linesTable(form, o.nomen));
    }
    H.push(field('bdDay', inv ? 'Дата счёта (пусто — сегодня)' : 'Дата накладной (пусто — дата поставки)',
                 input('bdDay', f.day, 'type="date" max="' + esc(o.today || '') + '"' +
                       (inv && form.next && form.next.last_invoice_day ? ' min="' + esc(form.next.last_invoice_day) + '"' : ''))),
           field('bdComment', 'Комментарий — для себя, в документ не печатается', input('bdComment', f.comment, 'type="text" maxlength="1000"'), true));
    H.push('</div>');
    const nx = form.next ? (inv ? form.next.invoice_next : form.next.waybill_next) : '';
    const problem = docProblem(form, ct);
    H.push('<div class="st-form-actions"><button type="button" data-action="b2b-f-save"' + (form.busy || (inv && !ct) ? ' disabled' : '') + '>' +
      esc(form.busy ? 'Выписываю…' : (inv ? 'Выписать счёт' : 'Выписать накладную') + (docTotal(form) > 0 ? ' на ' + tg(docTotal(form)) : '')) + '</button>' +
      (nx ? '<span class="muted b2b-f-note">следующий номер — ' + esc(nx) + (inv ? '' : ' (год — по дате накладной)') + '</span>' : '') + '</div>' +
      (problem && !form.msg && form.touched ? '<div class="st-msg st-bad-text" role="status">' + esc(problem) + '</div>' : '') +
      msgHtml(form.msg) + '</div>');
    return H.join('');
  }
  function linesTable(form, nomen) {
    const names = (nomen || []).map(x => t0(x.app_name)).filter(Boolean);
    const rows = form.items.map((it, i) => '<tr>' +
      '<td><input type="text" list="bdNames" maxlength="300" data-bd-item="' + i + '" data-bd-col="name" value="' + esc(s0(it.name)) +
        '" placeholder="Наименование" aria-label="Наименование, строка ' + (i + 1) + '"></td>' +
      '<td data-label="Кол-во"><input type="number" inputmode="decimal" min="0" step="any" data-bd-item="' + i + '" data-bd-col="qty" value="' +
        esc(s0(it.qty)) + '" aria-label="Количество, строка ' + (i + 1) + '"></td>' +
      '<td data-label="Ед."><input type="text" maxlength="20" data-bd-item="' + i + '" data-bd-col="unit" value="' + esc(s0(it.unit || 'шт')) +
        '" aria-label="Единица, строка ' + (i + 1) + '"></td>' +
      '<td data-label="Цена, ₸"><input type="number" inputmode="decimal" min="0" step="any" data-bd-item="' + i + '" data-bd-col="price" value="' +
        esc(s0(it.price)) + '" aria-label="Цена, строка ' + (i + 1) + '"></td>' +
      '<td class="num b2b-f-sum">' + (lineSum(it) > 0 || (num(it.qty) > 0 && num(it.price) === 0) ? tg(lineSum(it)) : '—') + '</td>' +
      '<td>' + (form.items.length > 1 ? '<button type="button" class="ghost small" data-action="b2b-doc-line-del" data-i="' + i +
        '" aria-label="Убрать строку ' + (i + 1) + '">✕</button>' : '') + '</td></tr>').join('');
    return '<div class="st-field wide"><span class="b2b-f-label">Строки документа — названия из «Номенклатуры» заменятся официальными, с кодом 1С</span>' +
      '<datalist id="bdNames">' + names.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>' +
      '<div class="table-scroll"><table class="grid b2b-f-items b2b-f-lines b2b-doc-lines"><thead><tr><th scope="col" class="txt">Наименование</th>' +
      '<th scope="col">Кол-во</th><th scope="col" class="txt">Ед.</th><th scope="col">Цена, ₸</th><th scope="col">Сумма</th><th scope="col"></th></tr></thead><tbody>' +
      rows + '</tbody></table></div><div class="st-form-actions"><button type="button" class="ghost small" data-action="b2b-doc-line-add">+ строка</button>' +
      '<span class="b2b-f-total">Итого: <b id="bdTotal">' + tg(docTotal(form)) + '</b></span></div></div>';
  }

  // ── Реквизиты (полный доступ) ────────────────────────────────────────────
  const SETTINGS = [
    ['seller_name', 'Продавец (бенефициар)', 300], ['seller_bin', 'БИН / ИИН', 12], ['seller_address', 'Адрес продавца — строка «Поставщик»', 500],
    ['bank_name', 'Банк бенефициара', 200], ['iik', 'ИИК (счёт KZ…)', 34], ['bik', 'БИК', 11], ['kbe', 'Кбе', 2], ['knp', 'Код назначения платежа (КНП)', 3],
    ['invoice_signer', 'Исполнитель в счёте', 200], ['waybill_responsible', 'З-2: ответственный за поставку', 200],
    ['waybill_released_by', 'З-2: отпуск разрешил (расшифровка)', 200], ['chief_accountant', 'З-2: главный бухгалтер', 200],
    ['invoice_notice', 'Текст «Внимание!» в шапке счёта', 1000]
  ];
  function newSettingsForm(rec, next) {
    const f = {};
    SETTINGS.forEach(([k]) => { f[k] = s0(rec && rec[k]); });
    f.invoice_next = rec && rec.invoice_next !== null && rec.invoice_next !== undefined ? String(rec.invoice_next) : '';
    f.auto_waybill = !(rec && rec.auto_waybill === false);
    return { kind: 'docset', cid: '', f, rec: rec || null, next: next || null, msg: null, busy: false };
  }
  function settingsChanges(form) {
    const f = form.f, rec = form.rec || {}, patch = {};
    SETTINGS.forEach(([k]) => { if (t0(f[k]) !== t0(rec[k])) patch[k] = t0(f[k]); });
    const was = rec.invoice_next === null || rec.invoice_next === undefined ? '' : String(rec.invoice_next);
    if (t0(f.invoice_next) !== was) patch.invoice_next = t0(f.invoice_next) === '' ? null : num(f.invoice_next);
    if (!!f.auto_waybill !== !(rec.auto_waybill === false)) patch.auto_waybill = !!f.auto_waybill;
    return patch;
  }
  function renderSettingsForm(form) {
    const f = form.f, H = [];
    H.push('<div class="st-form b2b-f b2b-docset-f" id="b2bForm" data-kind="docset"><div class="b2b-f-head"><h3 class="st-subhead">Реквизиты для счетов и накладных</h3>' +
      '<button type="button" class="ghost small" data-action="b2b-f-close">Закрыть</button></div>');
    if (!form.rec) H.push(form.loadErr ? '<div class="st-alert st-alert-bad">' + esc(form.loadErr) + '</div>' : '<p class="st-explain" role="status">Загружаю реквизиты…</p>');
    else {
      H.push('<p class="st-explain">Печатаются в каждом новом документе; выписанные не меняются, пока их не переформировали. ' +
        'ИИК и БИН база проверяет контрольной суммой — сверьте и глазами по выписке банка. Это настоящая правка, не тренировка.</p><div class="st-fields">');
      SETTINGS.forEach(([k, label, max]) => {
        const id = 'bsF_' + k;
        H.push(k === 'invoice_notice'
          ? field(id, label, '<textarea id="' + id + '" rows="3" maxlength="' + max + '" data-bs="' + k + '">' + esc(f[k]) + '</textarea>', true)
          : field(id, label, '<input id="' + id + '" type="text" autocomplete="off" maxlength="' + max + '" data-bs="' + k + '" value="' + esc(f[k]) + '">',
                  k === 'seller_address' || k === 'seller_name'));
      });
      H.push(field('bsF_invoice_next', 'Следующий номер счёта не меньше', '<input id="bsF_invoice_next" type="number" inputmode="numeric" min="1" step="1" data-bs="invoice_next" value="' +
               esc(f.invoice_next) + '">'),
             '<div class="st-field"><span class="b2b-f-label">Следующие номера сейчас</span><span>' +
               (form.next ? 'счёт <b>' + esc(form.next.invoice_next) + '</b>, накладная <b>' + esc(form.next.waybill_next) + '</b>' : '—') + '</span></div>',
             '<div class="st-field wide"><label class="b2b-f-check"><input type="checkbox" data-bs="auto_waybill"' + (f.auto_waybill ? ' checked' : '') +
               '> Выписывать накладную сама при каждой поставке</label></div></div>');
    }
    H.push('<div class="st-form-actions"><button type="button" data-action="b2b-f-save"' + (form.busy || !form.rec ? ' disabled' : '') + '>' +
      esc(form.busy ? 'Сохраняю…' : 'Сохранить реквизиты') + '</button></div>' + msgHtml(form.msg) + '</div>');
    return H.join('');
  }

  // Что сказать после записи — по ответу базы.
  function savedText(kind, res) {
    const d = res || {}, tr = d.training ? ' Тренировка — сотрётся при следующем переносе.' : '';
    if (kind === 'doc') return (d.reused ? 'Уже была выписана: ' : 'Выписан' + (d.kind === 'waybill' ? 'а накладная ' : ' счёт № ')) +
      d.number + ' от ' + dmy(d.day) + ' на ' + tg(Number(d.amount) || 0) + '.' + tr;
    if (kind === 'regen') return 'Переформирован ' + d.number + ': ' + (Number(d.was_amount) !== Number(d.amount)
      ? 'сумма ' + tg(Number(d.was_amount) || 0) + ' → ' + tg(Number(d.amount) || 0) : 'сумма прежняя, ' + tg(Number(d.amount) || 0)) + '.' + tr;
    if (kind === 'missing') {
      const made = d.made || [];
      return (made.length ? 'Выписано ' + made.length + ' ' + plural(made.length, 'накладная', 'накладные', 'накладных') +
        ': ' + made.map(x => x.number).join(', ') + '.' : 'Выписывать нечего.') +
        ((d.failed || []).length ? ' Не вышло: ' + d.failed.map(x => x.shipment_id + ' — ' + x.error).join('; ') + '.' : '') + tr;
    }
    if (kind === 'docset') return 'Реквизиты сохранены.' + (d.note ? ' ' + d.note : '') + ' Следующий счёт — ' + d.invoice_next + '.';
    return 'Сохранено.' + tr;
  }

  root.NietteB2bDocs = {
    KIND, SETTINGS, money2, qty, docDefinition, fileName, fillFromShipments, shipChoices, pickShip,
    newDocForm, prefill, emptyLine, lineSum, docTotal, docProblem, docPayload, missingCount,
    renderDocs, renderPdfPanel, shipDocsHtml, renderDocForm, newSettingsForm, settingsChanges, renderSettingsForm, savedText, isTraining
  };
})(typeof window !== 'undefined' ? window : globalThis);
