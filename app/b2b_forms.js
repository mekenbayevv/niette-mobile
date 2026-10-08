/* Экран «B2B»: формы записи (этап 3, sql/31_b2b_write.sql).
 *
 * Как b2b.js и stock.js — только чистые функции: состояние формы и строки
 * таблиц на вход, HTML и тело запроса к базе на выход. Сеть, файлы и события —
 * в app.js. Поэтому всё проверяется в Node (tests/app_b2b_forms_test.js).
 *
 * ЧТО ЗДЕСЬ:
 *   perm()        кто что может: в режиме mirror (до дня переключения) пишет
 *                 только полный доступ с правом записи, и это тренировка;
 *                 в live — раздел B2B с правом записи; оплаты и удаление
 *                 партнёра — только полный доступ. Права держит база
 *                 (b2b_w_guard), страница лишь не показывает лишних кнопок.
 *   newForm()     пустая форма нужного вида; правка — из записи.
 *   render*()     панель формы, кнопки «Внести», плашка тренировки.
 *   *Payload()    тело для form_b2b_*: названия полей — как в sql/31.
 *   fifo()        «Разнести по старым»: сумма, пришедшая от партнёра, гасит
 *                 самые давние позиции целиком, следующую — сколько хватит
 *                 целых штук, остаток — аванс. Как гасят долги на деле; а
 *                 отказ проверять остатки — дело базы (v_b2b_unpaid_items).
 *
 * Сумму оплаты страница не называет: база считает её из позиций и аванса.
 * ДАТЫ — строки 'YYYY-MM-DD' по Алматы.
 */
