// Checks the money and session-counting rules in app/index.html before an update goes out.
// Run with: node tests/logic.test.js   (no installs needed)
const fs = require('fs'), vm = require('vm'), path = require('path');
const file = path.join(__dirname, '..', 'app', 'index.html');
const page = fs.readFileSync(file, 'utf8');
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

// A bare-bones browser stand-in: the logic never draws anything in test mode.
const noop = () => {}; const el = () => new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : el(), apply: () => el() });
const store = {};
let api = null;
const win = {
  __SBD_TEST__: a => { api = a; },
  __sbdLoad: (srcs, cb) => cb(),
  htmPreact: { html: () => null, render: noop, useState: v => [v, noop], useEffect: noop, useMemo: f => f(), useRef: v => ({ current: v }) },
  localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  navigator: { userAgent: 'node-test' }, location: { hash: '', pathname: '/', host: 'test' },
  addEventListener: noop, removeEventListener: noop, setTimeout, clearTimeout, console, Intl, Date, Math, JSON, Promise, URL, Blob: function () {},
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder,
};
win.document = el(); win.window = win; win.self = win; win.globalThis = win;
const ctx = vm.createContext(win);
for (const s of scripts) vm.runInContext(s, ctx, { filename: 'app/index.html' });
if (!api) { console.error('FAIL: the app did not expose its logic for testing'); process.exit(1); }

let fails = 0, passes = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? passes++ : fails++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`}`); };

const { deriveAll, enPrice, enSchedule, addMonthsYmd, round2, setWPM } = api;
const settings = { weeksPerMonth: 4, packThreshold: 2, gstRegistered: true, gstRate: 5, gstIncluded: false, taxRate: 25 };
setWPM(4);
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---- dates
eq('month add keeps month-end (Jan 31 + 1 = Feb 28)', addMonthsYmd('2026-01-31', 1), '2026-02-28');
eq('month add across the year', addMonthsYmd('2026-11-15', 3), '2027-02-15');

// ---- session packs: sessions only count once the pack is paid in full
{
  const clients = { a: { id: 'a', name: 'A', plan: { perWeek: 2 } } };
  const ledger = { c1: { id: 'c1', clientId: 'a', kind: 'charge', date: day(-30), amount: 500, sessions: 10 } };
  const ev = (id, d, status) => ({ id, clientIds: ['a'], date: day(d), start: 600, dur: 60, status });
  const events = { e1: ev('e1', -20, 'completed'), e2: ev('e2', -10, 'completed'), e3: ev('e3', 3, 'scheduled') };
  let r = deriveAll({ clients, events, ledger: { ...ledger }, settings }).cs.a;
  eq('unpaid pack: nothing purchased yet', r.purchased, 0);
  eq('unpaid pack: shows as owing', r.balance, 500);
  r = deriveAll({ clients, events, ledger: { ...ledger, p1: { id: 'p1', clientId: 'a', kind: 'payment', date: day(-29), amount: 500 } }, settings }).cs.a;
  eq('paid pack: 10 purchased', r.purchased, 10);
  eq('paid pack: 2 used', r.used, 2);
  eq('paid pack: 8 remaining', r.remaining, 8);
  eq('paid pack: 1 booked', r.booked, 1);
  eq('paid pack: balance 0', r.balance, 0);
  // partial payment: still not counted
  r = deriveAll({ clients, events, ledger: { ...ledger, p1: { id: 'p1', clientId: 'a', kind: 'payment', date: day(-29), amount: 300 } }, settings }).cs.a;
  eq('part-paid pack: not counted yet', r.purchased, 0);
  eq('part-paid pack: $200 still owing', r.balance, 200);
}

// ---- cancellations give the session back, late cancels and no-shows use it
{
  const clients = { a: { id: 'a', name: 'A', plan: {} } };
  const ledger = { c1: { id: 'c1', clientId: 'a', kind: 'charge', date: day(-30), amount: 100, sessions: 5 }, p1: { id: 'p1', clientId: 'a', kind: 'payment', date: day(-30), amount: 100 } };
  const ev = (id, d, status) => ({ id, clientIds: ['a'], date: day(d), start: 600, dur: 60, status });
  const events = { e1: ev('e1', -9, 'cancelled'), e2: ev('e2', -8, 'late'), e3: ev('e3', -7, 'noshow'), e4: ev('e4', -6, 'sick'), e5: ev('e5', -5, 'sickused') };
  const r = deriveAll({ clients, events, ledger, settings }).cs.a;
  eq('cancelled + sick (kept) free the session; late, no-show, sick (used) count', r.used, 3);
  eq('2 of 5 left', r.remaining, 2);
}

