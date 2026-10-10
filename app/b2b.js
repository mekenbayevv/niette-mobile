/* Экран «B2B» нового фронта: расчёты и разметка (sql/28_b2b.sql).
 *
 * Как clients.js и stock.js — только чистые функции: строки таблиц b2b_* на
 * вход, числа и строка HTML на выход. Сеть, состояние и события — в app.js.
 * Поэтому всё здесь проверяется в Node (tests/app_b2b_test.js), а расчёты —
 * против НАСТОЯЩИХ функций старого таба из Dashboard.html и b2b_backend.gs.
 *
 * ЭТАП 1 — ТОЛЬКО ЧТЕНИЕ. До дня переключения источник правды — таблица:
 * поставки, оплаты и визиты вносятся в старом табе и мобильном торгпреда,
 * сюда приходят с зеркалом (вместе с новыми заказами Kaspi — днём через
 * 15–30 минут). Кнопок записи здесь нет.
 *
 * ПРАВИЛА СЧЁТА — СТАРОГО ТАБА, слово в слово (комментарии там же, в
 * Dashboard.html, у функций с теми же именами):
 *   «Реализация»  ВХОДИТ в «Поставлено», но не в долг: партнёр за товар под
 *                 реализацию не должен, пока не продал;
 *   «Возврат»     со знаком минус, как бы ни была вбита сумма;
 *   «затих»       долг есть, а месяц нет ни поставок, ни оплат;
 *   срок оплаты   «Дата ожид. оплаты», иначе график (monthly:15 — 15-го
 *                 СЛЕДУЮЩЕГО месяца, weekly:2 — ближайший вторник после),
 *                 иначе месяц от поставки — это допущение, помечается «~».
 * Отличия от старого (⚑) перечислены в renderNotes() — их немного, и каждое
 * исправляет ошибку старого таба, а не меняет определение.
 *
 * ДАТЫ — ТОЛЬКО СТРОКИ 'YYYY-MM-DD', арифметика в UTC, как в overview.js.
 */