(function (root) {
  'use strict';

  const C = root.NietteClients;
  const esc = C.esc, money = C.money;

  const TYPES = ['Аптека', 'Оптовик', 'Детский магазин', 'Магазин', 'Прочие'];
  const STAGES = ['Новый', 'Переговоры', 'Активный', 'Заморожен', 'Закрыт'];
  const PRIOS = ['Высокий', 'Средний', 'Низкий'];
  // Результаты визита — как в мобильном торгпреда, плюс звонок и заезд из старого таба.
  const RESULTS = ['✅ Договорились — берут сразу', '📋 Под консигнацию', '🔄 Под реализацию', '🕐 Думают — перезвонить',
                   '⚡ Дозаказ — уже клиент', '❌ Отказали', '📞 Созвонился', '🚗 Заехал'];
  const METHODS = ['Наличные', 'Kaspi перевод', 'Банковский перевод'];
  const STATUSES = ['Отгружено', 'Оплачено', 'Частично', 'Реализация', 'Возврат'];
  const PAY_TYPES = [['once', 'Разово, к дате'], ['monthly', 'Каждый месяц, числа'], ['weekly', 'Каждую неделю, по дню'],
                     ['consignment', 'Под реализацию']];
  const WEEKDAYS = [['1', 'понедельник'], ['2', 'вторник'], ['3', 'среда'], ['4', 'четверг'], ['5', 'пятница'],
                    ['6', 'суббота'], ['0', 'воскресенье']];
  // Цены по умолчанию — из мобильного торгпреда (PRODUCT_PRICES): подставляются
  // при выборе товара, менять можно.
  const PRICES = { 'Подгузники S': 7700, 'Подгузники M': 7700, 'Трусики L': 7700, 'Трусики XL': 7700, 'Трусики XXL': 7700,
                   'Салфетки влажные': 690, 'Минипак S': 450, 'Минипак M': 450, 'Минипак L': 450, 'Минипак XL': 450,
                   'Минипак XXL': 450 };
  const MAX_FILES = 10;
  const MAX_FILE_MB = 10;

  const n = v => { const x = Number(String(v === null || v === undefined ? '' : v).replace(/\s/g, '').replace(',', '.')); return isFinite(x) ? x : NaN; };
  const r2 = v => Math.round(v * 100) / 100;
  const r3 = v => Math.round(v * 1000) / 1000;
  const s0 = v => String(v === null || v === undefined ? '' : v);
  const t0 = v => s0(v).trim();
  const tg = v => money(Math.round(v));
  const nf3 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
  function dmy(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? m[3] + '.' + m[2] + '.' + m[1] : '—'; }
  function plural(k, one, few, many) {
    const a = Math.abs(Number(k) || 0) % 100, b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  }

  // ── Права ────────────────────────────────────────────────────────────────
  // me — ответ app_me(); status — v_b2b_status (режим).
  function perm(me, status) {
    const m = me || {}, full = m.full === true && m.can_write === true;
    const section = m.can_write === true && (m.full === true || (Array.isArray(m.sections) && m.sections.indexOf('b2b') >= 0));
    const live = !!status && status.mode === 'live';
    const write = live ? section : full;
    return { write, full, canPay: write && full, training: write && !live, live };
  }

  // ── Товары ───────────────────────────────────────────────────────────────
  // Названия — из «Номенклатуры» (как выбирает торгпред), иначе список мобильного.
  function products(nomen) {
    const list = (nomen || []).map(x => t0(x.app_name)).filter(Boolean);
    const names = list.length ? list : Object.keys(PRICES);
    return names.filter((x, i) => names.indexOf(x) === i);
  }
  const priceOf = name => (PRICES[t0(name)] !== undefined ? PRICES[t0(name)] : '');

  // ── Пустые формы ─────────────────────────────────────────────────────────
  const emptyItem = () => ({ product: '', unit: 'шт', qty: '', price: '' });

  // kind: client | visit | shipment | payment | round | branch | edit | row | delclient
  // ctx: { cid, rec (запись для правки), rowKind }
  function newForm(kind, ctx, today) {
    const c = ctx || {}, cid = s0(c.cid), rec = c.rec || {};
    const base = { kind, cid, msg: null, busy: false, dupAsk: false, dupFor: '' };
    if (kind === 'client') return Object.assign(base, { f: { name: '', type: 'Аптека', stage: 'Новый', city: '', address: '',
      contact: '', phone: '', priority: 'Средний', comment: '', counterparty: '', allow_duplicate: false } });
    if (kind === 'visit') return Object.assign(base, { f: { day: today, result: '', potential: '', next_day: '', contact: '',
      phone: '', comment: '', allow_duplicate: false }, newClient: false, nc: { name: '', type: 'Аптека', city: '', address: '' }, files: [] });
    if (kind === 'shipment') return Object.assign(base, { f: { branch_id: '', ship_day: today, pay_type: 'once', due_day: '',
      month_day: '15', weekday: '1', status: 'Отгружено', invoice_no: '', comment: '' }, items: [emptyItem()], files: [] });
    if (kind === 'payment') return Object.assign(base, { f: { day: today, received: '', advance: '', method: METHODS[0],
      receipt_no: '', receiver: '', comment: '' }, qty: {}, unpaid: null, unpaidFor: '' });
    if (kind === 'round') return Object.assign(base, { f: { day: today, comment: '' }, items: [emptyItem()] });
    if (kind === 'branch') return Object.assign(base, { f: { name: '', address: '', city: '', contact: '', phone: '', comment: '' } });
    if (kind === 'edit') return Object.assign(base, { f: {
      name: s0(rec.name), type: s0(rec.type), stage: s0(rec.stage), city: s0(rec.city), address: s0(rec.address),
      contact: s0(rec.contact), phone: s0(rec.phone), priority: s0(rec.priority), rep: s0(rec.rep), comment: s0(rec.comment),
      counterparty: s0(rec.counterparty), contract_no: s0(rec.contract_no), contract_date: s0(rec.contract_date) }, rec });
    if (kind === 'row') {
      const rk = c.rowKind, f = {};
      ROW_FIELDS[rk].forEach(k => { f[k] = s0(rec[k]); });
      return Object.assign(base, { rowKind: rk, id: s0(rec.id), f, rec });
    }
    if (kind === 'delclient') return Object.assign(base, { f: { confirm: '' } });
    throw new Error('неизвестная форма: ' + kind);
  }

  // Что правится у строк — белый список form_b2b_update (sql/31).
  const ROW_FIELDS = {
    shipment: ['ship_day', 'due_day', 'status', 'invoice_no', 'rep', 'comment'],
    payment:  ['pay_day', 'method', 'receipt_no', 'receiver', 'comment'],
    visit:    ['day', 'result', 'potential', 'next_day', 'contact', 'phone', 'rep', 'comment'],
    branch:   ['name', 'address', 'city', 'contact', 'phone', 'comment']
  };
  const CLIENT_FIELDS = ['name', 'type', 'stage', 'city', 'address', 'contact', 'phone', 'priority', 'rep', 'comment'];
  // Что база не даёт очистить: пустую дату или название филиала она молча
  // заменила бы старым, пустой результат визита отвергла бы — скажем сразу.
  const ROW_KEEP = {
    shipment: { ship_day: 'Дата поставки не может быть пустой.' },
    payment:  { pay_day: 'Дата оплаты не может быть пустой.' },
    visit:    { day: 'Дата визита не может быть пустой.', result: 'Результат визита не может быть пустым.' },
    branch:   { name: 'Название филиала не может быть пустым.' }
  };
  function rowProblem(form) {
    const f = form.f || {}, rec = form.rec || {}, keep = ROW_KEEP[form.rowKind] || {};
    const k = Object.keys(keep).find(x => t0(f[x]) === '' && t0(rec[x]) !== '');
    return k ? keep[k] : '';
  }

  // «Всё равно добавить» действует только на те название и город, на которые
  // база ответила «уже есть»: сменили название — база спросит заново.
  const dupKey = (name, city) => t0(name).toLowerCase().replace(/\s+/g, ' ') + '|' + t0(city).toLowerCase();
  const dupOk = (form, name, city) => form.f.allow_duplicate === true && form.dupFor === dupKey(name, city);

  // ── Тело запросов (названия — как в sql/31) ──────────────────────────────
  const numOrBlank = v => (t0(v) === '' ? '' : n(v));
  function itemsOut(items, withUnit) {
    return (items || []).filter(i => t0(i.product) || t0(i.qty) || t0(i.price)).map(i => {
      const o = { product: t0(i.product), qty: numOrBlank(i.qty), price: numOrBlank(i.price) };
      if (withUnit) o.unit = t0(i.unit) || 'шт';
      return o;
    });
  }
  function clientPayload(form) {
    const f = form.f;
    return { name: t0(f.name), type: f.type, stage: f.stage, city: t0(f.city), address: t0(f.address), contact: t0(f.contact),
             phone: t0(f.phone), priority: f.priority, comment: t0(f.comment), counterparty: t0(f.counterparty),
             allow_duplicate: dupOk(form, f.name, f.city) };
  }
  function visitPayload(form, files) {
    const f = form.f, d = { day: f.day, result: t0(f.result), potential: numOrBlank(f.potential), next_day: f.next_day,
                            contact: t0(f.contact), phone: t0(f.phone), comment: t0(f.comment), files: files || [] };
    if (form.newClient) {
      d.new_client = { name: t0(form.nc.name), type: form.nc.type, city: t0(form.nc.city), address: t0(form.nc.address),
                       contact: t0(f.contact), phone: t0(f.phone), allow_duplicate: dupOk(form, form.nc.name, form.nc.city) };
    } else d.client_id = form.cid;
    return d;
  }
  function schedule(f) {
    return f.pay_type === 'monthly' ? 'monthly:' + t0(f.month_day) : f.pay_type === 'weekly' ? 'weekly:' + t0(f.weekday) : '';
  }
  function shipmentPayload(form, files) {
    const f = form.f;
    return { client_id: form.cid, branch_id: f.branch_id, ship_day: f.ship_day, pay_type: f.pay_type, pay_schedule: schedule(f),
             due_day: f.pay_type === 'once' ? f.due_day : '',
             status: f.pay_type === 'consignment' ? 'Реализация' : f.status,
             items: itemsOut(form.items, true), invoice_no: t0(f.invoice_no), comment: t0(f.comment), files: files || [] };
  }
  function paymentPayload(form) {
    const f = form.f, items = [];
    Object.keys(form.qty || {}).forEach(id => { const q = n(form.qty[id]); if (q > 0) items.push({ ship_item_id: id, qty: q }); });
    return { client_id: form.cid, day: f.day, items, advance: numOrBlank(f.advance) || 0, method: f.method,
             receipt_no: t0(f.receipt_no), receiver: t0(f.receiver), comment: t0(f.comment) };
  }
  function roundPayload(form) {
    return { client_id: form.cid, day: form.f.day, items: itemsOut(form.items, false), comment: t0(form.f.comment) };
  }
  function branchPayload(form) {
    const f = form.f;
    return { client_id: form.cid, name: t0(f.name), address: t0(f.address), city: t0(f.city), contact: t0(f.contact),
             phone: t0(f.phone), comment: t0(f.comment) };
  }
  // Правка партнёра — только изменённое; контрагент и договор — отдельными
  // функциями базы (как в старом табе), поэтому отдельно.
  function clientChanges(form) {
    const f = form.f, rec = form.rec || {}, patch = {};
    CLIENT_FIELDS.forEach(k => { if (t0(f[k]) !== t0(rec[k])) patch[k] = t0(f[k]); });
    const cp = t0(f.counterparty) !== t0(rec.counterparty) ? t0(f.counterparty) : null;
    const contract = (t0(f.contract_no) !== t0(rec.contract_no) || t0(f.contract_date) !== t0(rec.contract_date))
      ? { num: t0(f.contract_no), day: t0(f.contract_date) } : null;
    return { patch, counterparty: cp, contract };
  }
  function rowPatch(form) {
    const f = form.f, rec = form.rec || {}, patch = {};
    ROW_FIELDS[form.rowKind].forEach(k => {
      if (form.rowKind === 'shipment' && k === 'due_day' && s0(rec.pay_type) && s0(rec.pay_type) !== 'once') return;
      if (t0(f[k]) !== t0(rec[k])) patch[k] = k === 'potential' ? numOrBlank(f[k]) : t0(f[k]);
    });
    return patch;
  }

  // ── Деньги формы ─────────────────────────────────────────────────────────
  function sortUnpaid(list) {
    return (list || []).slice().sort((a, b) => s0(a.ship_day || '9999').localeCompare(s0(b.ship_day || '9999')) ||
                                               s0(a.product).localeCompare(s0(b.product)) || s0(a.id).localeCompare(s0(b.id)));
  }
  function shipmentTotal(items) {
    return r2((items || []).reduce((a, i) => { const q = n(i.qty), p = n(i.price); return a + (q > 0 && p >= 0 ? r2(q * p) : 0); }, 0));
  }
  // Строго по порядку: дошли до позиции, на которую не хватает целиком, — берём
  // целые штуки, сколько хватает, и останавливаемся; остаток — аванс.
  function fifo(unpaid, received) {
    let rest = r2(n(received) || 0);
    const qty = {};
    for (const u of sortUnpaid(unpaid)) {
      if (rest <= 0) break;
      const price = Number(u.price) || 0, left = Number(u.left_qty) || 0;
      if (price <= 0 || left <= 0) continue;
      const full = r2(left * price);
      if (full <= rest + 0.005) { qty[u.id] = left; rest = r2(rest - full); continue; }
      const k = Math.min(Math.floor((rest + 0.005) / price), Math.floor(left));
      if (k > 0) { qty[u.id] = k; rest = r2(rest - k * price); }
      break;
    }
    return { qty, advance: rest > 0 ? rest : 0 };
  }
  function paymentTotals(form) {
    const by = {};
    (form.unpaid || []).forEach(u => { by[u.id] = u; });
    let itemsSum = 0, lines = 0;
    const over = [];
    Object.keys(form.qty || {}).forEach(id => {
      const q = n(form.qty[id]), u = by[id];
      if (!(q > 0) || !u) return;
      lines++;
      itemsSum += r2(r3(q) * Number(u.price));
      if (q > Number(u.left_qty) + 1e-6) over.push(id);
    });
    const adv = n(form.f.advance) > 0 ? r2(n(form.f.advance)) : 0;
    return { lines, itemsSum: r2(itemsSum), advance: adv, total: r2(itemsSum + adv), over };
  }

  // ── Разметка ─────────────────────────────────────────────────────────────
  function field(id, label, control, wide) {
    return '<div class="st-field' + (wide ? ' wide' : '') + '"><label for="' + id + '">' + esc(label) + '</label>' + control + '</div>';
  }
  function input(id, value, attrs) {
    return '<input id="' + id + '" ' + (attrs || 'type="text"') + ' autocomplete="off" value="' + esc(s0(value)) + '">';
  }
  function select(id, opts, value, attrs) {
    return '<select id="' + id + '"' + (attrs ? ' ' + attrs : '') + '>' + opts.map(o => {
      const v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      return '<option value="' + esc(v) + '"' + (s0(value) === s0(v) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('') + '</select>';
  }
  // В списке — то, что уже стоит в записи, даже если его нет в справочнике
  // (старые строки листа): иначе правка комментария молча сменила бы тип.
  const withCurrent = (list, cur) => (t0(cur) && list.indexOf(t0(cur)) < 0 ? [t0(cur)].concat(list) : list);
  // Для правки: в записи пусто — первым пункт «—». Без него браузер показал бы
  // выбранным первый пункт справочника, а выбрать его было бы нельзя: выбор
  // уже выбранного не меняет поле, и в базу ничего не уходит.
  const choices = (list, cur) => (t0(cur) ? withCurrent(list, cur) : [['', '—']].concat(list));
  const dupBox = (f, label) => '<div class="st-field wide"><label class="b2b-f-check"><input id="bfAllowDup" type="checkbox"' +
    (f.allow_duplicate ? ' checked' : '') + '> ' + esc(label) + '</label></div>';
  function msgHtml(m) {
    return m ? '<div class="st-msg ' + (m.tone === 'bad' ? 'st-bad-text' : 'st-good-text') + '" role="status">' + esc(m.text) + '</div>' : '';
  }
  function partnerSelect(id, clients, cid) {
    const list = (clients || []).slice().sort((a, b) => s0(a.name || a.id).localeCompare(s0(b.name || b.id), 'ru'));
    return '<select id="' + id + '"><option value="">— выберите партнёра —</option>' + list.map(c =>
      '<option value="' + esc(c.id) + '"' + (s0(c.id) === s0(cid) ? ' selected' : '') + '>' +
      esc((c.name || c.id) + (c.city ? ' · ' + c.city : '') + (c.type ? ' · ' + c.type : '')) + '</option>').join('') + '</select>';
  }
  function filesField(form, accept) {
    const list = (form.files || []).map(f => esc(f.name)).join(', ');
    return field('bfFiles', 'Фото и документы — до ' + MAX_FILES + ', до ' + MAX_FILE_MB + ' МБ', '<input id="bfFiles" type="file" multiple accept="' + accept +
      '"><span class="b2b-files-picked muted">' + (list || 'не выбраны') + '</span>', true);
  }
  function itemsTable(form, prods, withPrice, withUnit) {
    const total = shipmentTotal(form.items);
    const rows = form.items.map((it, i) => '<tr>' +
      '<td><select data-bf-item="' + i + '" data-bf-col="product" aria-label="Товар, строка ' + (i + 1) + '">' +
        '<option value="">— товар —</option>' + withCurrent(prods, it.product).map(p =>
        '<option' + (t0(it.product) === p ? ' selected' : '') + '>' + esc(p) + '</option>').join('') + '</select></td>' +
      '<td data-label="Кол-во"><input type="number" inputmode="decimal" min="0" step="any" data-bf-item="' + i + '" data-bf-col="qty" value="' +
        esc(s0(it.qty)) + '" aria-label="Количество, строка ' + (i + 1) + '"></td>' +
      (withUnit ? '<td data-label="Ед."><input type="text" data-bf-item="' + i + '" data-bf-col="unit" maxlength="10" value="' + esc(s0(it.unit || 'шт')) +
        '" aria-label="Единица, строка ' + (i + 1) + '"></td>' : '') +
      (withPrice ? '<td data-label="Цена, ₸"><input type="number" inputmode="decimal" min="0" step="any" data-bf-item="' + i + '" data-bf-col="price" value="' +
        esc(s0(it.price)) + '" aria-label="Цена, строка ' + (i + 1) + '"></td>' : '') +
      '<td class="num b2b-f-sum">' + (n(it.qty) > 0 && n(it.price) >= 0 ? tg(r2(n(it.qty) * n(it.price))) : '—') + '</td>' +
      '<td>' + (form.items.length > 1 ? '<button type="button" class="ghost small" data-action="b2b-f-item-del" data-i="' + i +
        '" aria-label="Убрать строку ' + (i + 1) + '">✕</button>' : '') + '</td></tr>').join('');
    return '<div class="st-field wide"><span class="b2b-f-label">Позиции</span><div class="table-scroll"><table class="grid b2b-f-items b2b-f-lines"><thead><tr>' +
      '<th scope="col" class="txt">Товар</th><th scope="col">Кол-во</th>' + (withUnit ? '<th scope="col" class="txt">Ед.</th>' : '') +
      (withPrice ? '<th scope="col">Цена, ₸</th>' : '') + '<th scope="col">Сумма</th><th scope="col"></th></tr></thead><tbody>' + rows +
      '</tbody></table></div><div class="st-form-actions"><button type="button" class="ghost small" data-action="b2b-f-item-add">+ строка</button>' +
      '<span class="b2b-f-total">Итого: <b id="bfTotal">' + tg(total) + '</b></span></div></div>';
  }

  const TITLES = { client: 'Новый партнёр', visit: 'Визит', shipment: 'Поставка', payment: 'Оплата', round: 'Обход',
                   branch: 'Филиал', edit: 'Изменить партнёра', delclient: 'Удалить партнёра' };
  const ROW_TITLES = { shipment: 'Изменить поставку', payment: 'Изменить оплату', visit: 'Изменить визит', branch: 'Изменить филиал' };
  const SAVE = { client: 'Добавить партнёра', visit: 'Записать визит', shipment: 'Оформить поставку', payment: 'Записать оплату',
                 round: 'Записать обход', branch: 'Добавить филиал', edit: 'Сохранить', row: 'Сохранить', delclient: 'Удалить безвозвратно' };
  const formTitle = form => (form.kind === 'row' ? ROW_TITLES[form.rowKind] + ' ' + form.id : TITLES[form.kind]);

  // m — модель экрана (b2b.js prepare), opts: { today, perm, nomen, cm (карточка партнёра, если форма в ней) }
  function renderForm(form, m, opts) {
    if (!form) return '';
    const o = opts || {}, f = form.f, today = o.today, busy = form.busy;
    const clients = (m && m.clients) || [];
    const c = (m && m.byId && m.byId[form.cid]) || null;
    const inCard = !!o.cm;
    const who = inCard ? '' : field('bfClient', 'Партнёр', partnerSelect('bfClient', clients, form.cid), true);
    const H = [];
    const title = formTitle(form);
    H.push('<div class="st-form b2b-f" id="b2bForm" data-kind="' + esc(form.kind) + '"><div class="b2b-f-head"><h3 class="st-subhead">' +
      esc(title) + (inCard && c && form.kind !== 'edit' && form.kind !== 'row' && form.kind !== 'delclient' ? ' · ' + esc(c.name || c.id) : '') +
      '</h3><button type="button" class="ghost small" data-action="b2b-f-close">Закрыть</button></div>');
    if (o.perm && o.perm.training) {
      H.push('<p class="st-explain b2b-f-train">Тренировка: запись сотрёт следующий перенос из листов. Настоящие поставки и оплаты — пока в старом табе.</p>');
    }
    H.push('<div class="st-fields">');
    if (form.kind === 'client') {
      H.push(field('bfName', 'Название', input('bfName', f.name, 'type="text" maxlength="200"'), true),
             field('bfType', 'Тип', select('bfType', TYPES, f.type)), field('bfStage', 'Стадия', select('bfStage', STAGES, f.stage)),
             field('bfCity', 'Город', input('bfCity', f.city, 'type="text" maxlength="100"')),
             field('bfPriority', 'Приоритет', select('bfPriority', PRIOS, f.priority)),
             field('bfAddress', 'Адрес', input('bfAddress', f.address, 'type="text" maxlength="300"'), true),
             field('bfContact', 'Контакт', input('bfContact', f.contact, 'type="text" maxlength="200"')),
             field('bfPhone', 'Телефон', input('bfPhone', f.phone, 'type="tel" maxlength="40" placeholder="+7 701 123 45 67"')),
             field('bfCounterparty', 'Контрагент (юрлицо для счетов)', input('bfCounterparty', f.counterparty, 'type="text" maxlength="300"'), true),
             field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true));
      if (form.dupAsk) H.push(dupBox(f, 'Это другой партнёр — всё равно добавить'));
    } else if (form.kind === 'visit') {
      if (!inCard) {
        H.push('<div class="st-field wide"><label class="b2b-f-check"><input id="bfNewClient" type="checkbox"' + (form.newClient ? ' checked' : '') +
          '> Новая точка — её ещё нет в списке</label></div>');
        if (form.newClient) {
          H.push(field('bfNcName', 'Название новой точки', input('bfNcName', form.nc.name, 'type="text" maxlength="200"'), true),
                 field('bfNcType', 'Тип', select('bfNcType', TYPES, form.nc.type)),
                 field('bfNcCity', 'Город', input('bfNcCity', form.nc.city, 'type="text" maxlength="100"')),
                 field('bfNcAddress', 'Адрес', input('bfNcAddress', form.nc.address, 'type="text" maxlength="300"'), true));
          if (form.dupAsk) H.push(dupBox(f, 'Это другая точка — всё равно добавить новым партнёром'));
        } else H.push(who);
      }
      H.push(field('bfDay', 'Дата визита', input('bfDay', f.day, 'type="date" max="' + today + '"')),
             field('bfResult', 'Результат', select('bfResult', [['', '— выберите —']].concat(RESULTS), f.result)),
             field('bfPotential', 'Потенциал в месяц, ₸', input('bfPotential', f.potential, 'type="number" inputmode="numeric" min="0" step="1000"')),
             field('bfNextDay', 'Следующий контакт', input('bfNextDay', f.next_day, 'type="date" min="' + (f.day || today) + '"')),
             field('bfContact', 'С кем говорили', input('bfContact', f.contact, 'type="text" maxlength="200" placeholder="' +
               esc((c && c.contact) || 'из карточки партнёра') + '"')),
             field('bfPhone', 'Телефон', input('bfPhone', f.phone, 'type="tel" maxlength="40" placeholder="' +
               esc((c && c.phone) || 'из карточки партнёра') + '"')),
             field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true),
             filesField(form, 'image/*,application/pdf,.doc,.docx'));
    } else if (form.kind === 'shipment') {
      const branches = ((m && m.branches) || []).filter(b => s0(b.client_id) === s0(form.cid));
      H.push(who);
      if (branches.length) H.push(field('bfBranch', 'Филиал', select('bfBranch', [['', '— сам партнёр —']].concat(branches.map(b =>
        [b.id, (b.name || b.address || b.id) + (b.address && b.name ? ' · ' + b.address : '')])), f.branch_id), true));
      H.push(field('bfShipDay', 'Дата поставки', input('bfShipDay', f.ship_day, 'type="date" max="' + today + '"')),
             field('bfPayType', 'Оплата', select('bfPayType', PAY_TYPES, f.pay_type)));
      if (f.pay_type === 'once') H.push(field('bfDueDay', 'Срок оплаты (пусто — месяц от поставки)',
        input('bfDueDay', f.due_day, 'type="date" min="' + (f.ship_day || today) + '"')));
      if (f.pay_type === 'monthly') H.push(field('bfMonthDay', 'Число месяца (следующего)', input('bfMonthDay', f.month_day,
        'type="number" inputmode="numeric" min="1" max="28" step="1"')));
      if (f.pay_type === 'weekly') H.push(field('bfWeekday', 'День недели', select('bfWeekday', WEEKDAYS, f.weekday)));
      if (f.pay_type !== 'consignment') H.push(field('bfStatus', 'Статус', select('bfStatus', [['Отгружено', 'Отгружено'],
        ['Возврат', 'Возврат — товар вернулся']], f.status)));
      H.push(itemsTable(form, products(o.nomen), true, true),
             field('bfInvoice', '№ накладной', input('bfInvoice', f.invoice_no, 'type="text" maxlength="50"')),
             field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true),
             filesField(form, 'image/*,application/pdf,.doc,.docx'));
    } else if (form.kind === 'payment') {
      H.push(who, renderPayItems(form),
             field('bfAdvance', 'Аванс — сверх позиций, ₸', input('bfAdvance', f.advance, 'type="number" inputmode="decimal" min="0" step="any"')),
             field('bfDay', 'Дата оплаты', input('bfDay', f.day, 'type="date" max="' + today + '"')),
             field('bfMethod', 'Способ', select('bfMethod', METHODS, f.method)),
             field('bfReceipt', '№ платёжки', input('bfReceipt', f.receipt_no, 'type="text" maxlength="50"')),
             field('bfReceiver', 'Кто принял (пусто — вы)', input('bfReceiver', f.receiver, 'type="text" maxlength="100"')),
             field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true));
    } else if (form.kind === 'round') {
      H.push(who, field('bfDay', 'Дата обхода', input('bfDay', f.day, 'type="date" max="' + today + '"')),
             itemsTable(form, products(o.nomen), true, false),
             field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true));
    } else if (form.kind === 'branch') {
      H.push(field('bfName', 'Название (пусто — адрес)', input('bfName', f.name, 'type="text" maxlength="200"'), true),
             field('bfAddress', 'Адрес', input('bfAddress', f.address, 'type="text" maxlength="300"'), true),
             field('bfCity', 'Город', input('bfCity', f.city, 'type="text" maxlength="100"')),
             field('bfContact', 'Контакт', input('bfContact', f.contact, 'type="text" maxlength="200"')),
             field('bfPhone', 'Телефон', input('bfPhone', f.phone, 'type="tel" maxlength="40"')),
             field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true));
    } else if (form.kind === 'edit') {
      H.push(field('bfName', 'Название', input('bfName', f.name, 'type="text" maxlength="200"'), true),
             field('bfType', 'Тип', select('bfType', choices(TYPES, f.type), f.type)),
             field('bfStage', 'Стадия', select('bfStage', choices(STAGES, f.stage), f.stage)),
             field('bfCity', 'Город', input('bfCity', f.city, 'type="text" maxlength="100"')),
             field('bfPriority', 'Приоритет', select('bfPriority', choices(PRIOS, f.priority), f.priority)),
             field('bfAddress', 'Адрес', input('bfAddress', f.address, 'type="text" maxlength="300"'), true),
             field('bfContact', 'Контакт', input('bfContact', f.contact, 'type="text" maxlength="200"')),
             field('bfPhone', 'Телефон', input('bfPhone', f.phone, 'type="tel" maxlength="40"')),
             field('bfRep', 'Ответственный', input('bfRep', f.rep, 'type="text" maxlength="100"')),
             field('bfCounterparty', 'Контрагент (юрлицо для счетов)', input('bfCounterparty', f.counterparty, 'type="text" maxlength="300"'), true),
             field('bfContractNo', 'Договор №', input('bfContractNo', f.contract_no, 'type="text" maxlength="50"')),
             field('bfContractDate', 'Дата договора', input('bfContractDate', f.contract_date, 'type="date" max="' + today + '"')),
             field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true));
    } else if (form.kind === 'row') {
      H.push(renderRowFields(form, today));
    } else if (form.kind === 'delclient') {
      const cm = o.cm, nm = c ? (c.name || c.id) : form.cid;
      const parts = cm ? [[cm.ships.length, 'поставка', 'поставки', 'поставок'], [cm.pays.length, 'оплата', 'оплаты', 'оплат'],
                          [cm.visits.length, 'визит', 'визита', 'визитов'], [cm.branches.length, 'филиал', 'филиала', 'филиалов'],
                          [cm.docs.length, 'документ', 'документа', 'документов']].filter(p => p[0] > 0) : [];
      H.push('<div class="st-field wide">' + '<div class="st-alert st-alert-bad"><b>Удаляется партнёр со всей историей</b>' +
        (parts.length ? ': ' + esc(parts.map(p => p[0] + ' ' + plural(p[0], p[1], p[2], p[3])).join(', ')) : '') +
        (cm && cm.fin.rest > 0.5 ? '. <b>Он должен ' + esc(tg(cm.fin.rest)) + '</b> — этот долг пропадёт из «Остатка».' : '.') +
        ' Записи остаются в базе с отметкой «удалено», но со страницы и из расчётов исчезают.</div></div>',
        field('bfConfirm', 'Чтобы удалить, введите название: ' + nm, input('bfConfirm', f.confirm, 'type="text" maxlength="200"'), true));
    }
    H.push('</div>');
    const danger = form.kind === 'delclient';
    H.push('<div class="st-form-actions"><button type="button"' + (danger ? ' class="danger"' : '') + ' data-action="b2b-f-save"' +
      (busy ? ' disabled' : '') + '>' + esc(busy ? 'Сохраняю…' : form.kind === 'payment' ? payButton(form) : SAVE[form.kind]) + '</button>' +
      (form.kind === 'shipment' || form.kind === 'visit' ? '<span class="muted b2b-f-note">файлы загрузятся вместе с записью</span>' : '') +
      '</div>' + msgHtml(form.msg) + '</div>');
    return H.join('');
  }
  function payButton(form) {
    const t = paymentTotals(form);
    return t.total > 0 ? 'Записать оплату ' + tg(t.total) : 'Записать оплату';
  }
  function renderRowFields(form, today) {
    const f = form.f, rk = form.rowKind, rec = form.rec || {};
    if (rk === 'shipment') {
      const once = !s0(rec.pay_type) || s0(rec.pay_type) === 'once';
      return field('bfShipDay', 'Дата поставки', input('bfShipDay', f.ship_day, 'type="date" max="' + today + '"')) +
        (once ? field('bfDueDay', 'Срок оплаты (пусто — месяц от поставки)', input('bfDueDay', f.due_day, 'type="date"'))
              : '<div class="st-field"><span class="b2b-f-label">Срок оплаты</span><span class="muted">по графику ' + esc(s0(rec.pay_schedule)) + '</span></div>') +
        field('bfStatus', 'Статус', select('bfStatus', choices(STATUSES, f.status), f.status)) +
        field('bfInvoice', '№ накладной', input('bfInvoice', f.invoice_no, 'type="text" maxlength="50"')) +
        field('bfRep', 'Торгпред', input('bfRep', f.rep, 'type="text" maxlength="100"')) +
        field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true) +
        '<p class="st-explain wide">Сумма и товары поставки не правятся: ошиблись в позициях — удалите поставку и оформите заново.</p>';
    }
    if (rk === 'payment') {
      return field('bfPayDay', 'Дата оплаты', input('bfPayDay', f.pay_day, 'type="date" max="' + today + '"')) +
        field('bfMethod', 'Способ', select('bfMethod', choices(METHODS, f.method), f.method)) +
        field('bfReceipt', '№ платёжки', input('bfReceipt', f.receipt_no, 'type="text" maxlength="50"')) +
        field('bfReceiver', 'Кто принял', input('bfReceiver', f.receiver, 'type="text" maxlength="100"')) +
        field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true) +
        '<p class="st-explain wide">Сумма считается из позиций: ошиблись — удалите оплату и внесите заново.</p>';
    }
    if (rk === 'visit') {
      return field('bfDay', 'Дата визита', input('bfDay', f.day, 'type="date" max="' + today + '"')) +
        field('bfResult', 'Результат', select('bfResult', choices(RESULTS, f.result), f.result)) +
        field('bfPotential', 'Потенциал в месяц, ₸', input('bfPotential', f.potential, 'type="number" inputmode="numeric" min="0" step="1000"')) +
        field('bfNextDay', 'Следующий контакт', input('bfNextDay', f.next_day, 'type="date"')) +
        field('bfContact', 'Контакт', input('bfContact', f.contact, 'type="text" maxlength="200"')) +
        field('bfPhone', 'Телефон', input('bfPhone', f.phone, 'type="tel" maxlength="40"')) +
        field('bfRep', 'Торгпред', input('bfRep', f.rep, 'type="text" maxlength="100"')) +
        field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true);
    }
    return field('bfName', 'Название', input('bfName', f.name, 'type="text" maxlength="200"'), true) +
      field('bfAddress', 'Адрес', input('bfAddress', f.address, 'type="text" maxlength="300"'), true) +
      field('bfCity', 'Город', input('bfCity', f.city, 'type="text" maxlength="100"')) +
      field('bfContact', 'Контакт', input('bfContact', f.contact, 'type="text" maxlength="200"')) +
      field('bfPhone', 'Телефон', input('bfPhone', f.phone, 'type="tel" maxlength="40"')) +
      field('bfComment', 'Комментарий', input('bfComment', f.comment, 'type="text" maxlength="1000"'), true);
  }

  // Оплата: за что платят — список из базы (v_b2b_unpaid_items), старое сверху.
  function renderPayItems(form) {
    if (!form.cid) return '<div class="st-field wide"><p class="st-explain">Выберите партнёра — появится список того, за что он ещё не заплатил.</p></div>';
    if (form.unpaid === null) return '<div class="st-field wide"><p class="st-explain" role="status">Загружаю, за что можно платить…</p></div>';
    if (form.unpaidErr) return '<div class="st-field wide"><div class="st-alert st-alert-bad">' + esc(form.unpaidErr) + '</div></div>';
    if (!form.unpaid.length) return '<div class="st-field wide"><p class="st-explain">Неоплаченных позиций нет. Деньги без позиций — это аванс: ' +
      'база примет оплату только с разбивкой по отгруженному.</p></div>';
    const t = paymentTotals(form), over = new Set(t.over);
    const totalLeft = r2(form.unpaid.reduce((a, u) => a + Number(u.left_sum || 0), 0));
    const rows = sortUnpaid(form.unpaid).map(u => '<tr class="' + (over.has(u.id) ? 'over' : '') + '">' +
      '<th scope="row" class="who">' + esc(u.product) + '<div class="where">' + esc(u.shipment_id || '') + ' · ' + dmy(u.ship_day) +
        (u.consign ? ' · под реализацию' : '') + '</div></th>' +
      '<td class="num">' + esc(nf3.format(Number(u.left_qty))) + ' ' + esc(u.unit || 'шт') + '<div class="b2b-sub">по ' + tg(Number(u.price)) + '</div></td>' +
      '<td class="num">' + tg(Number(u.left_sum)) + '</td>' +
      '<td><input type="number" inputmode="decimal" min="0" step="any" max="' + esc(s0(u.left_qty)) + '" data-bf-pay="' + esc(u.id) +
        '" value="' + esc(s0(form.qty[u.id] === undefined ? '' : form.qty[u.id])) + '" aria-label="Оплачено штук: ' + esc(u.product) + '"></td></tr>').join('');
    return '<div class="st-field wide"><span class="b2b-f-label">За что оплата — ещё не оплачено на ' + esc(tg(totalLeft)) + '</span>' +
      '<div class="b2b-f-fifo"><input id="bfReceived" type="number" inputmode="decimal" min="0" step="any" placeholder="Сколько пришло, ₸" value="' +
        esc(s0(form.f.received)) + '" aria-label="Сколько пришло, тенге"><button type="button" class="ghost" data-action="b2b-f-fifo">Разнести по старым</button></div>' +
      '<div class="table-scroll tall"><table class="grid b2b-f-items b2b-f-pay"><thead><tr><th scope="col" class="txt">Позиция</th><th scope="col">Осталось</th>' +
      '<th scope="col">На сумму</th><th scope="col">Оплачено, шт</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="b2b-f-total" id="bfPaySum">' + paySumText(t) + '</div></div>';
  }
  function paySumText(t) {
    if (t.over.length) return '<span class="st-bad-text">По ' + t.over.length + ' ' + plural(t.over.length, 'позиции', 'позициям', 'позициям') +
      ' введено больше, чем осталось</span>';
    if (!t.lines) return '<span class="muted">Отметьте количество или разнесите сумму</span>';
    return 'Позиций ' + t.lines + ' на ' + tg(t.itemsSum) + (t.advance > 0 ? ' + аванс ' + tg(t.advance) : '') + ' = <b>' + tg(t.total) + '</b>';
  }

  // Кнопки «Внести» над экраном и в карточке.
  function renderActions(p, inCard) {
    if (!p || !p.write) return '';
    const b = (kind, label, cls) => '<button type="button" class="' + (cls || 'ghost') + ' small" data-action="b2b-f-open" data-kind="' + kind + '">' +
      esc(label) + '</button>';
    const list = inCard
      ? [b('visit', '+ Визит'), b('shipment', '+ Поставка')].concat(p.canPay ? [b('payment', '+ Оплата')] : [])
          .concat([b('round', '+ Обход'), b('branch', '+ Филиал'), b('edit', 'Изменить партнёра')])
          .concat(p.canPay ? [b('delclient', 'Удалить партнёра…', 'ghost danger-text')] : [])
      : [b('visit', '+ Визит'), b('shipment', '+ Поставка')].concat(p.canPay ? [b('payment', '+ Оплата')] : [])
          .concat([b('round', '+ Обход'), b('client', '+ Партнёр')]);
    return '<div class="b2b-actions" role="toolbar" aria-label="Внести">' + list.join('') + '</div>';
  }

  function renderTraining(p) {
    if (!p || !p.training) return '';
    return '<div class="st-alert st-alert-warn b2b-train" role="status"><b>Тренировка.</b> B2B ещё вносится в старом табе и мобильном — ' +
      'источник правды листы. Всё, что вы запишете здесь, сотрёт следующий перенос из таблицы (когда листы приедут), и в отчёты это не попадёт. ' +
      '<button type="button" class="ghost small" data-action="b2b-train-reset">Стереть тренировку сейчас</button></div>';
  }

  // Действия строки в карточке: «Изменить» и «Удалить» (второе нажатие — подтверждение).
  function rowActions(p, kind, id, confirm) {
    if (!p || !p.write) return '';
    if ((kind === 'payment') && !p.canPay) return '<td></td>';
    const key = kind + ':' + id;
    if (confirm === key) {
      return '<td class="b2b-row-act"><button type="button" class="danger small" data-action="b2b-del-yes" data-kind="' + kind + '" data-id="' + esc(id) +
        '">Удалить ' + esc(id) + '</button> <button type="button" class="ghost small" data-action="b2b-del-no">Нет</button></td>';
    }
    return '<td class="b2b-row-act">' + (kind !== 'round' ? '<button type="button" class="ghost small" data-action="b2b-f-open" data-kind="row" data-rowkind="' +
      kind + '" data-id="' + esc(id) + '" aria-label="Изменить ' + esc(id) + '">Изменить</button> ' : '') +
      '<button type="button" class="ghost small" data-action="b2b-del" data-kind="' + kind + '" data-id="' + esc(id) +
      '" aria-label="Удалить ' + esc(id) + '">Удалить</button></td>';
  }

  // Что сказать после записи — по ответу базы.
  function savedText(kind, res, extra) {
    const d = res || {}, tr = d.training ? ' Тренировка — сотрётся при следующем переносе.' : '';
    if (kind === 'client') return 'Добавлен партнёр ' + d.id + '.' + tr;
    if (kind === 'visit') return 'Записан визит ' + d.id + (d.new_client ? ' и новый партнёр ' + d.client_id : '') + '.' + tr;
    if (kind === 'shipment') return 'Оформлена поставка ' + d.id + ' на ' + tg(Number(d.amount) || 0) + ' · срок оплаты ' + dmy(d.due_day) + '.' +
      (extra && extra.files ? ' Файлов: ' + extra.files + '.' : '') + tr;
    if (kind === 'payment') return 'Записана оплата ' + d.id + ' на ' + tg(Number(d.amount) || 0) +
      (Number(d.advance) > 0 ? ' (из них аванс ' + tg(Number(d.advance)) + ')' : '') + '.' + tr;
    if (kind === 'round') return 'Записан обход ' + d.id + ' на ' + tg(Number(d.amount) || 0) + '.' + tr;
    if (kind === 'branch') return 'Добавлен филиал ' + d.id + '.' + tr;
    if (kind === 'delclient') return 'Партнёр ' + (d.name || d.id) + ' удалён: записей отмечено ' + (d.total || 0) + '.' + tr;
    return 'Сохранено.' + tr;
  }

  // Имя файла в хранилище: visits|shipments/ГГГГ-ММ/<uuid>.<расш> — шаблон
  // политики загрузки (sql/31, раздел 9).
  const EXT_OK = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'doc', 'docx'];
  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
                 pdf: 'application/pdf', doc: 'application/msword',
                 docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  function extOf(name, type) {
    const m = /\.([a-z0-9]{2,5})$/i.exec(s0(name));
    const e = m ? m[1].toLowerCase() : '';
    if (EXT_OK.indexOf(e) >= 0) return e;
    const byType = Object.keys(MIME).find(k => MIME[k] === s0(type).toLowerCase());
    return byType || '';
  }
  function storagePath(kind, today, uuid, ext) {
    return (kind === 'shipment' ? 'shipments' : 'visits') + '/' + s0(today).slice(0, 7) + '/' + s0(uuid).toLowerCase() + '.' + ext;
  }
  const isStorage = f => !!s0(f) && !/^https?:\/\//i.test(s0(f));

  root.NietteB2bForms = {
    TYPES, STAGES, PRIOS, RESULTS, METHODS, STATUSES, PAY_TYPES, WEEKDAYS, PRICES, ROW_FIELDS, MAX_FILES, MAX_FILE_MB, EXT_OK, MIME,
    perm, products, priceOf, newForm, emptyItem, formTitle, dupKey, rowProblem,
    clientPayload, visitPayload, shipmentPayload, paymentPayload, roundPayload, branchPayload, clientChanges, rowPatch, schedule,
    sortUnpaid, shipmentTotal, fifo, paymentTotals, paySumText,
    renderForm, renderActions, renderTraining, rowActions, savedText, extOf, storagePath, isStorage
  };
})(typeof window !== 'undefined' ? window : globalThis);