// ---- group session: each person can have their own status
{
  const clients = { a: { id: 'a', name: 'A', plan: {} }, b: { id: 'b', name: 'B', plan: {} } };
  const ledger = {};
  ['a', 'b'].forEach(c => { ledger['c' + c] = { id: 'c' + c, clientId: c, kind: 'charge', date: day(-30), amount: 100, sessions: 4 }; ledger['p' + c] = { id: 'p' + c, clientId: c, kind: 'payment', date: day(-30), amount: 100 }; });
  const events = { g1: { id: 'g1', clientIds: ['a', 'b'], date: day(-2), start: 600, dur: 60, status: 'completed', statusBy: { b: 'cancelled' } } };
  const d = deriveAll({ clients, events, ledger, settings }).cs;
  eq('group: A used 1', d.a.used, 1);
  eq('group: B cancelled, used 0', d.b.used, 0);
}

// ---- payments fill the oldest charge first
{
  const clients = { a: { id: 'a', name: 'A', plan: {} } };
  const ledger = {
    c1: { id: 'c1', clientId: 'a', kind: 'charge', date: day(-60), amount: 200, sessions: 4 },
    c2: { id: 'c2', clientId: 'a', kind: 'charge', date: day(-30), amount: 200, sessions: 4 },
    p1: { id: 'p1', clientId: 'a', kind: 'payment', date: day(-20), amount: 250 },
  };
  const r = deriveAll({ clients, events: {}, ledger, settings }).cs.a;
  eq('oldest charge paid first: 4 sessions unlocked', r.purchased, 4);
  eq('$150 still owing on the second', r.balance, 150);
  eq('one charge unpaid', r.unpaid.length, 1);
}

// ---- monthly plans with sessions per month (unused don't carry over)
{
  const clients = { a: { id: 'a', name: 'A', plan: { billing: '1', rateUnit: 'month' } } };
  const ledger = { c1: { id: 'c1', clientId: 'a', kind: 'charge', date: day(-5), periodStart: day(-5), amount: 300, sessions: 8, perMonth: 8, months: 1, expires: true },
    p1: { id: 'p1', clientId: 'a', kind: 'payment', date: day(-5), amount: 300 } };
  const r = deriveAll({ clients, events: {}, ledger, settings }).cs.a;
  eq('monthly plan: 8 this month', r.purchased, 8);
  eq('monthly plan: date-based, not session-based', r.sessionBased, false);
  eq('monthly plan: next renewal one month after the start', r.nextDue, addMonthsYmd(day(-5), 1));
}

// ---- prices, discounts and GST
{
  const pack = { id: 'pt', billType: 'pack', price: 50, perWeek: 2, commit: 3 };
  let p = enPrice(settings, pack, { freq: 1 });
  eq('2x/week for a month = 8 sessions', p.sessions, 8);
  eq('8 x $50 = $400', p.base, 400);
  eq('GST 5% on top = $20', p.tax, 20);
  eq('total $420', p.total, 420);
  eq('3-month commitment billed monthly = 3 payments', p.periods, 3);
  eq('commitment total $1260', p.commitTotal, 1260);
  p = enPrice(settings, pack, { freq: 1, discounts: [{ id: 'd1', kind: 'pct', amount: 10 }, { id: 'd2', kind: 'amt', amount: 20 }] });
  eq('10% then $20 off $400 = $340 before GST', p.sub, 340);
  eq('GST on the discounted price', p.tax, 17);
  p = enPrice({ ...settings, gstIncluded: true }, pack, { freq: 1 });
  eq('GST included: total stays $400', p.total, 400);
  eq('GST included: $19.05 of it is GST', p.tax, 19.05);
  p = enPrice(settings, pack, { freq: 1, discounts: [{ id: 'big', kind: 'amt', amount: 9999 }] });
  eq('a discount can never go below $0', p.sub, 0);
  const sched = enSchedule('2026-01-31', enPrice(settings, pack, { freq: 1 }));
  eq('payment schedule dates', sched.map(x => x.due), ['2026-01-31', '2026-02-28', '2026-03-31']);
  const online = { id: 'on', billType: 'online', price: 150, perMonth: 0, commit: 6 };
  p = enPrice({ ...settings, gstRegistered: false }, online, { freq: 3 });
  eq('online, billed every 3 months, no GST = $450', p.total, 450);
  eq('6-month commitment billed every 3 = 2 payments', p.periods, 2);
}
eq('rounding to cents', round2(10.005 + 0.1), 10.11);

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