(function (root) {
  'use strict';

  const C = root.NietteClients;
  const esc = C.esc, money = C.money;
  const NBSP = '\u00a0';
  const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const nf3 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

  const TYPES = [
    { key: 'all', label: 'Все' }, { key: 'Аптека', label: 'Аптеки' }, { key: 'Оптовик', label: 'Оптовики' },
    { key: 'Детский магазин', label: 'Детские' }, { key: 'Магазин', label: 'Магазины' }, { key: 'Прочие', label: 'Прочие' }
  ];
  const RESULTS = [
    { key: 'all', label: 'Все' }, { key: '✅', label: '✅ Договорились' }, { key: '📋', label: '📋 Консигнация' },
    { key: '🔄', label: '🔄 Реализация' }, { key: '🕐', label: '🕐 Думают' }, { key: '⚡', label: '⚡ Дозаказ' },
    { key: '❌', label: '❌ Отказали' }, { key: 'none', label: '— Нет визита' }
  ];
  // ⚑ Флаг u обязателен: без него [📋🔄🕐] в старом коде — это половинки
  // суррогатных пар, и «📞 Созвонился» с «🚗 Заехал» тоже считались
  // результатом переговоров (старая _OUTCOME_RE в finRenderB2b).
  const OUTCOME_RE = /^(?:✅|📋|🔄|🕐|⚡|❌)/u;
  const SORTS = {
    counterparty: 'Контрагент', name: 'Название', shipped: 'Отгружено на сумму', paid: 'Оплачено на сумму',
    debt: 'Остаток', payday: 'Ждём оплату', visit: 'Последний контакт'
  };
  const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  const n = v => Number(v) || 0;                    // Number(x) || 0, как в старом коде
  const s0 = v => String(v === null || v === undefined ? '' : v);
  const tg = v => money(Math.round(n(v)));
  function plural(k, one, few, many) {
    const a = Math.abs(Number(k) || 0) % 100, b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  }
  const pl = (k, one, few, many) => nf0.format(k) + ' ' + plural(k, one, few, many);

  // ── Даты ──────────────────────────────────────────────────────────────────
  function pad(x) { return String(x).padStart(2, '0'); }
  function parts(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function ofUtc(dt) { return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()); }
  function utcMs(iso) { const p = parts(iso); return p ? Date.UTC(p.y, p.m - 1, p.d) : NaN; }
  function addDays(iso, k) { const d = new Date(utcMs(iso)); d.setUTCDate(d.getUTCDate() + k); return ofUtc(d); }
  // _b2bAddMonth: 31.01 + месяц = 28.02, а не 3 марта.
  function addMonth(iso) {
    const p = parts(iso);
    if (!p) return '';
    const out = new Date(Date.UTC(p.y, p.m, p.d));
    if (out.getUTCDate() !== p.d) out.setUTCDate(0);
    return ofUtc(out);
  }
  function dayDiff(a, b) { return Math.round((utcMs(b) - utcMs(a)) / 86400000); }   // b − a
  function later(a, b) { return !a ? (b || '') : !b ? a : (a > b ? a : b); }       // _b2bLaterDay_
  function dow(iso) { return new Date(utcMs(iso)).getUTCDay(); }
  function dmy(iso) { const p = parts(iso); return p ? pad(p.d) + '.' + pad(p.m) + '.' + p.y : '—'; }
  function dateWords(iso) { const p = parts(iso); return p ? p.d + ' ' + MONTHS_GEN[p.m - 1] + ' ' + p.y : '—'; }
  function monthEnd(iso) { const p = parts(iso); return ofUtc(new Date(Date.UTC(p.y, p.m, 0))); }

  // ── Срок оплаты поставки (_b2bDueDate) ────────────────────────────────────
  function dueDate(s) {
    if (s.due_day) return { day: s.due_day, assumed: false, src: 'date' };
    const ship = s.ship_day;
    if (!ship) return { day: '', assumed: false, src: '' };
    const sched = s0(s.pay_schedule).trim();
    const m = /^monthly:(\d{1,2})$/.exec(sched);
    if (m) {
      // «Платят 5-го» = 5-го СЛЕДУЮЩЕГО месяца за товар прошлого.
      const day = Math.min(Math.max(Number(m[1]) || 1, 1), 28), p = parts(ship);
      return { day: ofUtc(new Date(Date.UTC(p.y, p.m, day))), assumed: false, src: 'monthly' };
    }
    const w = /^weekly:(\d)$/.exec(sched);
    if (w) {
      let step = (Number(w[1]) % 7 - dow(ship) + 7) % 7;
      if (step === 0) step = 7;                     // тот же день недели = через неделю
      return { day: addDays(ship, step), assumed: false, src: 'weekly' };
    }
    return { day: addMonth(ship), assumed: true, src: 'default' };
  }

  // Следующая дата по графику, начиная с from (_b2bNextBySchedule): «когда
  // ждать денег», а не «какой срок был у накладной».
  function nextBySchedule(sched, from) {
    const m = /^monthly:(\d{1,2})$/.exec(s0(sched).trim());
    if (m) {
      const day = Math.min(Math.max(Number(m[1]) || 1, 1), 28), p = parts(from);
      let d = ofUtc(new Date(Date.UTC(p.y, p.m - 1, day)));
      if (d < from) d = ofUtc(new Date(Date.UTC(p.y, p.m, day)));
      return d;
    }
    const w = /^weekly:(\d)$/.exec(s0(sched).trim());
    if (w) {
      let step = (Number(w[1]) % 7 - dow(from) + 7) % 7;
      if (step === 0) step = 7;
      return addDays(from, step);
    }
    return '';
  }

  // ── Долги по партнёрам (_b2bCalcDebtors_ из b2b_backend.gs) ───────────────
  // Из этой функции старый таб брал «Остаток» и «Счета затихли». Вторая
  // реализация того же — витрина v_b2b_balance (sql/28), тест сверяет обе.
  function firstById(clients) {
    const by = {};
    (clients || []).forEach(c => { if (!(c.id in by)) by[c.id] = c; });   // clients.find — первая строка
    return by;
  }
  function debtors(clients, ships, pays, today) {
    const by = {};
    const bucket = cid => (by[cid] = by[cid] || { shipped: 0, paid: 0, lastShip: '', lastPay: '' });
    (ships || []).forEach(s => {
      const cid = s.client_id;
      if (!cid) return;
      const st = s0(s.status).trim(), b = bucket(cid);
      b.lastShip = later(b.lastShip, s.ship_day || '');         // дата — даже у реализации
      if (st === 'Реализация') return;
      const raw = n(s.amount);
      b.shipped += st === 'Возврат' ? -Math.abs(raw) : raw;
    });
    (pays || []).forEach(p => {
      const cid = p.client_id;
      if (!cid) return;
      const b = bucket(cid);
      b.paid += n(p.amount);
      b.lastPay = later(b.lastPay, p.pay_day || '');
    });
    const byId = firstById(clients);
    return Object.keys(by).map(cid => {
      const f = by[cid], c = byId[cid] || {};
      const debt = f.shipped - f.paid;
      const quietFrom = later(addMonth(f.lastShip), f.lastPay ? addMonth(f.lastPay) : '');
      const overdueDebt = (debt > 0 && quietFrom && quietFrom < today) ? debt : 0;
      return { cid, name: c.name || cid, city: c.city || '', type: c.type || '',
               shipped: f.shipped, paid: f.paid, debt, overdueDebt, quietFrom: quietFrom || '',
               quietDays: overdueDebt > 0 ? dayDiff(quietFrom, today) : 0,
               lastShip: f.lastShip || '', lastPay: f.lastPay || '' };
    }).filter(r => r.debt > 0).sort((a, b) => b.debt - a.debt);
  }

  // ── Тишина по счёту (_b2bBuildAgingMap) ───────────────────────────────────
  // Та же «затихлость», что выше, но фронтовая: без поставок с датой счёт не
  // затихает (серверная версия смотрела бы на оплаты). Обе — как в старом:
  // KPI брал серверную, таблица и «Горит сегодня» — эту.
  function agingMap(ships, pays, today) {
    const acc = {};
    const get = cid => (acc[cid] = acc[cid] || { debt: 0, lastShip: '', lastPay: '' });
    (ships || []).forEach(s => {
      const cid = s0(s.client_id);
      if (!cid) return;
      const st = s0(s.status).trim(), raw = n(s.amount), a = get(cid);
      a.lastShip = later(a.lastShip, s.ship_day || '');
      if (st === 'Реализация') return;
      a.debt += st === 'Возврат' ? -Math.abs(raw) : raw;
    });
    (pays || []).forEach(p => {
      const cid = s0(p.client_id);
      if (!cid) return;
      const a = get(cid);
      a.debt -= n(p.amount);
      a.lastPay = later(a.lastPay, p.pay_day || '');
    });
    const out = {};
    Object.keys(acc).forEach(cid => {
      const a = acc[cid];
      if (a.debt <= 0 || !a.lastShip) return;
      const quietFrom = later(addMonth(a.lastShip), a.lastPay ? addMonth(a.lastPay) : '');
      if (!quietFrom || today <= quietFrom) return;
      const days = dayDiff(quietFrom, today);
      const bk = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
      if (days <= 30) bk.d30 = a.debt;
      else if (days <= 60) bk.d60 = a.debt;
      else if (days <= 90) bk.d90 = a.debt;
      else bk.d90plus = a.debt;
      out[cid] = Object.assign(bk, { maxDays: days, quietFrom, lastShip: a.lastShip, lastPay: a.lastPay });
    });
    return out;
  }

  function nextContactMap(visits) {
    const map = {};
    (visits || []).forEach(v => {
      const cid = s0(v.client_id), next = v.next_day || '';
      if (!cid || !next) return;
      if (!map[cid] || next < map[cid]) map[cid] = next;
    });
    return map;
  }

  // Последнее событие любого типа: визит, поставка, оплата. При одной дате
  // оплата перебивает поставку, поставка — визит (_b2bBuildLastTouchMap).
  function lastTouchMap(visits, ships, pays) {
    const map = {};
    const put = (cid, day, kind, rank, extra) => {
      if (!cid || !day) return;
      const cur = map[cid];
      if (cur && (cur.day > day || (cur.day === day && cur.rank >= rank))) return;
      map[cid] = Object.assign({ day, kind, rank }, extra || {});
    };
    (visits || []).forEach(v => {
      const res = s0(v.result);
      put(s0(v.client_id), v.day || '', 'visit', 1, {
        label: /^📞/u.test(res) ? 'Звонок' : /^🚗/u.test(res) ? 'Заезд' : 'Визит',
        icon: /^📞/u.test(res) ? '📞' : /^🚗/u.test(res) ? '🚗' : '🤝',
        note: res.replace(/^(?:✅|📋|🔄|🕐|⚡|❌|📞|🚗)\s*/u, '')
      });
    });
    (ships || []).forEach(s => {
      const st = s0(s.status).trim();
      put(s0(s.client_id), s.ship_day || '', 'ship', 2, {
        label: st === 'Реализация' ? 'Реализация' : st === 'Возврат' ? 'Возврат' : 'Поставка',
        icon: st === 'Возврат' ? '↩️' : '📦', amount: n(s.amount)
      });
    });
    (pays || []).forEach(p => {
      put(s0(p.client_id), p.pay_day || '', 'pay', 3, { label: 'Оплата', icon: '💵', amount: n(p.amount) });
    });
    return map;
  }

  function lastPayDateMap(pays) {
    const map = {};
    (pays || []).forEach(p => {
      const cid = s0(p.client_id), d = p.pay_day || '';
      if (!cid || !d) return;
      if (!map[cid] || d > map[cid]) map[cid] = d;
    });
    return map;
  }

  // Последний визит (любой) и последний РЕЗУЛЬТАТ переговоров (finRenderB2b).
  function visitMaps(visits) {
    const visitMap = {}, outcomeMap = {};
    (visits || []).forEach(v => {
      const cid = s0(v.client_id), date = v.day || '', result = v.result || '';
      if (!cid) return;
      if (!visitMap[cid] || date > visitMap[cid].date) visitMap[cid] = { date, result, comment: v.comment || '' };
      if (OUTCOME_RE.test(result) && (!outcomeMap[cid] || date > outcomeMap[cid].date)) outcomeMap[cid] = { date, result };
    });
    return { visitMap, outcomeMap };
  }

  // Итоги и «ждём оплату» по партнёру (_b2bBuildMoneyMaps).
  function moneyMaps(ships, pays, today) {
    const totalShip = {}, lastShipDate = {}, totalPaid = {}, lastPayAmt = {}, expectPay = {}, expectAssumed = {};
    const totalConsign = {}, lastPayDate = {}, shipByClient = {};
    (ships || []).forEach(s => {
      const cid = s0(s.client_id);
      if (!cid) return;
      const st = s0(s.status).trim(), raw = n(s.amount);
      const amt = st === 'Возврат' ? -Math.abs(raw) : raw;
      const sd = s.ship_day || '';
      if (sd && (!lastShipDate[cid] || sd > lastShipDate[cid])) lastShipDate[cid] = sd;
      totalShip[cid] = (totalShip[cid] || 0) + amt;
      if (st === 'Реализация') { totalConsign[cid] = (totalConsign[cid] || 0) + amt; return; }
      const due = dueDate(s);
      (shipByClient[cid] = shipByClient[cid] || []).push({ amount: amt, due: due.day, assumed: due.assumed,
                                                          sched: s0(s.pay_schedule).trim() });
    });
    (pays || []).forEach(p => {
      const cid = s0(p.client_id);
      if (!cid) return;
      const amt = n(p.amount);
      totalPaid[cid] = (totalPaid[cid] || 0) + amt;
      const pd = p.pay_day || '';
      if (pd && (!lastPayDate[cid] || pd > lastPayDate[cid])) { lastPayDate[cid] = pd; lastPayAmt[cid] = amt; }
    });
    // «Ждём оплату» — СЛЕДУЮЩАЯ дата денег: ближайший ненаступивший срок
    // неоплаченной поставки (FIFO), иначе следующая дата по графику, иначе
    // самый поздний прошедший срок — денег ждём прямо сейчас.
    Object.keys(shipByClient).forEach(cid => {
      let remaining = totalPaid[cid] || 0;
      const unpaidDue = [];
      shipByClient[cid].filter(s => s.due).sort((a, b) => utcMs(a.due) - utcMs(b.due)).forEach(s => {
        const unpaid = Math.max(0, s.amount - remaining);
        remaining = Math.max(0, remaining - s.amount);
        if (unpaid > 0) unpaidDue.push(s);
      });
      if (!unpaidDue.length) return;
      const future = unpaidDue.find(s => s.due >= today);
      if (future) { expectPay[cid] = future.due; expectAssumed[cid] = !!future.assumed; return; }
      const sched = unpaidDue.map(s => s.sched).filter(Boolean).pop();
      const next = sched ? nextBySchedule(sched, today) : '';
      if (next) { expectPay[cid] = next; expectAssumed[cid] = false; return; }
      const last = unpaidDue[unpaidDue.length - 1];
      expectPay[cid] = last.due; expectAssumed[cid] = !!last.assumed;
    });
    return { totalShip, lastShipDate, totalPaid, lastPayAmt, expectPay, expectAssumed, totalConsign };
  }

  // ── Модель экрана: всё, что не зависит от фильтров, — один раз ────────────
  function prepare(d, today) {
    const clients = d.clients || [], ships = d.shipments || [], pays = d.payments || [], visits = d.visits || [];
    const vm = visitMaps(visits);
    const debtList = debtors(clients, ships, pays, today);
    const debtMap = {};
    debtList.forEach(x => { debtMap[x.cid] = x; });
    return {
      today, clients, ships, pays, visits,
      items: d.items || [], payItems: d.payItems || [], branches: d.branches || [], docs: d.docs || [], rounds: d.rounds || [],
      byId: firstById(clients), visitMap: vm.visitMap, outcomeMap: vm.outcomeMap, debtList, debtMap,
      touchMap: lastTouchMap(visits, ships, pays), ageMap: agingMap(ships, pays, today),
      nextContact: nextContactMap(visits), lastPayDay: lastPayDateMap(pays), money: moneyMaps(ships, pays, today)
    };
  }

  // ── Срезы «Обзора» (_b2bOvClients / _b2bOvInScope) ────────────────────────
  // ui: { type, noWholesale, showClosed }. Закрытые выпадают из СПИСКОВ и из
  // «Активных точек», но их деньги остаются в «Поставлено» и «Остатке».
  function idsWhere(m, f) { return new Set(m.clients.filter(f).map(c => s0(c.id))); }
  function ovClients(m, ui) {
    let all = m.clients;
    if (ui.type !== 'all') all = all.filter(c => s0(c.type) === ui.type);
    if (ui.noWholesale) all = all.filter(c => s0(c.type) !== 'Оптовик');
    if (!ui.showClosed) all = all.filter(c => s0(c.stage) !== 'Закрыт');
    return all;
  }
  function ovInScope(m, ui, cid) {
    const c = m.byId[s0(cid)], type = c ? s0(c.type) : '';
    if (ui.noWholesale && type === 'Оптовик') return false;
    if (ui.type === 'all') return true;
    return !!c && type === ui.type;
  }

  // Предыдущий отрезок той же длины (b2bPrevPeriod). Открытый период — не с чем.
  function prevPeriod(p) {
    if (!p.from || !p.to || p.to < p.from) return null;
    const days = dayDiff(p.from, p.to) + 1, pb = addDays(p.from, -1);
    return { from: addDays(pb, -(days - 1)), to: pb, days };
  }

  // ── KPI «Обзора» (renderB2bKpi) ───────────────────────────────────────────
  // Потоки — за период (по дню поставки и дню оплаты; без даты не попадают
  // ни в один период, даже во «всё время» — как в старом). Остаток и
  // «затихли» — ВСЕГДА на сегодня: долг за календарный отрезок смысла не имеет.
  function kpis(m, ui, per) {
    const wholesale = idsWhere(m, c => s0(c.type) === 'Оптовик');
    const closed = ui.showClosed ? new Set() : idsWhere(m, c => s0(c.stage) === 'Закрыт');
    const typeScope = idsWhere(m, c => s0(c.type) === ui.type);
    const inScope = cid => {
      const id = s0(cid);
      if (ui.noWholesale && wholesale.has(id)) return false;
      return ui.type === 'all' || typeScope.has(id);
    };
    const scope = new Set(ovClients(m, ui).map(c => s0(c.id)));
    const ships = m.ships.filter(s => inScope(s.client_id));
    const pays = m.pays.filter(p => inScope(p.client_id));
    const inPer = (day, p) => !!day && (!p.from || day >= p.from) && (!p.to || day <= p.to);
    const shipAmt = s => {
      const st = s0(s.status).trim(), raw = n(s.amount);
      return { consign: st === 'Реализация', amt: st === 'Возврат' ? -Math.abs(raw) : raw, ret: st === 'Возврат' };
    };
    let shipped = 0, consign = 0, returned = 0, shipCount = 0;
    const active = new Set(), firstShipEver = {};
    ships.forEach(s => {
      const cid = s0(s.client_id), day = s.ship_day || '', a = shipAmt(s);
      // «Подключено» — первая поставка ЗА ВСЮ ИСТОРИЮ попала в период.
      if (cid && day && (!firstShipEver[cid] || day < firstShipEver[cid])) firstShipEver[cid] = day;
      if (!inPer(day, per)) return;
      if (a.consign) consign += a.amt;
      if (a.ret) returned += Math.abs(a.amt);
      shipped += a.amt;
      if (a.amt > 0) shipCount++;
      if (cid && !closed.has(cid)) active.add(cid);
    });
    let paid = 0;
    pays.forEach(p => { if (inPer(p.pay_day || '', per)) paid += n(p.amount); });
    const ds = Object.keys(m.debtMap).map(k => m.debtMap[k]).filter(d => inScope(d.cid));
    const billable = shipped - consign;
    const prev = prevPeriod(per);
    let prevSum = null;
    if (prev) { prevSum = 0; ships.forEach(s => { if (inPer(s.ship_day || '', prev)) prevSum += shipAmt(s).amt; }); }
    return {
      shipped, consign, returned, shipCount, paid,
      payRate: billable > 0 ? Math.round(paid / billable * 100) : 0,
      debt: ds.reduce((a, d) => a + n(d.debt), 0), overdue: ds.reduce((a, d) => a + n(d.overdueDebt), 0), debtorsN: ds.length,
      active: active.size, newN: Object.keys(firstShipEver).filter(k => inPer(firstShipEver[k], per)).length,
      avg: shipCount ? shipped / shipCount : 0, total: scope.size || m.clients.length,
      prev, prevSum, delta: prev && prevSum > 0 ? Math.round((shipped - prevSum) / prevSum * 100) : null,
      closedN: ui.showClosed ? 0 : idsWhere(m, c => s0(c.stage) === 'Закрыт').size,
      wholesaleNames: m.clients.filter(c => s0(c.type) === 'Оптовик').map(c => s0(c.name || c.id))
    };
  }

  // ── «Горит сегодня» (renderB2bUrgent) ─────────────────────────────────────
  function urgent(m, ui) {
    const scope = ovClients(m, ui);
    const overdue = scope.map(c => {
      const age = m.ageMap[s0(c.id)] || {};
      return { c, debt: (age.d30 || 0) + (age.d60 || 0) + (age.d90 || 0) + (age.d90plus || 0), maxDays: age.maxDays || 0 };
    }).filter(x => x.debt > 0).sort((a, b) => b.maxDays - a.maxDays);
    const contacts = scope.map(c => ({ c, next: m.nextContact[s0(c.id)] || '' }))
      .filter(x => x.next && x.next <= m.today).sort((a, b) => a.next.localeCompare(b.next));
    return { overdue, contacts };
  }

  // ── Прогноз поступлений (renderB2bForecast) ───────────────────────────────
  // Неоплаченный остаток каждой поставки (FIFO по сроку против всех оплат
  // партнёра) ложится на её срок. Прошедшие сроки — в «уже просрочено».
  function forecast(m, ui) {
    const today = m.today, paidBy = {};
    m.pays.forEach(p => { const cid = s0(p.client_id); if (cid) paidBy[cid] = (paidBy[cid] || 0) + n(p.amount); });
    const shipBy = {};
    let noDueN = 0, noDueSum = 0;
    m.ships.forEach(s => {
      const cid = s0(s.client_id);
      if (!cid || !ovInScope(m, ui, cid)) return;
      if (s0(s.status).trim() === 'Реализация') return;           // за консигнацию ещё не должны
      const due = dueDate(s);
      if (due.assumed) { noDueN++; noDueSum += n(s.amount); }
      (shipBy[cid] = shipBy[cid] || []).push({
        amount: n(s.amount), due: due.day, assumed: due.assumed,
        clientName: (m.byId[cid] || {}).name || cid, clientId: cid
      });
    });
    const dayMap = {}, weekEnd = addDays(today, 7), mEnd = monthEnd(today);
    let overdueTotal = 0, weekTotal = 0, monthTotal = 0;
    Object.keys(shipBy).forEach(cid => {
      let rem = paidBy[cid] || 0;
      // Поставки без срока (нет и даты поставки) встают первыми и забирают
      // оплаты на себя — так сортировал старый: (a.dueDate||0) − (b.dueDate||0).
      shipBy[cid].sort((a, b) => (a.due ? utcMs(a.due) : 0) - (b.due ? utcMs(b.due) : 0));
      shipBy[cid].forEach(s => {
        const unpaid = Math.max(0, s.amount - rem);
        rem = Math.max(0, rem - s.amount);
        if (unpaid <= 0 || !s.due) return;
        if (s.due < today) { overdueTotal += unpaid; return; }
        (dayMap[s.due] = dayMap[s.due] || []).push({ clientName: s.clientName, clientId: cid, amount: unpaid, assumed: s.assumed });
        if (s.due <= weekEnd) weekTotal += unpaid;
        if (s.due <= mEnd) monthTotal += unpaid;
      });
    });
    return { dayMap, overdueTotal, weekTotal, monthTotal, noDueN, noDueSum };
  }

  // ── Разбор просрочки (b2bOverdueShipments_) ───────────────────────────────
  // Поставки затихших партнёров, кроме реализации и возвратов. Менять статус
  // пачкой — в старом табе до дня переключения; здесь — посмотреть.
  function overdueShipments(m) {
    const byCid = {};
    m.debtList.filter(d => d.overdueDebt > 0).forEach(d => { byCid[d.cid] = d; });
    const rows = [];
    m.ships.forEach(s => {
      const cid = s0(s.client_id).trim(), d = byCid[cid];
      if (!d) return;
      const st = s0(s.status).trim();
      if (st === 'Реализация' || st === 'Возврат') return;
      const due = dueDate(s);
      rows.push({ id: s0(s.id), cid, client: d.name, ship: s.ship_day || '', due: due.day, src: due.src,
                  amount: n(s.amount), status: st, days: d.quietDays, debt: d.debt });
    });
    rows.sort((a, b) => (b.days - a.days) || (a.ship < b.ship ? -1 : 1));
    return rows;
  }

  // ── Таблица партнёров (b2bRenderTable) ────────────────────────────────────
  // pui: { type, result, query, sort, dir }, showClosed — общий для экрана.
  function partnerRows(m, pui, showClosed) {
    let rows = showClosed ? m.clients : m.clients.filter(c => s0(c.stage) !== 'Закрыт');
    if (pui.type !== 'all') rows = rows.filter(c => s0(c.type) === pui.type);
    if (pui.result !== 'all') {
      rows = rows.filter(c => {
        const r = (m.outcomeMap[s0(c.id)] || {}).result || '';
        return pui.result === 'none' ? !r : r.startsWith(pui.result);
      });
    }
    const q = s0(pui.query).toLowerCase().trim();
    if (q) {
      rows = rows.filter(c => s0(c.name).toLowerCase().includes(q) || s0(c.counterparty).toLowerCase().includes(q) ||
                              s0(c.city).toLowerCase().includes(q));
    }
    if (pui.sort) {
      const M = m.money, col = pui.sort;
      const key = c => {
        const id = s0(c.id);
        if (col === 'name') return s0(c.name);
        if (col === 'counterparty') return s0(c.counterparty);
        if (col === 'shipped') return M.totalShip[id] || 0;
        if (col === 'paid') return M.totalPaid[id] || 0;
        if (col === 'debt') return (m.debtMap[id] || {}).debt || 0;
        if (col === 'visit') return (m.touchMap[id] || {}).day || (m.visitMap[id] || {}).date || s0(c.last_visit);
        if (col === 'payday') return M.expectPay[id] ? utcMs(M.expectPay[id]) : Infinity;
        return '';
      };
      rows = rows.slice().sort((a, b) => {
        const va = key(a), vb = key(b);
        const cmp = typeof va === 'string' ? va.localeCompare(vb, 'ru') : (va - vb);
        return pui.dir === 'asc' ? cmp : -cmp;
      });
    }
    return rows.map(c => partnerCells(m, c));
  }

  function partnerCells(m, c) {
    const cid = s0(c.id), M = m.money, today = m.today;
    const debt = (m.debtMap[cid] || {}).debt || 0;
    const consign = (M.totalConsign || {})[cid] || 0, ship = M.totalShip[cid] || 0, paid = M.totalPaid[cid] || 0;
    // Остаток — сколько ещё не заплачено, ВКЛЮЧАЯ товар под реализацию;
    // требовать можно только restDue.
    const rest = Math.max(0, ship - paid);
    const restDue = debt || Math.max(0, ship - consign - paid);
    const age = m.ageMap[cid] || {};
    const overdueAmt = restDue > 0 ? (age.d30 || 0) + (age.d60 || 0) + (age.d90 || 0) + (age.d90plus || 0) : 0;
    const touch = m.touchMap[cid] || null, visit = m.visitMap[cid] || {};
    const lv = (touch && touch.day) || visit.date || c.last_visit || '';
    return {
      c, cid, ship, paid, consign, rest, restDue, restCons: Math.max(0, rest - restDue),
      overdueAmt, ageDays: age.maxDays || 0, age,
      lastPayDay: m.lastPayDay[cid] || '', lastPayAmt: M.lastPayAmt[cid] || 0,
      expect: M.expectPay[cid] || '', expectAssumed: !!(M.expectAssumed || {})[cid],
      expectOverdue: !!(M.expectPay[cid] && !(M.expectAssumed || {})[cid] && M.expectPay[cid] < today),
      lastContact: lv && lv !== '1899-12-30' ? lv : '', touch,
      touchDays: touch && touch.day ? dayDiff(touch.day, today) : null,
      comment: s0(visit.comment).replace(/\s+/g, ' ').trim()
    };
  }

  // ── Карточка партнёра ─────────────────────────────────────────────────────
  // «Товары» текстом — для поставок без позиций (_b2bParseItemsText_):
  // «Подгузники S × 10 шт × 8900 ₸», одна позиция на строку.
  function parseItemsText(raw) {
    const txt = s0(raw).replace(/\u00a0/g, ' ');
    if (!txt.trim()) return [];
    return txt.split('\n').map(line => {
      const s = line.trim();
      if (!s) return null;
      const m = s.match(/^(.+?)\s*[×xх]\s*([\d.,]+)\s*(шт|уп|кг|л|усл)?\s*[×xх]\s*([\d\s.,]+)\s*₸?/i);
      if (!m) return { product: s, qty: 0, price: 0, sum: 0, raw: s };
      const qty = parseFloat(String(m[2]).replace(',', '.')) || 0;
      const price = parseFloat(String(m[4]).replace(/\s/g, '').replace(',', '.')) || 0;
      return { product: m[1].trim(), unit: m[3] || 'шт', qty, price, sum: Math.round(qty * price * 100) / 100, raw: s };
    }).filter(Boolean);
  }

  // Разнесение денег по поставкам и товарам (_b2bCardAllocate):
  //   1) факт — позиции оплаты в свою строку отгрузки;
  //   2) излишек платежа над позициями (аванс) — «не разнесено»;
  //   3) оплаты без позиций (старые) — поставка из «ID поставки» → FIFO по
  //      дате → внутри поставки пропорционально ОСТАТКУ позиции;
  //   4) что не влезло — переплата.
  function allocate(ships, pays) {
    const S = ships.map(sh => {
      const items = (sh._items || []).map(i => {
        const qty = n(i.qty), price = n(i.price);
        return { id: s0(i.id), product: s0(i.product).trim(), unit: i.unit || 'шт', qty, price,
                 sum: n(i.sum) || Math.round(qty * price * 100) / 100, paid: 0 };
      }).filter(i => i.product);
      return { id: s0(sh.id), day: sh.ship_day || '', sum: n(sh.amount), status: s0(sh.status),
               consign: s0(sh.status) === 'Реализация', items, itemsSum: items.reduce((a, i) => a + i.sum, 0), paid: 0, _sh: sh };
    });
    const order = S.slice().sort((a, b) => ((a.day || '9999') < (b.day || '9999') ? -1 : 1));
    const byId = {}, byItem = {};
    S.forEach(s => { if (s.id) byId[s.id] = s; });
    S.forEach(s => s.items.forEach(it => { if (it.id) byItem[it.id] = { it, s }; }));
    let pool = 0, legacyPool = 0, factSum = 0, estSum = 0, legacyCount = 0, legacySum = 0, orphanSum = 0;
    pays.forEach(p => {
      const amt = n(p.amount), list = p._items || [];
      if (amt <= 0 || !list.length) return;
      let used = 0;
      list.forEach(pi => {
        const sum = n(pi.sum);
        if (sum <= 0) return;
        used += sum;
        const t = byItem[s0(pi.ship_item_id)];
        if (!t) { pool += sum; orphanSum += sum; return; }
        t.it.paid += sum; t.s.paid += sum;
        if (s0(pi.source) === 'оценка') estSum += sum; else factSum += sum;
      });
      pool += Math.max(0, Math.round((amt - used) * 100) / 100);
    });
    pays.forEach(p => {
      const amt = n(p.amount);
      if (amt <= 0 || (p._items || []).length) return;
      legacyCount++; legacySum += amt;
      const t = byId[s0(p.shipment_id)];
      if (!t) { legacyPool += amt; return; }
      const put = Math.min(Math.max(0, t.sum - t.paid), amt);
      t.paid += put; t._legacy = (t._legacy || 0) + put; legacyPool += amt - put;
    });
    order.forEach(s => {
      if (legacyPool <= 0) return;
      const put = Math.min(Math.max(0, s.sum - s.paid), legacyPool);
      s.paid += put; s._legacy = (s._legacy || 0) + put; legacyPool -= put;
    });
    pool += legacyPool;
    S.forEach(s => {
      const money0 = s._legacy || 0;
      if (money0 <= 0) return;
      const lefts = s.items.map(it => Math.max(0, it.sum - it.paid));
      const total = lefts.reduce((x, y) => x + y, 0);
      if (total <= 0) return;
      let rest = money0;
      s.items.forEach((it, k) => {
        const share = k === s.items.length - 1 ? rest : (money0 * lefts[k]) / total;
        const put = Math.max(0, Math.min(rest, share));
        it.paid += put; rest -= put;
      });
    });
    const r2 = v => Math.round(v * 100) / 100;
    return { ships: S, byId, overpaid: r2(pool), factSum: r2(factSum), estSum: r2(estSum),
             legacyCount, legacySum: r2(legacySum), orphanSum: r2(orphanSum) };
  }

  // Товары у партнёра: поставлено / оплачено / осталось (_b2bCardProducts).
  function cardProducts(alloc) {
    const map = {};
    let noItemsSum = 0, noItemsPaid = 0, noItemsCount = 0, mismatch = 0;
    alloc.ships.forEach(s => {
      if (s.itemsSum <= 0 && s.sum > 0) { noItemsSum += s.sum; noItemsPaid += s.paid; noItemsCount++; }
      if (!s.items.length) return;
      if (s.itemsSum > 0 && Math.abs(s.itemsSum - s.sum) > 1) mismatch++;
      s.items.forEach(it => {
        const k = it.product.toLowerCase();
        const r = map[k] || (map[k] = { product: it.product, unit: it.unit, qty: 0, sum: 0, paid: 0, leftConsign: 0, ships: 0, lastDay: '' });
        r.qty += it.qty; r.sum += it.sum; r.paid += it.paid; r.ships++;
        if (s.consign) r.leftConsign += Math.max(0, it.sum - it.paid);
        if ((s.day || '') > r.lastDay) r.lastDay = s.day || '';
      });
    });
    const rows = Object.keys(map).map(k => {
      const r = map[k];
      r.left = Math.max(0, Math.round((r.sum - r.paid) * 100) / 100);
      r.leftQty = r.sum > 0 ? Math.round((r.qty * r.left / r.sum) * 100) / 100 : 0;
      r.rate = r.sum > 0 ? r.paid / r.sum : 0;
      r.leftConsign = Math.min(r.left, Math.round(r.leftConsign * 100) / 100);
      return r;
    }).sort((a, b) => b.left - a.left || b.sum - a.sum);
    return { rows, noItemsSum, noItemsPaid, noItemsCount, mismatch };
  }

  function driveThumb(url) {
    const m = s0(url).match(/\/d\/([-\w]{20,})/) || s0(url).match(/[?&]id=([-\w]{20,})/);
    return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w400' : '';
  }

  function cardModel(m, cid) {
    const c = m.byId[cid];
    if (!c) return null;
    const of = list => list.filter(r => s0(r.client_id) === cid);
    const itemsBy = {}, payItemsBy = {};
    m.items.forEach(i => { (itemsBy[s0(i.shipment_id)] = itemsBy[s0(i.shipment_id)] || []).push(i); });
    m.payItems.forEach(i => { (payItemsBy[s0(i.payment_id)] = payItemsBy[s0(i.payment_id)] || []).push(i); });
    // Позиции — из «Позиций поставки»; у старых поставок без них — разбор
    // текста «Товары», чтобы карточка не пустела (как в старой).
    const ships = of(m.ships).map(s => Object.assign({}, s, { _items: itemsBy[s0(s.id)] || parseItemsText(s.items_text) }));
    const pays = of(m.pays).map(p => Object.assign({}, p, { _items: payItemsBy[s0(p.id)] || [] }));
    const visits = of(m.visits), alloc = allocate(ships, pays);
    const M = m.money, ship = M.totalShip[cid] || 0, paid = M.totalPaid[cid] || 0, consign = (M.totalConsign || {})[cid] || 0;
    const debt = (m.debtMap[cid] || {}).debt || 0;
    const payRate = ship > 0 ? paid / ship : 0;
    const gallery = [];
    visits.forEach(v => (v.files || []).forEach(u => gallery.push({ url: u, kind: 'Визит', day: v.day || '', id: s0(v.id) })));
    ships.forEach(s => (s.files || []).forEach(u => gallery.push({ url: u, kind: 'Поставка', day: s.ship_day || '', id: s0(s.id) })));
    const byDayDesc = key => (a, b) => s0(b[key]).localeCompare(s0(a[key])) || s0(b.id).localeCompare(s0(a.id));
    // Документы по поставкам: накладная и счёт видны у самой поставки.
    const docs = of(m.docs).sort(byDayDesc('day')), docsByShip = {};
    docs.forEach(d => (d.shipment_ids || []).forEach(x => { (docsByShip[s0(x)] = docsByShip[s0(x)] || []).push(d); }));
    return {
      c, ships, pays, alloc, products: cardProducts(alloc), docsByShip,
      visits: visits.slice().sort(byDayDesc('day')), branches: of(m.branches),
      docs, rounds: of(m.rounds).sort(byDayDesc('day')), gallery,
      fin: { ship, paid, consign, rest: Math.max(0, ship - paid), debt: debt || Math.max(0, ship - consign - paid),
             payRate, loyalty: Math.min(100, Math.round(payRate * 70 + Math.min(visits.length, 10) * 3)) },
      age: m.ageMap[cid] || null, expect: M.expectPay[cid] || '', expectAssumed: !!(M.expectAssumed || {})[cid]
    };
  }

  // ══════════════ РАЗМЕТКА ══════════════════════════════════════════════════
  function seg(action, attr, val, on, label) {
    return '<button type="button" class="seg' + (on ? ' on' : '') + '" data-action="' + action + '" ' + attr + '="' +
      esc(val) + '" aria-pressed="' + on + '">' + esc(label) + '</button>';
  }
  function kpi(label, value, sub, tone) {
    return '<div class="kpi' + (tone ? ' kpi-' + tone : '') + '"><div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-value">' + value + '</div>' + (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div>';
  }
  function partnerLink(id, name) {
    return '<button type="button" class="b2b-link" data-action="b2b-card" data-id="' + esc(id) + '">' + esc(name || '—') + '</button>';
  }
  function where(c) { return [c.type, c.city].filter(Boolean).map(esc).join(' · '); }
  function ageTone(d) { return d > 90 ? 'bad' : d > 60 ? 'bad' : d > 30 ? 'warn' : 'warn'; }

  // Фильтры экрана: тип партнёра, без опта, закрытые.
  function renderFilters(ui, k) {
    return '<div class="toolbar b2b-filters" role="group" aria-label="Срез партнёров">' +
      '<span class="toolbar-label">Тип партнёра:</span>' +
      TYPES.map(t => seg('b2b-ovtype', 'data-type', t.key, ui.type === t.key, t.label)).join('') +
      seg('b2b-nows', 'data-x', '1', !!ui.noWholesale, 'Без крупного опта') +
      seg('b2b-closed', 'data-x', '1', !!ui.showClosed, 'Показать закрытых') +
      '<span class="toolbar-label">' + esc(ui.type === 'all' ? pl(k.total, 'партнёр', 'партнёра', 'партнёров') + ' в базе'
                                                           : pl(k.total, 'партнёр', 'партнёра', 'партнёров') + ' типа «' + ui.type + '»') + '</span>' +
    '</div>';
  }

  function periodLabel(per) {
    if (!per.from && !per.to) return 'за всё время';
    if (per.from && per.to) return per.from === per.to ? dmy(per.from) : dmy(per.from) + ' — ' + dmy(per.to);
    return per.from ? 'с ' + dmy(per.from) : 'по ' + dmy(per.to);
  }

  function renderKpis(k, per, ui) {
    const open = !per.from && !per.to, word = open ? 'за всё время' : 'за период';
    const extra = [];
    if (k.consign) extra.push('из них на реализации ' + tg(k.consign) + ' — в долг не идёт, пока партнёр не продал');
    if (k.returned) extra.push('возвраты −' + tg(k.returned));
    if (k.closedN) extra.push('закрытых точек ' + k.closedN + ' — вне «Активных», но их долг в «Остатке» остался');
    const hidden = ui.noWholesale
      ? '<br>Скрыт крупный опт: ' + (k.wholesaleNames.length ? '<b>' + esc(k.wholesaleNames.join(', ')) + '</b>'
                                                              : '<b>никого</b> — тип «Оптовик» не проставлен ни одному партнёру')
      : '';
    const note = '<p class="note b2b-period">Потоки — ' + (open ? '<b>за всё время</b>' : 'за период <b>' + esc(periodLabel(per)) + '</b>') +
      '. Остаток и «Счета затихли» — полный долг <b>на сегодня</b>, период их не режет.' +
      (extra.length ? '<br>' + esc(extra.join(' · ')) : '') + hidden + '</p>';
    const deltaV = k.prev ? (k.delta === null ? (k.shipped > 0 ? 'новый' : '—') : (k.delta > 0 ? '+' : '') + k.delta + NBSP + '%') : '—';
    const deltaS = k.prev ? 'было ' + tg(k.prevSum) + ' за пред. ' + k.prev.days + ' дн.' : 'нужен период с обеих сторон';
    return note +
      '<div class="b2b-main">' +
        kpi('Поставлено', tg(k.shipped), esc((k.shipCount ? pl(k.shipCount, 'отгрузка', 'отгрузки', 'отгрузок') + ' ' + word : word) +
                                              (k.consign ? ' · в т.ч. реализация ' + tg(k.consign) : ''))) +
        kpi('Оплачено', tg(k.paid), esc(k.payRate + ' % от того, за что уже должны')) +
        kpi('Остаток', tg(k.debt), esc(pl(k.debtorsN, 'партнёр должен', 'партнёра должны', 'партнёров должны') + ' · на сегодня'), k.debt > 0 ? 'warn' : '') +
      '</div>' +
      '<div class="kpi-grid">' +
        kpi('Счета затихли', tg(k.overdue), esc(k.overdue > 0 ? 'месяц без поставок и без оплат' : 'все счета живые'), k.overdue > 0 ? 'bad' : '') +
        kpi('Активных точек', nf0.format(k.active), esc('из ' + k.total + ' в базе · отгрузка ' + word)) +
        kpi('Подключено', nf0.format(k.newN), esc('первая в истории поставка ' + word)) +
        kpi('Средняя поставка', tg(k.avg), esc('на одну отгрузку ' + word)) +
        kpi('К пред. периоду', esc(deltaV), esc(deltaS)) +
      '</div>';
  }

  function renderUrgent(u, today) {
    if (!u.overdue.length && !u.contacts.length) return '';
    const list = (rows, html) => rows.slice(0, 8).map(html).join('') +
      (rows.length > 8 ? '<li class="muted b2b-more">ещё ' + (rows.length - 8) + '</li>' : '');
    const od = u.overdue.length ? '<div class="b2b-urg"><h3>Просрочена оплата · ' + u.overdue.length + '</h3><ul>' +
      list(u.overdue, x => '<li><div class="b2b-urg-who">' + partnerLink(x.c.id, x.c.name) + '<span class="where">' + where(x.c) + '</span></div>' +
        '<div class="b2b-urg-val"><b class="st-bad-text">' + tg(x.debt) + '</b><span class="badge ' + ageTone(x.maxDays) + '">' +
        x.maxDays + NBSP + 'дн тишины</span></div></li>') + '</ul></div>' : '';
    const ct = u.contacts.length ? '<div class="b2b-urg"><h3>Нужен контакт · ' + u.contacts.length + '</h3><ul>' +
      list(u.contacts, x => {
        const ago = dayDiff(x.next, today);
        return '<li><div class="b2b-urg-who">' + partnerLink(x.c.id, x.c.name) + '<span class="where">' + where(x.c) + '</span></div>' +
          '<div class="b2b-urg-val"><span class="badge ' + (ago >= 3 ? 'bad' : 'warn') + '">' + (ago === 0 ? 'сегодня' : ago + NBSP + 'дн назад') + '</span></div></li>';
      }) + '</ul></div>' : '';
    return '<div class="b2b-urgent' + (od && ct ? ' two-col' : '') + '">' + od + ct + '</div>';
  }

  // act — { perm, bulk: { sel: {id: true}, status, msg } }: с правом записи
  // статус меняется пачкой здесь же (form_b2b_bulk_status), как в старом табе.
  function renderOverdue(rows, open, act) {
    if (!rows.length) return '<p class="empty">Просроченных поставок нет.</p>';
    const can = !!(act && act.perm && act.perm.write), bulk = (act && act.bulk) || { sel: {}, status: 'Реализация', msg: null };
    const total = rows.reduce((a, r) => a + r.amount, 0);
    const head = '<p class="note">' + pl(rows.length, 'поставка', 'поставки', 'поставок') + ' затихших партнёров на ' + tg(total) +
      (can ? '. Если товар на самом деле под реализацию — отметьте поставки и смените статус пачкой.</p>'
           : '. Если товар на самом деле под реализацию — статус меняется в старом табе пачкой (до дня переключения).</p>');
    if (!open) return head + '<button type="button" class="ghost" data-action="b2b-overdue">Показать список</button>';
    const src = { monthly: 'по графику', weekly: 'по графику', default: '~ месяц от поставки' };
    const nSel = rows.filter(r => bulk.sel[r.id]).length;
    const bar = can ? '<div class="st-form-actions b2b-bulk"><label for="bfBulkStatus">Статус для отмеченных</label>' +
      '<select id="bfBulkStatus">' + ['Реализация', 'Отгружено', 'Частично', 'Оплачено', 'Возврат'].map(x =>
        '<option' + (bulk.status === x ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select>' +
      '<button type="button" data-action="b2b-bulk-save"' + (nSel && !bulk.busy ? '' : ' disabled') + '>' +
      (bulk.busy ? 'Меняю…' : 'Сменить у ' + (nSel ? pl(nSel, 'поставки', 'поставок', 'поставок') : 'отмеченных')) + '</button></div>' +
      (bulk.msg ? '<div class="st-msg ' + (bulk.msg.tone === 'bad' ? 'st-bad-text' : 'st-good-text') + '" role="status">' + esc(bulk.msg.text) + '</div>' : '') : '';
    return head + bar + '<div class="table-scroll tall"><table class="grid"><thead><tr>' +
      (can ? '<th scope="col"><span class="sr-only">Отметить</span></th>' : '') + '<th scope="col">Поставка</th>' +
      '<th scope="col" class="txt">Партнёр</th><th scope="col" class="txt">Отгрузка</th><th scope="col" class="txt">Срок оплаты</th>' +
      '<th scope="col">Сумма</th><th scope="col">Тишина</th></tr></thead><tbody>' +
      rows.map(r => '<tr>' + (can ? '<td><input type="checkbox" data-bulk-id="' + esc(r.id) + '"' + (bulk.sel[r.id] ? ' checked' : '') +
          ' aria-label="Отметить ' + esc(r.id) + '"></td>' : '') +
        '<th scope="row" class="muted">' + esc(r.id) + '</th><td class="wrap">' + partnerLink(r.cid, r.client) + '</td>' +
        '<td>' + dmy(r.ship) + '</td><td>' + dmy(r.due) + (src[r.src] ? ' <span class="muted">' + esc(src[r.src]) + '</span>' : '') + '</td>' +
        '<td class="num">' + tg(r.amount) + '</td><td class="num bad">' + r.days + NBSP + 'дн</td></tr>').join('') +
      '</tbody></table></div>';
  }

  // Календарь поступлений: месяц ui.fcMonth ('YYYY-MM'), клик по дню — список.
  function renderForecast(f, fui, today) {
    if (!(f.overdueTotal > 0) && !Object.keys(f.dayMap).length) return '<p class="empty">Ждать нечего: неоплаченных поставок со сроком нет.</p>';
    const ym = fui.month || today.slice(0, 7);
    const y = +ym.slice(0, 4), mo = +ym.slice(5, 7);
    const first = ym + '-01', last = ofUtc(new Date(Date.UTC(y, mo, 0)));
    const startDow = (dow(first) + 6) % 7;
    let cells = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => '<div class="b2b-dow">' + d + '</div>').join('');
    for (let i = 0; i < startDow; i++) cells += '<div></div>';
    for (let d = 1; d <= +last.slice(8); d++) {
      const key = ym + '-' + pad(d), list = f.dayMap[key] || [], sum = list.reduce((a, e) => a + e.amount, 0);
      const cls = 'b2b-day' + (sum > 0 ? ' has' : key < today ? ' past' : '') + (key === today ? ' today' : '') +
                  (fui.day === key ? ' sel' : '');
      const inner = '<span class="b2b-day-n">' + d + '</span>' +
        (sum > 0 ? '<span class="b2b-day-sum">' + esc(compact(sum)) + '</span>' + (list.length > 1 ? '<span class="b2b-day-k">' + list.length + ' кл.</span>' : '') : '');
      cells += sum > 0
        ? '<button type="button" class="' + cls + '" data-action="b2b-fc-day" data-day="' + key + '" aria-label="' +
          esc(dateWords(key) + ': ' + tg(sum)) + '">' + inner + '</button>'
        : '<div class="' + cls + '">' + inner + '</div>';
    }
    const sel = fui.day && f.dayMap[fui.day] ? f.dayMap[fui.day] : null;
    const panel = sel ? '<div class="b2b-day-panel" role="region" aria-label="Поступления дня"><div class="b2b-day-head"><b>' +
      esc(dateWords(fui.day)) + '</b> · ожидается ' + tg(sel.reduce((a, e) => a + e.amount, 0)) + '</div><ul>' +
      sel.map(e => '<li>' + partnerLink(e.clientId, e.clientName) + ' <b>' + tg(e.amount) + '</b>' +
        (e.assumed ? ' <span class="muted">~ срок по умолчанию</span>' : '') + '</li>').join('') + '</ul></div>' : '';
    const warn = f.noDueN ? '<p class="note warn-text">У ' + pl(f.noDueN, 'поставки', 'поставок', 'поставок') + ' на ' + tg(f.noDueSum) +
      ' срок оплаты не указан — считаем месяц от даты поставки. Проставьте «Дата ожид. оплаты», чтобы прогноз шёл по договорённостям.</p>' : '';
    return warn +
      '<div class="b2b-fc-totals">' +
        '<div class="' + (f.overdueTotal > 0 ? 'bad' : 'good') + '"><span>' + (f.overdueTotal > 0 ? 'Уже просрочено' : 'Просрочки нет') + '</span><b>' +
          (f.overdueTotal > 0 ? tg(f.overdueTotal) : '—') + '</b></div>' +
        '<div><span>Эта неделя</span><b>' + (f.weekTotal > 0 ? tg(f.weekTotal) : '—') + '</b></div>' +
        '<div><span>Этот месяц</span><b>' + (f.monthTotal > 0 ? tg(f.monthTotal) : '—') + '</b></div>' +
      '</div>' +
      '<div class="b2b-fc-nav"><button type="button" class="ghost" data-action="b2b-fc-nav" data-dir="-1" aria-label="Предыдущий месяц">‹</button>' +
        '<b>' + MONTHS[mo - 1] + ' ' + y + '</b>' +
        '<button type="button" class="ghost" data-action="b2b-fc-nav" data-dir="1" aria-label="Следующий месяц">›</button></div>' +
      '<div class="b2b-cal">' + cells + '</div>' + panel;
  }
  function compact(v) {
    return v >= 1e6 ? (v / 1e6).toFixed(1).replace('.', ',') + 'М' : v >= 1000 ? Math.round(v / 1000) + 'K' : String(Math.round(v));
  }

  function renderPartnerToolbar(pui) {
    return '<div class="toolbar" role="group" aria-label="Тип партнёра"><span class="toolbar-label">Тип:</span>' +
        TYPES.map(t => seg('b2b-ptype', 'data-type', t.key, pui.type === t.key, t.label)).join('') + '</div>' +
      '<div class="toolbar" role="group" aria-label="Результат последнего визита"><span class="toolbar-label">Результат:</span>' +
        RESULTS.map(r => seg('b2b-presult', 'data-result', r.key, pui.result === r.key, r.label)).join('') + '</div>' +
      '<div class="toolbar"><label class="sr-only" for="b2bSearch">Поиск по партнёру, контрагенту или городу</label>' +
        '<input id="b2bSearch" type="search" placeholder="Партнёр, контрагент или город" value="' + esc(pui.query || '') + '"></div>';
  }

  function renderPartners(rows, pui, today) {
    if (!rows.length) return '<p class="empty">Нет партнёров по выбранным фильтрам.</p>';
    const th = (col, cls) => {
      const on = pui.sort === col, dir = on ? (pui.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return '<th scope="col"' + (cls ? ' class="' + cls + '"' : '') + ' aria-sort="' + (on ? (pui.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '">' +
        '<button type="button" class="b2b-sort" data-action="b2b-sort" data-col="' + col + '">' + esc(SORTS[col]) + dir + '</button></th>';
    };
    let tShip = 0, tPaid = 0, tRest = 0;
    const body = rows.map((r, i) => {
      tShip += r.ship; tPaid += r.paid; tRest += r.rest;
      const c = r.c;
      const cp = s0(c.counterparty).trim();
      const ageB = r.overdueAmt > 0
        ? '<span class="badge ' + ageTone(r.ageDays) + '" title="' + esc('Долг ' + tg(r.overdueAmt) + ' · последняя поставка ' + dmy(r.age.lastShip) +
            ' · последняя оплата ' + (r.age.lastPay ? dmy(r.age.lastPay) : 'оплат не было') + '. Затих с ' + dmy(r.age.quietFrom) + ' — месяц после обеих дат.') + '">' +
          r.ageDays + NBSP + 'дн тишины</span>' : '';
      const exp = r.expect
        ? '<span class="' + (r.expectOverdue ? 'bad' : r.expectAssumed ? 'muted' : '') + '" title="' +
          esc(r.expectAssumed ? 'Срок в поставке не указан — оценка: месяц от даты поставки' : 'Ближайшая дата, когда ждём поступление') + '">' +
          (r.expectAssumed ? '~' : '') + dmy(r.expect) + '</span>' : '<span class="muted">—</span>';
      const t = r.touch;
      const touch = t ? '<div class="b2b-sub b2b-touch-' + t.kind + '">' + esc(t.icon + ' ' + t.label) + (t.amount ? ' · ' + tg(t.amount) : '') + '</div>' : '';
      return '<tr>' +
        '<td class="num muted b2b-c-n">' + (i + 1) + '</td>' +
        '<td class="wrap b2b-c-cp">' + (cp ? '<b>' + esc(cp) + '</b>' : '<span class="muted">не заполнен</span>') + '</td>' +
        '<th scope="row" class="who">' + partnerLink(c.id, c.name || '—') + '<div class="where">' + (where(c) || NBSP) + '</div></th>' +
        '<td class="num"><b>' + (r.ship > 0 ? tg(r.ship) : '<span class="muted">—</span>') + '</b>' +
          (r.consign ? '<div class="b2b-sub b2b-consign" title="Товар у партнёра под реализацию: в долг не идёт, пока он не продал">реализация ' + tg(r.consign) + '</div>' : '') + '</td>' +
        '<td class="num' + (r.ship > 0 && r.paid >= r.ship ? ' good' : '') + '"><b>' + (r.paid > 0 ? tg(r.paid) : '<span class="muted">—</span>') + '</b>' +
          (r.lastPayDay ? '<div class="b2b-sub" title="' + esc('Дата последнего платежа' + (r.lastPayAmt ? ' · ' + tg(r.lastPayAmt) : '')) + '">' + dmy(r.lastPayDay) + '</div>' : '') + '</td>' +
        '<td class="num ' + (r.rest > 0 ? (r.overdueAmt > 0 ? 'bad' : 'warn') : 'good') + '">' + (r.rest > 0 ? tg(r.rest) : '0') +
          (r.restCons > 0 ? '<div class="b2b-sub b2b-consign" title="Товар под реализацию: входит в остаток, но требовать нельзя, пока партнёр не продал">из них ' +
            tg(r.restCons) + ' под реализацию</div>' : '') + (ageB ? '<div>' + ageB + '</div>' : '') + '</td>' +
        '<td>' + exp + '</td>' +
        '<td class="wrap b2b-last"><b>' + (r.lastContact ? dmy(r.lastContact) : '—') + '</b>' +
          (r.touchDays > 0 ? ' <span class="muted">· ' + r.touchDays + NBSP + 'дн назад</span>' : '') + touch + '</td>' +
        '<td class="wrap b2b-comment">' + (r.comment ? esc(r.comment) : '<span class="muted">—</span>') + '</td>' +
      '</tr>';
    }).join('');
    return '<div class="count muted">' + pl(rows.length, 'партнёр', 'партнёра', 'партнёров') + ' · суммы за всё время: это реестр долгов, период их не режет</div>' +
      '<div class="table-scroll tall"><table class="grid b2b-partners"><thead><tr>' +
        '<th scope="col" class="b2b-c-n">#</th>' + th('counterparty', 'txt b2b-c-cp') + th('name', 'txt') + th('shipped') + th('paid') + th('debt') +
        th('payday', 'txt') + th('visit', 'txt') + '<th scope="col" class="txt">Комментарий</th>' +
      '</tr></thead><tbody>' + body + '</tbody>' +
      '<tfoot><tr><td class="b2b-c-n"></td><td class="b2b-c-cp"></td><th scope="row">Итого по списку</th><td class="num">' + tg(tShip) + '</td><td class="num">' + tg(tPaid) +
        '</td><td class="num">' + tg(tRest) + '</td><td colspan="3"></td></tr></tfoot></table></div>';
  }

  // ── Карточка ──────────────────────────────────────────────────────────────
  function shipBadge(a) {
    const paid = Math.round(a.paid), debt = Math.max(0, Math.round(a.sum - a.paid));
    if (debt <= 0) return '<span class="badge good">Оплачено</span>';
    if (a.consign) return '<span class="badge info">Под реализацию</span>';
    return paid > 0 ? '<span class="badge warn">Частично</span>' : '<span class="badge">Ждём оплату</span>';
  }

  // act — только у тех, кому можно писать (b2b_forms.js, app.js):
  //   { perm, confirm: 'kind:id' — второе нажатие «Удалить», top: HTML кнопок и формы,
  //     signed: { имя в хранилище → временная ссылка } }
  // Без act карточка — та же, что на этапе 1: только чтение.
  function renderCard(cm, today, act) {
    const c = cm.c, f = cm.fin, pct = Math.round(f.payRate * 100);
    const contract = c.contract_no ? '№' + esc(c.contract_no) + (c.contract_date ? ' от ' + dmy(c.contract_date) : '') : '';
    const head = '<div class="b2b-card-top"><button type="button" class="ghost" data-action="b2b-back">← Все партнёры</button></div>' +
      '<section class="card b2b-card-head" aria-labelledby="b2bCardTitle"><h1 id="b2bCardTitle">' + esc(c.name || c.id) + '</h1>' +
      '<div class="muted">' + [c.type, c.stage, c.city, c.address].filter(Boolean).map(esc).join(' · ') + '</div>' +
      '<dl class="b2b-facts">' +
        '<div><dt>Контрагент</dt><dd>' + (c.counterparty ? esc(c.counterparty) : '<span class="muted">не заполнен — в счёт уйдёт название точки</span>') + '</dd></div>' +
        '<div><dt>Договор</dt><dd>' + (contract || '<span class="muted">нет — без договора счёт не выписывается</span>') + '</dd></div>' +
        '<div><dt>Контакт</dt><dd>' + esc(c.contact || '—') + (c.phone ? ' · <a href="tel:+' + esc(String(c.phone).replace(/[^\d]/g, '')) + '">' + esc(c.phone) + '</a>' : '') + '</dd></div>' +
        '<div><dt>Ответственный</dt><dd>' + esc(c.rep || '—') + '</dd></div>' +
        (c.comment ? '<div class="wide"><dt>Комментарий</dt><dd>' + esc(c.comment) + '</dd></div>' : '') +
      '</dl></section>';
    const kp = '<div class="kpi-grid b2b-card-kpis">' +
      kpi('Поставлено', tg(f.ship), f.consign ? esc('в т.ч. реализация ' + tg(f.consign)) : '') +
      kpi('Оплачено', tg(f.paid), esc(pct + ' % от поставленного')) +
      kpi('Остаток', tg(f.rest), f.rest > f.debt ? esc('требовать можно ' + tg(f.debt) + ', остальное под реализацию') : '', f.rest > 0 ? 'warn' : '') +
      kpi('Ждём оплату', cm.expect ? (cm.expectAssumed ? '~' : '') + dmy(cm.expect) : '—',
          cm.age ? esc(cm.age.maxDays + ' дн тишины') : (cm.expectAssumed ? 'срок не указан — месяц от поставки' : ''), cm.age ? 'bad' : '') +
      kpi('Лояльность', f.loyalty + NBSP + '%', 'оплаты и визиты') +
    '</div>';
    const a = act || null;
    return head + (a && a.top ? '<div class="b2b-card-act">' + a.top + '</div>' : '') + kp +
      sectionCard('b2bProducts', 'Товары у партнёра', productsSub(cm), renderProducts(cm)) +
      sectionCard('b2bShips', 'Поставки', pl(cm.ships.length, 'поставка', 'поставки', 'поставок'), renderShips(cm, a)) +
      sectionCard('b2bPays', 'Оплаты', pl(cm.pays.length, 'оплата', 'оплаты', 'оплат'), renderPays(cm, a)) +
      (root.NietteB2bDocs
        ? sectionCard('b2bDocs', 'Счета и накладные', 'новые — PDF здесь, выписанные старой системой — в Google Drive', root.NietteB2bDocs.renderDocs(cm, a))
        : sectionCard('b2bDocs', 'Счета и накладные', 'PDF — в Google Drive, по ссылкам старой системы', renderDocs(cm.docs))) +
      sectionCard('b2bVisits', 'Визиты', 'новые сверху', renderVisits(cm.visits, a)) +
      (cm.rounds.length ? sectionCard('b2bRounds', 'Обходы', '', renderRounds(cm.rounds, a)) : '') +
      sectionCard('b2bBranches', 'Филиалы', '', renderBranches(cm.branches, a)) +
      renderGallerySection(cm, a && a.signed);
  }
  function renderGallerySection(cm, signed) {
    return sectionCard('b2bGallery', 'Фото и документы', 'из визитов и поставок', renderGallery(cm.gallery, signed));
  }
  // Кнопки строки — b2b_forms.js; без права записи — ничего, ни колонки.
  function actCell(a, kind, id) {
    const F = root.NietteB2bForms;
    return a && a.perm && a.perm.write && F ? F.rowActions(a.perm, kind, s0(id), a.confirm) : '';
  }
  const actHead = a => (a && a.perm && a.perm.write ? '<th scope="col"><span class="sr-only">Действия</span></th>' : '');
  function sectionCard(id, title, sub, inner) {
    return '<section class="card" id="' + id + '" aria-labelledby="' + id + 'Title"><div class="card-head"><h2 id="' + id + 'Title">' +
      esc(title) + '</h2>' + (sub ? '<div class="card-sub">' + esc(sub) + '</div>' : '') + '</div>' + inner + '</section>';
  }
  function productsSub(cm) {
    const P = cm.products, left = P.rows.reduce((a, r) => a + r.left, 0), cons = P.rows.reduce((a, r) => a + r.leftConsign, 0);
    return P.rows.length ? 'осталось на ' + tg(left) + (cons > 0.5 ? ' · из них под реализацию ' + tg(cons) : '') : '';
  }
  function renderProducts(cm) {
    const P = cm.products, a = cm.alloc;
    if (!P.rows.length && !P.noItemsSum) return '<p class="empty">Поставок с позициями нет.</p>';
    const q = v => nf3.format(Math.round(n(v) * 100) / 100);
    const body = P.rows.map(r => {
      const free = r.sum <= 0, p = Math.round(r.rate * 100);
      const st = free ? 'без цены' : r.left <= 0.5 ? 'рассчитались' : r.leftConsign > 0 && r.leftConsign >= r.left - 0.5 ? 'лежит под реализацию'
               : r.leftConsign > 0 ? 'частично реализация' : 'не оплачено';
      return '<tr><th scope="row" class="who">' + esc(r.product) + '<div class="where">' + pl(r.ships, 'поставка', 'поставки', 'поставок') +
          (r.lastDay ? ' · последняя ' + dmy(r.lastDay) : '') + '</div></th>' +
        '<td class="num">' + q(r.qty) + ' ' + esc(r.unit) + '<div class="b2b-sub">' + (free ? '—' : tg(r.sum)) + '</div></td>' +
        '<td class="num good">' + (free ? '<span class="muted">—</span>' : tg(r.paid) + '<div class="b2b-sub">' + p + ' % проходимость</div>') + '</td>' +
        '<td class="num">' + (free ? '<span class="muted">—</span>' : '<b>' + q(r.leftQty) + ' ' + esc(r.unit) + '</b><div class="b2b-sub">' + tg(r.left) + '</div>') + '</td>' +
        '<td>' + esc(st) + '</td></tr>';
    }).join('');
    const notes = [];
    if (P.noItemsSum > 0) notes.push('Не разнесено по товарам: ' + tg(P.noItemsSum) + ' (оплачено ' + tg(P.noItemsPaid) + ') — в ' +
      pl(P.noItemsCount, 'поставке', 'поставках', 'поставках') + ' не заполнены позиции. Эти деньги есть в общем остатке, но не в таблице.');
    if (P.mismatch > 0) notes.push('В ' + pl(P.mismatch, 'поставке', 'поставках', 'поставках') + ' сумма позиций не сходится с суммой накладной.');
    if (a.overpaid > 0.5) notes.push('Переплата ' + tg(a.overpaid) + ' — денег пришло больше, чем разнесено: аванс или оплата по поставке, которой нет в базе.');
    if (a.legacyCount > 0) notes.push(pl(a.legacyCount, 'оплата', 'оплаты', 'оплат') + ' на ' + tg(a.legacySum) +
      ' без разбивки — разнесены оценкой (FIFO по датам, внутри поставки пропорционально остатку).');
    if (a.estSum > 0) notes.push(tg(a.estSum) + ' — строки «оценка»: их разложила миграция старых оплат.');
    if (a.orphanSum > 0) notes.push(tg(a.orphanSum) + ' ссылаются на позиции, которых больше нет в отгрузках — деньги в «не разнесено».');
    return (P.rows.length ? '<div class="table-scroll"><table class="grid"><thead><tr><th scope="col">Товар</th><th scope="col">Поставлено</th>' +
      '<th scope="col">Оплачено</th><th scope="col">Осталось у партнёра</th><th scope="col" class="txt">Статус</th></tr></thead><tbody>' + body +
      '</tbody></table></div>' : '') + notes.map(t => '<p class="note">' + esc(t) + '</p>').join('');
  }
  function renderShips(cm, act) {
    if (!cm.ships.length) return '<p class="empty">Поставок нет.</p>';
    const rows = cm.ships.slice().sort((a, b) => s0(b.ship_day).localeCompare(s0(a.ship_day)));
    return '<div class="table-scroll"><table class="grid"><thead><tr><th scope="col">Поставка</th><th scope="col" class="txt">Дата</th>' +
      '<th scope="col">Сумма</th><th scope="col">Оплачено</th><th scope="col">Долг</th><th scope="col" class="txt">Статус</th>' +
      '<th scope="col" class="txt">Срок</th><th scope="col" class="txt">Товары</th>' + actHead(act) + '</tr></thead><tbody>' +
      rows.map(s => {
        const a = cm.alloc.byId[s0(s.id)] || { paid: 0, sum: n(s.amount), consign: false };
        // Возврат — товар вернулся к нам: долга по этой строке нет. Разнесение
        // денег — как в старой карточке (_b2bCardAllocate), меняется только вид.
        const ret = s0(s.status).trim() === 'Возврат';
        const debt = ret ? 0 : Math.max(0, Math.round(a.sum - a.paid)), due = dueDate(s);
        const items = (s._items || []).map(i => esc(i.product) + (n(i.qty) ? ' × ' + nf3.format(n(i.qty)) : '')).join('<br>');
        const docs = root.NietteB2bDocs ? root.NietteB2bDocs.shipDocsHtml(cm, s, act) : '';
        return '<tr><th scope="row">' + esc(s.id) + '<div class="where">' + esc(s.status || '') + (s.rep ? ' · ' + esc(s.rep) : '') + '</div>' + docs + '</th>' +
          '<td>' + dmy(s.ship_day) + '</td><td class="num">' + tg(s.amount) + '</td><td class="num">' + tg(a.paid) + '</td>' +
          '<td class="num ' + (ret ? 'muted' : debt > 0 ? (a.consign ? '' : 'bad') : 'good') + '">' + (ret ? '—' : tg(debt)) + '</td>' +
          '<td>' + (ret ? '<span class="badge info">Возврат</span>' : shipBadge(a)) + '</td>' +
          '<td>' + (!ret && due.day ? (due.assumed ? '~' : '') + dmy(due.day) : '—') + '</td><td class="wrap">' + (items || '<span class="muted">—</span>') + '</td>' +
          actCell(act, 'shipment', s.id) + '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  function renderPays(cm, act) {
    if (!cm.pays.length) return '<p class="empty">Оплат нет.</p>';
    const rows = cm.pays.slice().sort((a, b) => s0(b.pay_day).localeCompare(s0(a.pay_day)));
    return '<div class="table-scroll"><table class="grid"><thead><tr><th scope="col">Дата</th><th scope="col">Сумма</th>' +
      '<th scope="col" class="txt">За что</th><th scope="col" class="txt">Способ</th><th scope="col" class="txt">№</th><th scope="col" class="txt">Принял</th>' +
      actHead(act) + '</tr></thead><tbody>' +
      rows.map(p => {
        const what = (p._items || []).length
          ? (p._items || []).map(i => esc(i.product || i.ship_item_id || '') + (n(i.qty) ? ' × ' + nf3.format(n(i.qty)) : '') +
              (s0(i.source) === 'оценка' ? ' <span class="muted">(оценка)</span>' : '')).join('<br>')
          : (p.shipment_id ? 'поставка ' + esc(p.shipment_id) : '<span class="muted">без разбивки</span>');
        return '<tr><th scope="row">' + dmy(p.pay_day) + '</th><td class="num good">' + tg(p.amount) + '</td><td class="wrap">' + what + '</td>' +
          '<td>' + esc(p.method || '—') + '</td><td class="muted">' + esc(p.receipt_no || '—') + '</td><td>' + esc(p.receiver || '—') + '</td>' +
          actCell(act, 'payment', p.id) + '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  function renderDocs(docs) {
    if (!docs.length) return '<p class="empty">Документов нет.</p>';
    return '<div class="table-scroll"><table class="grid"><thead><tr><th scope="col">Документ</th><th scope="col" class="txt">Дата</th>' +
      '<th scope="col">Сумма</th><th scope="col" class="txt">Оплачено</th><th scope="col" class="txt">PDF</th></tr></thead><tbody>' +
      docs.map(d => '<tr><th scope="row">' + esc(d.kind_label || d.kind) + ' ' + esc(d.number || '') +
          (d.shipment_ids && d.shipment_ids.length ? '<div class="where">' + esc(d.shipment_ids.join(', ')) + '</div>' : '') + '</th>' +
        '<td>' + dmy(d.day) + '</td><td class="num">' + tg(d.amount) + '</td>' +
        '<td>' + (d.paid ? '<span class="good">да' + (d.paid_day ? ', ' + dmy(d.paid_day) : '') + '</span>' : '<span class="muted">нет</span>') + '</td>' +
        '<td>' + (/^https:\/\//.test(s0(d.pdf_url)) ? '<a href="' + esc(d.pdf_url) + '" target="_blank" rel="noopener">открыть</a>' : '<span class="muted">—</span>') + '</td></tr>').join('') +
      '</tbody></table></div>';
  }
  function renderVisits(visits, act) {
    if (!visits.length) return '<p class="empty">Визитов нет.</p>';
    const top = visits.slice(0, 10);
    return '<div class="table-scroll"><table class="grid"><thead><tr><th scope="col">Дата</th><th scope="col" class="txt">Результат</th>' +
      '<th scope="col" class="txt">Комментарий</th><th scope="col" class="txt">Торгпред</th><th scope="col" class="txt">След. контакт</th>' +
      actHead(act) + '</tr></thead><tbody>' +
      top.map(v => '<tr><th scope="row">' + dmy(v.day) + '</th><td>' + esc(v.result || '—') + '</td><td class="wrap">' + esc(v.comment || '—') + '</td>' +
        '<td>' + esc(v.rep || '—') + '</td><td>' + (v.next_day ? dmy(v.next_day) : '—') + '</td>' + actCell(act, 'visit', v.id) + '</tr>').join('') +
      '</tbody></table></div>' + (visits.length > 10 ? '<p class="note">Показаны 10 последних из ' + visits.length + '.</p>' : '');
  }
  function renderRounds(rounds, act) {
    return '<div class="table-scroll"><table class="grid"><thead><tr><th scope="col">Дата</th><th scope="col">Продажи</th>' +
      '<th scope="col" class="txt">Позиции</th><th scope="col" class="txt">Торгпред</th>' + actHead(act) + '</tr></thead><tbody>' +
      rounds.map(r => '<tr><th scope="row">' + dmy(r.day) + '</th><td class="num">' + tg(r.amount) + '</td><td class="wrap">' +
        esc(r.items_text || '—').replace(/\n/g, '<br>') + '</td><td>' + esc(r.rep || '—') + '</td>' + actCell(act, 'round', r.id) + '</tr>').join('') +
      '</tbody></table></div>';
  }
  function renderBranches(list, act) {
    if (!list.length) return '<p class="empty">Филиалов нет.</p>';
    if (act && act.perm && act.perm.write) {
      // С правом записи — таблицей: у каждой строки «Изменить» и «Удалить».
      return '<div class="table-scroll"><table class="grid"><thead><tr><th scope="col">Филиал</th><th scope="col" class="txt">Адрес</th>' +
        '<th scope="col" class="txt">Контакт</th>' + actHead(act) + '</tr></thead><tbody>' + list.map(b => '<tr><th scope="row">' +
        esc(b.name || b.address || '—') + '</th><td class="wrap">' + esc([b.address, b.city].filter(Boolean).join(', ') || '—') + '</td>' +
        '<td>' + esc([b.contact, b.phone].filter(Boolean).join(' · ') || '—') + '</td>' + actCell(act, 'branch', b.id) + '</tr>').join('') +
        '</tbody></table></div>';
    }
    return '<ul class="b2b-branches">' + list.map(b => '<li><b>' + esc(b.name || b.address || '—') + '</b> <span class="muted">' +
      esc([b.address, b.city].filter(Boolean).join(', ')) + '</span>' + (b.contact || b.phone ? '<div class="where">' +
      esc([b.contact, b.phone].filter(Boolean).join(' · ')) + '</div>' : '') + '</li>').join('') + '</ul>';
  }
  // Файлы — два вида: старые ссылки Drive (как есть) и имена в хранилище
  // Supabase (корзина b2b, закрытая, sql/31): у них ссылка временная, её
  // страница получает заранее (signed) — без неё плитка ждёт.
  const isStorageFile = u => !!s0(u) && !/^https?:\/\//i.test(s0(u));
  const isImageName = u => /\.(jpe?g|png|webp)$/i.test(s0(u));
  function storageFiles(cm) {
    return (cm && cm.gallery ? cm.gallery : []).map(f => s0(f.url)).filter(isStorageFile).filter((u, i, a) => a.indexOf(u) === i);
  }
  function renderGallery(g, signed) {
    if (!g.length) return '<p class="empty">Файлов нет: торгпред прикрепляет фото при визите или поставке.</p>';
    return '<div class="b2b-gallery">' + g.map(f => {
      const label = f.kind + (f.day ? ' · ' + dmy(f.day) : '');
      if (isStorageFile(f.url)) {
        const href = signed && signed[f.url];
        if (!href) return '<span class="b2b-thumb b2b-thumb-wait" title="' + esc(label) + '"><span class="b2b-thumb-box"></span>' +
          '<span class="b2b-thumb-label">' + esc(label) + ' · открываю…</span></span>';
        return '<a class="b2b-thumb" href="' + esc(href) + '" target="_blank" rel="noopener" title="' + esc(label) + '">' +
          '<span class="b2b-thumb-box">' + (isImageName(f.url) ? '<img src="' + esc(href) + '" alt="" loading="lazy" onerror="this.remove()">'
                                                               : '<span class="b2b-thumb-doc">' + esc(s0(f.url).split('.').pop().toUpperCase()) + '</span>') +
          '</span><span class="b2b-thumb-label">' + esc(label) + '</span></a>';
      }
      const th = driveThumb(f.url);
      return '<a class="b2b-thumb" href="' + esc(f.url) + '" target="_blank" rel="noopener" title="' + esc(label) + '">' +
        '<span class="b2b-thumb-box">' + (th ? '<img src="' + esc(th) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '</span>' +
        '<span class="b2b-thumb-label">' + esc(label) + '</span></a>';
    }).join('') + '</div>';
  }

  function renderNotes() {
    return '<ul class="notes">' +
      '<li><b>Откуда данные.</b> До дня переключения поставки, оплаты и визиты вносятся в старом табе и мобильном торгпреда, сюда приходят с зеркалом таблицы: оно обновляется вместе с новыми заказами Kaspi — днём обычно через 15–30 минут, ночью реже. Время зеркала — в строке над экраном. Формы на этом экране до переключения — тренировка для полного доступа: внесённое сотрёт следующий перенос из листов.</li>' +
      '<li><b>Поставлено</b> — по дню поставки, реализация входит, возврат вычитается. <b>Оплачено</b> — по дню оплаты. Строки без даты не попадают ни в один период.</li>' +
      '<li><b>Остаток</b> — долг на сегодня: всё поставленное минус всё оплаченное, без товара под реализацию. <b>Счета затихли</b> — долг есть, а месяц нет ни поставок, ни оплат.</li>' +
      '<li><b>Ждём оплату</b> — ближайший срок неоплаченной поставки; «~» — срок не указан, взят месяц от поставки.</li>' +
      '<li>⚑ Звонок и заезд больше не считаются результатом переговоров в фильтре «Результат» — в старом табе считались из-за ошибки в разборе эмодзи.</li>' +
      '<li>⚑ Карточка партнёра считает «Поставлено» и «Остаток» так же, как таблица: с возвратами и реализацией. В старой карточке возврат прибавлялся к поставленному, и её цифры расходились с таблицей.</li>' +
      '<li>⚑ Визиты и документы в карточке — новые сверху. В старой «последние визиты» были пятью первыми строками листа, то есть самыми старыми.</li>' +
      '<li>Что старый таб считал нулём («8 900» текстом, «1,5» с запятой), здесь тоже ноль — чтобы цифры сошлись. Список таких ячеек: <code>select * from v_b2b_issues</code>.</li>' +
    '</ul>';
  }

  root.NietteB2b = {
    TYPES, RESULTS, SORTS, OUTCOME_RE,
    addMonth, addDays, dayDiff, dueDate, nextBySchedule, prevPeriod, periodLabel,
    debtors, agingMap, nextContactMap, lastTouchMap, lastPayDateMap, visitMaps, moneyMaps, prepare,
    ovClients, ovInScope, kpis, urgent, forecast, overdueShipments, partnerRows, partnerCells,
    parseItemsText, allocate, cardProducts, cardModel, driveThumb, storageFiles, isStorageFile,
    renderFilters, renderKpis, renderUrgent, renderOverdue, renderForecast, renderPartnerToolbar, renderPartners,
    renderCard, renderGallerySection, renderNotes
  };
})(typeof window !== 'undefined' ? window : globalThis);
