// Budget Estimator: "Can I afford X on date D?"
//
// The money you'll have on D is uncertain because you don't know when (or if) each client
// pays. So instead of one guess we run thousands of possible futures (Monte Carlo) and count
// in how many of them you can pay for X and still never drop below your safety buffer in the
// 30 days after buying it (so next month's rent is safe too), after tax set-aside, PayPal
// fees, dated bills and everyday spending.
//
// The model, step by step:
//  1. Payment timing. For every paid invoice we know how many days after the due date it was
//     paid. Each client gets their own list of these delays. A client with little history is
//     blended with everyone's history (empirical Bayes: weight n / (n + 3) on their own data),
//     and every draw gets a little noise (kernel smoothing, sd 1.5 days) so we don't only ever
//     predict delays that already happened.
//  2. What we already know. An unpaid invoice hasn't been paid *yet*, so we only keep delays
//     that land today or later (conditional sampling). If the client has never been this late,
//     the extra wait is drawn from an exponential tail fitted to their late payments.
//  3. Will it be paid at all? Each invoice is collected with probability from a Beta(19, 1)
//     prior (95%) updated with the client's paid invoices. Once an invoice is later than the
//     client has ever been, that chance halves for every 60 days past it (a stated assumption).
//  4. Retainers. Scheduled invoices up to D are added, with the same timing model.
//  5. Optional: likely new work. Repeat clients send new work at their usual rate (a Poisson
//     process with the rate and amounts taken from their last 180 days).
//  6. Money out. Bills come off on their day of the month; everyday spending is spread per day.
//     Every client payment is reduced by PayPal's fee and the share you set aside for tax.
//  7. Buying in instalments checks every instalment and the month after the last one.
// Result: probability, a range (P10 / P50 / P90), the likely shortfall, the earliest date it
// becomes safe, and which invoices decide the answer.
import { config, isoDate, addDays, addMonths, daysBetween, cents } from './config.js';
import { listInvoices, listSchedules, listClients, kvGet, kvSet, getClient } from './db.js';
import { isOpen, isPaid, clientStats, invoiceTotals } from './analytics.js';

const SIMS = 4000;
const SMOOTH_SD = 1.5; // days of noise added to each historical delay
const PRIOR_WEIGHT = 3; // how many "pretend" data points the shared pool counts as
const HALF_LIFE = 60; // days past the client's slowest payment for the chance of payment to halve
const r2 = (n) => cents(n);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ---------- small, seeded random number toolkit (same inputs -> same answer) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
const normal = (rnd) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const expo = (rnd, m) => -Math.log(1 - rnd()) * m;
function poisson(rnd, lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rnd();
  } while (p > L && k < 200);
  return k - 1;
}
const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

// ---------- what we learn from history ----------
function learn(today) {
  const cur = config.currency;
  const paid = listInvoices().filter((i) => isPaid(i) && i.paidDate && i.currency === cur);
  const byClient = new Map();
  const pool = [];
  for (const i of paid) {
    const d = Math.max(-30, daysBetween(i.dueDate, i.paidDate));
    pool.push(d);
    if (!byClient.has(i.clientId)) byClient.set(i.clientId, []);
    byClient.get(i.clientId).push(d);
  }
  const lateOnly = (xs) => xs.filter((d) => d > 0);
  const poolLateMean = mean(lateOnly(pool)) || 7;
  return { pool: pool.length ? pool : [3], byClient, poolLateMean, sample: pool.length, today };
}

/** A sampler for one client's delay (days after due date), given it's at least `minDelay`. */
function delaySampler(M, clientId) {
  const own = M.byClient.get(clientId) || [];
  const w = own.length / (own.length + PRIOR_WEIGHT);
  const lateMean = Math.max(5, mean(own.filter((d) => d > 0)) || M.poolLateMean);
  const slowest = own.length ? Math.max(...own) : Math.max(...M.pool);
  return {
    own: own.length,
    slowest,
    draw(rnd, minDelay) {
      for (let k = 0; k < 40; k++) {
        const src = rnd() < w && own.length ? own : M.pool;
        const d = Math.round(src[Math.floor(rnd() * src.length)] + normal(rnd) * SMOOTH_SD);
        if (d >= minDelay) return d;
      }
      // later than they've ever been: wait an extra exponential stretch
      return Math.ceil(minDelay + expo(rnd, lateMean));
    },
  };
}

/** Chance the invoice is ever paid. */
function collectChance(M, clientId, daysLateNow, slowest) {
  const n = (M.byClient.get(clientId) || []).length;
  const base = (49 + n) / (50 + n); // Beta(49,1) prior + n paid invoices
  const past = Math.max(0, daysLateNow - Math.max(0, slowest));
  return base * Math.pow(0.5, past / HALF_LIFE);
}

const amountDue = (inv) => r2(inv.status === 'PARTIALLY_PAID' ? Math.max(0, inv.total - (inv.depositAmount || 0)) : inv.total);

// ---------- saved inputs ----------
const PROFILE_KEY = 'budget:profile';
export const PAYPAL_FEE = { pct: 3.49, fixedUSD: 0.49 }; // US invoicing, PayPal wallet (Oct 2026 schedule)
const WINDOW = 30; // days after buying that must stay above the buffer

export function budgetProfile() {
  const p = { cashNow: 0, everyday: 0, buffer: 0, bills: [], taxPct: 0, fees: true, ...(kvGet(PROFILE_KEY) || {}) };
  if (p.monthlyCosts && !p.everyday) p.everyday = p.monthlyCosts; // older saved profile
  delete p.monthlyCosts;
  const { paidIds, ...rest } = p;
  return rest;
}
function saveProfile(p) {
  // remember which invoices were already paid, so money that lands later can be added to "Have now"
  const paidIds = listInvoices().filter(isPaid).map((i) => i.id);
  kvSet(PROFILE_KEY, { cashNow: p.cashNow, everyday: p.everyday, buffer: p.buffer, bills: p.bills, taxPct: p.taxPct, fees: p.fees, updatedAt: new Date().toISOString(), paidIds });
}

/**
 * Payments that landed after "Have now" was last saved: they are money you have now, so the
 * Budget page adds them to that field (after PayPal's fee and the tax share) and says so.
 */
export function receivedSinceSaved() {
  const raw = kvGet(PROFILE_KEY);
  if (!raw || !Array.isArray(raw.paidIds)) {
    // never saved: we don't know your balance, but we can point at money that just landed
    const cur = config.currency;
    const from = addDays(isoDate(), -14);
    const items = listInvoices()
      .filter((i) => isPaid(i) && i.currency === cur && i.paidDate && i.paidDate >= from)
      .map((i) => ({ number: i.number, client: getClient(i.clientId)?.name || 'Unknown', amount: i.total, net: r2(i.total - (i.total * PAYPAL_FEE.pct) / 100 - (cur === 'USD' ? PAYPAL_FEE.fixedUSD : 0)), paidDate: i.paidDate }));
    return { total: 0, items: [], since: null, recent: { total: r2(items.reduce((t, x) => t + x.net, 0)), items } };
  }
  const known = new Set(raw.paidIds);
  const cur = config.currency;
  const fixedFee = raw.fees !== false && cur === 'USD' ? PAYPAL_FEE.fixedUSD : 0;
  const net = (amt) => Math.max(0, amt - (raw.fees !== false ? amt * (PAYPAL_FEE.pct / 100) + fixedFee : 0)) * (1 - (raw.taxPct || 0) / 100);
  const items = listInvoices()
    .filter((i) => isPaid(i) && i.currency === cur && !known.has(i.id))
    .map((i) => ({ number: i.number, client: getClient(i.clientId)?.name || 'Unknown', amount: i.total, net: r2(net(i.total)), paidDate: i.paidDate }));
  return { total: r2(items.reduce((t, x) => t + x.net, 0)), items, since: raw.updatedAt || null };
}

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const num = (v, label, { min = 0, max = 1e8, dflt } = {}) => {
  if ((v === undefined || v === null || v === '') && dflt !== undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be a number between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}`);
  return r2(n);
};
function cleanBills(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((b) => b && (Number(b.amount) > 0))
    .slice(0, 20)
    .map((b) => ({ name: String(b.name || 'Bill').trim().slice(0, 40) || 'Bill', amount: num(b.amount, 'Bill amount', { min: 0.01 }), day: Math.min(31, Math.max(1, Math.round(Number(b.day) || 1))) }));
}

/** Day indexes (from today) on which a monthly bill on `day` falls, up to H. */
function billDays(today, day, H) {
  const out = [];
  const [y, m] = today.split('-').map(Number);
  for (let k = 0; k < 24; k++) {
    const last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
    const d = new Date(Date.UTC(y, m - 1 + k, Math.min(day, last))).toISOString().slice(0, 10);
    const t = daysBetween(today, d);
    if (t > H) break;
    if (t >= 0) out.push(t);
  }
  return out;
}

/**
 * Run the estimate. Inputs: price, date (YYYY-MM-DD) and optionally item, cashNow, everyday
 * (monthly spending spread per day), bills [{name, amount, day}], buffer, taxPct, fees (bool),
 * instalments (1-12, monthly), exclude (invoice numbers to treat as never paid), save.
 */
export function estimateBudget(input = {}, today = isoDate()) {
  const prof = budgetProfile();
  const price = num(input.price, 'Price', { min: 0.01 });
  const date = String(input.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('Pick the date you want to buy it');
  if (date < today) throw bad('The date has to be today or later');
  if (daysBetween(today, date) > 365) throw bad('Pick a date within the next 12 months');
  const cashNow = num(input.cashNow, 'Money you have now', { min: -1e7, dflt: prof.cashNow });
  const everyday = num(input.everyday ?? input.monthlyCosts, 'Everyday spending', { dflt: prof.everyday });
  const buffer = num(input.buffer, 'Safety buffer', { dflt: prof.buffer });
  const taxPct = num(input.taxPct, 'Tax set-aside', { max: 60, dflt: prof.taxPct });
  const fees = input.fees === undefined ? prof.fees !== false : Boolean(input.fees);
  const bills = input.bills === undefined ? cleanBills(prof.bills) : cleanBills(input.bills);
  const n = Math.round(num(input.instalments, 'Instalments', { min: 1, max: 12, dflt: 1 }));
  const exclude = new Set((Array.isArray(input.exclude) ? input.exclude : []).map(String));
  if (input.save !== false) saveProfile({ cashNow, everyday, buffer, bills, taxPct, fees });

  const cur = config.currency;
  const M = learn(today);
  const target = daysBetween(today, date);
  const inst = r2(price / n);
  const span = WINDOW * n; // instalments every 30 days + a month after the last one
  const scanTo = target + 90; // how far we look for a safe date
  const H = scanTo + span; // simulation horizon (days from today)
  const perDay = everyday / 30.44;

  // money that leaves on its own, known in advance (bills on their day + everyday spending)
  const out = new Float64Array(H + 1);
  for (let t = 0; t <= H; t++) out[t] = perDay;
  const billList = [];
  for (const b of bills) for (const t of billDays(today, b.day, H)) {
    out[t] += b.amount;
    billList.push({ ...b, date: addDays(today, t), t });
  }
  const outCum = new Float64Array(H + 1);
  for (let t = 0, c = 0; t <= H; t++) outCum[t] = c += out[t];
  // the same purchase with no client money at all: if this is safe, no invoice decides anything
  const noIn = new Float64Array(H + 1);
  for (let t = 0; t <= H; t++) noIn[t] = cashNow - outCum[t];
  // what actually reaches you from a client payment
  const fixedFee = fees && cur === 'USD' ? PAYPAL_FEE.fixedUSD : 0;
  const net = (amt) => Math.max(0, amt - (fees ? amt * (PAYPAL_FEE.pct / 100) + fixedFee : 0)) * (1 - taxPct / 100);

  // ---- the things that might pay you ----
  const streams = [];
  const otherCurrency = [];
  const excluded = [];
  for (const inv of listInvoices().filter(isOpen)) {
    if (inv.currency !== cur) {
      otherCurrency.push(inv.number);
      continue;
    }
    const due = amountDue(inv);
    if (!(due > 0)) continue;
    if (exclude.has(String(inv.number))) {
      excluded.push({ number: inv.number, client: getClient(inv.clientId)?.name || 'Unknown', amount: due });
      continue;
    }
    const s = delaySampler(M, inv.clientId);
    const lateNow = Math.max(0, daysBetween(inv.dueDate, today));
    streams.push({
      kind: 'invoice', id: inv.id, number: inv.number, clientId: inv.clientId,
      client: getClient(inv.clientId)?.name || 'Unknown',
      amount: due, net: net(due), dueDate: inv.dueDate, daysOverdue: lateNow,
      dueOffset: daysBetween(today, inv.dueDate), minDelay: daysBetween(inv.dueDate, today),
      pPay: collectChance(M, inv.clientId, lateNow, s.slowest), sampler: s,
    });
  }
  for (const sc of listSchedules().filter((x) => x.active && x.currency === cur)) {
    const total = invoiceTotals(sc.items, sc.taxPercent).total;
    const s = delaySampler(M, sc.clientId);
    let run = sc.nextRun < today ? today : sc.nextRun;
    for (let k = 0; k < 60 && daysBetween(today, run) <= H; k++) {
      streams.push({
        kind: 'retainer', id: `${sc.id}:${run}`, clientId: sc.clientId,
        client: getClient(sc.clientId)?.name || 'Unknown',
        amount: total, net: net(total), dueDate: addDays(run, sc.dueInDays), issueDate: run,
        dueOffset: daysBetween(today, run) + sc.dueInDays, minDelay: -sc.dueInDays,
        pPay: collectChance(M, sc.clientId, 0, s.slowest), sampler: s,
      });
      run = sc.frequency === 'weekly' ? addDays(run, 7) : addMonths(run, 1);
    }
  }

  // ---- likely new work: repeat clients who aren't on a retainer ----
  const onPlan = new Set(listSchedules().filter((x) => x.active).map((x) => x.clientId));
  const since = addDays(today, -180);
  const newWork = [];
  for (const c of listClients()) {
    if (onPlan.has(c.id)) continue;
    const recent = listInvoices({ clientId: c.id }).filter((i) => i.status !== 'CANCELLED' && i.currency === cur && i.issueDate >= since);
    if (recent.length < 3) continue;
    const terms = Math.round(mean(recent.map((i) => daysBetween(i.issueDate, i.dueDate))));
    newWork.push({ clientId: c.id, client: c.name, ratePerDay: recent.length / 180, amounts: recent.map((i) => i.total), terms, sampler: delaySampler(M, c.id) });
  }

  // ---- simulate ----
  // Common random numbers: the seed depends only on the book, not on the price, cash, tax, fees,
  // buffer, spending or date you type. Every input then runs against the same 4,000 futures, so
  // nudging one number moves the answer only in the direction it should (never by noise).
  const seed = hash(JSON.stringify([today, [...exclude], streams.map((s) => [s.id, s.amount]), M.sample]));
  const rnd = mulberry32(seed);
  const S = SIMS;
  const arrivedBy = streams.map(() => new Uint8Array(S)); // arrived by the purchase date
  const arrivedByEnd = streams.map(() => new Uint8Array(S)); // arrived before the safety window ends
  const payDays = streams.map(() => []);
  const okBase = new Uint32Array(scanTo + 1); // futures where buying on day t is safe (invoiced money only)
  const okNew = new Uint32Array(scanTo + 1); // ...including likely new work
  const okAtTarget = new Uint8Array(S);
  const lowAfter = new Float64Array(S); // lowest balance in the window after buying on the date
  const lowAfterNew = new Float64Array(S);
  const capacity = new Float64Array(S); // most you could spend on the date and stay above the buffer
  const fan = Array.from({ length: Math.min(H, target + span + 30) + 1 }, () => new Float64Array(S)); // balance if you buy on the date
  const inDay = new Float64Array(H + 1);
  const newDay = new Float64Array(H + 1);
  const bal = new Float64Array(H + 1);
  const balN = new Float64Array(H + 1);
  const m30 = new Float64Array(H + 1); // min balance over [t, t + 29]
  const m30N = new Float64Array(H + 1);
  const end = target + span - 1;

  const slidingMin = (src, dst) => {
    // dst[t] = min(src[t .. t + WINDOW - 1]) with a monotonic deque
    const q = new Int32Array(H + 1);
    let h = 0, tl = 0;
    for (let i = H; i >= 0; i--) {
      while (tl > h && src[q[tl - 1]] >= src[i]) tl--;
      q[tl++] = i;
      while (q[h] > i + WINDOW - 1) h++;
      dst[i] = src[q[h]];
    }
  };
  const safeFrom = (m, t) => {
    for (let k = 0; k < n; k++) if (m[t + WINDOW * k] - inst * (k + 1) < buffer) return false;
    return true;
  };
  const capFrom = (m, t) => {
    let c = Infinity;
    for (let k = 0; k < n; k++) c = Math.min(c, (m[t + WINDOW * k] - buffer) / (k + 1));
    return c * n;
  };

  for (let s = 0; s < S; s++) {
    inDay.fill(0);
    newDay.fill(0);
    streams.forEach((st, k) => {
      if (rnd() > st.pPay) return; // never paid in this future
      const d = st.sampler.draw(rnd, st.minDelay);
      const day = Math.max(0, st.dueOffset + d);
      if (day <= target) arrivedBy[k][s] = 1;
      if (day <= end) arrivedByEnd[k][s] = 1;
      if (day <= H) {
        inDay[day] += st.net;
        payDays[k].push(day);
      }
    });
    for (const w of newWork) {
      const jobs = poisson(rnd, w.ratePerDay * H);
      for (let j = 0; j < jobs; j++) {
        const issued = 1 + Math.floor(rnd() * H);
        const amt = w.amounts[Math.floor(rnd() * w.amounts.length)];
        const day = issued + w.terms + w.sampler.draw(rnd, -w.terms);
        if (day >= 0 && day <= H) newDay[day] += net(amt);
      }
    }
    for (let t = 0, c = 0, cn = 0; t <= H; t++) {
      c += inDay[t];
      cn += inDay[t] + newDay[t];
      bal[t] = cashNow + c - outCum[t];
      balN[t] = cashNow + cn - outCum[t];
    }
    slidingMin(bal, m30);
    slidingMin(balN, m30N);
    for (let t = 0; t <= scanTo; t++) {
      if (safeFrom(m30, t)) okBase[t]++;
      if (safeFrom(m30N, t)) okNew[t]++;
    }
    okAtTarget[s] = safeFrom(m30, target) ? 1 : 0;
    capacity[s] = capFrom(m30, target);
    let lo = Infinity, loN = Infinity;
    for (let k = 0; k < n; k++) {
      lo = Math.min(lo, m30[target + WINDOW * k] - inst * (k + 1));
      loN = Math.min(loN, m30N[target + WINDOW * k] - inst * (k + 1));
    }
    lowAfter[s] = lo;
    lowAfterNew[s] = loN;
    for (let t = 0; t < fan.length; t++) fan[t][s] = bal[t] - (t >= target ? inst * Math.min(n, 1 + Math.floor((t - target) / WINDOW)) : 0);
  }

  const m30Zero = new Float64Array(H + 1);
  slidingMin(noIn, m30Zero);
  const coveredByCash = safeFrom(m30Zero, target);
  let lowNoIncome = Infinity;
  for (let k = 0; k < n; k++) lowNoIncome = Math.min(lowNoIncome, m30Zero[target + WINDOW * k] - inst * (k + 1));

  // ---- read the futures ----
  const p = okBase[target] / S;
  const pNew = okNew[target] / S;
  const sortedLow = Float64Array.from(lowAfter).sort();
  const sortedCap = Float64Array.from(capacity).sort();
  const P = (arr, q) => r2(quantile(arr, q));
  const short = [...lowAfter].filter((v) => v < buffer).map((v) => buffer - v);
  const firstDay = (arr, q) => {
    for (let t = target; t <= scanTo; t++) if (arr[t] / S >= q) return addDays(today, t);
    return null;
  };
  const nowSafe = okBase[0] / S >= 0.8;

  const drivers = streams
    .map((st, k) => {
      let yes = 0, yesOk = 0, no = 0, noOk = 0;
      for (let s = 0; s < S; s++) {
        if (arrivedByEnd[k][s]) { yes++; yesOk += okAtTarget[s]; } else { no++; noOk += okAtTarget[s]; }
      }
      let by = 0;
      for (let s = 0; s < S; s++) by += arrivedBy[k][s];
      const days = payDays[k].slice().sort((a, b) => a - b);
      return {
        kind: st.kind, number: st.number || null, client: st.client, amount: st.amount, net: r2(st.net),
        dueDate: st.dueDate, issueDate: st.issueDate || null, daysOverdue: st.daysOverdue || 0,
        risk: clientStats(st.clientId, today).riskLabel, history: st.sampler.own,
        chancePaidEver: Math.round(st.pPay * 100),
        chanceByDate: Math.round((by / S) * 100),
        likelyDate: days.length ? addDays(today, Math.round(quantile(days, 0.5))) : null,
        earlyDate: days.length ? addDays(today, Math.round(quantile(days, 0.1))) : null,
        lateDate: days.length ? addDays(today, Math.round(quantile(days, 0.9))) : null,
        // how much the answer swings on this invoice; nothing swings when cash alone covers it
        impact: coveredByCash ? 0 : yes >= 40 && no >= 40 ? Math.round((yesOk / yes - noOk / no) * 100) : null,
      };
    })
    .filter((d) => d.kind === 'invoice' || d.issueDate <= addDays(today, end));

  // chart: chance of a safe purchase per start day, and the balance range if you buy on the date
  const timeline = [];
  for (let t = 0; t <= scanTo; t += scanTo > 150 ? 2 : 1) timeline.push({ date: addDays(today, t), chance: Math.round((okBase[t] / S) * 1000) / 10, chanceNew: Math.round((okNew[t] / S) * 1000) / 10 });
  const balance = [];
  for (let t = 0; t < fan.length; t += fan.length > 160 ? 2 : 1) {
    const col = Float64Array.from(fan[t]).sort();
    balance.push({ date: addDays(today, t), p10: P(col, 0.1), p50: P(col, 0.5), p90: P(col, 0.9) });
  }
  // "if you wait": the chance a week, two weeks and a month later
  const wait = [0, 7, 14, 30].map((d) => target + d).filter((t) => t <= scanTo).map((t) => ({ date: addDays(today, t), chance: Math.round((okBase[t] / S) * 1000) / 10 }));

  const inflowTotal = streams.filter((s) => s.kind === 'invoice').reduce((t, s) => t + s.amount, 0);
  const result = {
    item: String(input.item || '').trim().slice(0, 80),
    price, date, currency: cur, instalments: n, instalment: inst,
    inputs: { cashNow, everyday, buffer, taxPct, fees, bills },
    days: target,
    windowEnd: addDays(today, end),
    outflowsUntilEnd: r2(outCum[Math.min(H, end)]),
    billsInWindow: billList.filter((b) => b.t <= end).map(({ t, ...b }) => b),
    feeRate: fees ? { pct: PAYPAL_FEE.pct, fixed: fixedFee } : null,
    chance: Math.round(p * 1000) / 10,
    chanceWithNewWork: Math.round(pNew * 1000) / 10,
    margin: Math.round(Math.sqrt((p * (1 - p)) / S) * 1.96 * 1000) / 10, // 95% Monte Carlo error, in points
    lowest: { p10: P(sortedLow, 0.1), p50: P(sortedLow, 0.5), p90: P(sortedLow, 0.9) }, // lowest balance after buying
    lowestWithNewWork: r2(quantile(Float64Array.from(lowAfterNew).sort(), 0.5)),
    shortfall: {
      likely: r2(Math.max(0, buffer - P(sortedLow, 0.5))),
      badCase: r2(Math.max(0, buffer - P(sortedLow, 0.1))),
      ifShort: short.length ? r2(mean(short)) : 0,
    },
    maxSafe: { p80: r2(Math.max(0, quantile(sortedCap, 0.2))), p95: r2(Math.max(0, quantile(sortedCap, 0.05))) },
    safeDates: { p50: firstDay(okBase, 0.5), p80: firstDay(okBase, 0.8), p95: firstDay(okBase, 0.95) },
    safeDatesWithNewWork: { p80: firstDay(okNew, 0.8) },
    safeNow: nowSafe,
    coveredByCash,
    lowestWithoutClientMoney: r2(lowNoIncome),
    wait,
    owedTotal: r2(inflowTotal),
    owedNet: r2(streams.filter((s) => s.kind === 'invoice').reduce((t, s) => t + s.net, 0)),
    excluded,
    drivers: drivers.sort((a, b) => (b.impact ?? -1) - (a.impact ?? -1) || b.amount - a.amount),
    newWorkClients: newWork.map((w) => ({ client: w.client, perMonth: Math.round(w.ratePerDay * 30.44 * 10) / 10 })),
    timeline,
    balance,
    model: {
      simulations: S, paymentsLearnedFrom: M.sample, clientsWithHistory: M.byClient.size,
      smoothingDays: SMOOTH_SD, priorWeight: PRIOR_WEIGHT, halfLifeDays: HALF_LIFE, windowDays: WINDOW,
      otherCurrencyLeftOut: otherCurrency, lowData: M.sample < 10,
    },
  };
  result.path = typicalPath(result, { today, cashNow, perDay, bills: billList, end, target });
  result.verdict = verdict(result);
  return result;
}

/**
 * The story behind the answer: every payment on its most likely date, every bill on its day,
 * and the running balance after each one, from today to the end of the safety window.
 */
function typicalPath(r, { today, cashNow, perDay, bills, end, target }) {
  const ev = [];
  for (const d of r.drivers) {
    if (!d.likelyDate || d.chancePaidEver < 50) continue;
    const t = daysBetween(today, d.likelyDate);
    if (t > end) continue;
    ev.push({ t, kind: 'in', label: d.kind === 'retainer' ? `${d.client} pays the retainer` : `${d.client} pays #${d.number}`, amount: d.net, client: d.client, number: d.number, risk: d.risk });
  }
  for (const b of bills) if (b.t <= end) ev.push({ t: b.t, kind: 'bill', label: b.name, amount: -b.amount });
  for (let k = 0; k < r.instalments; k++) {
    const t = target + WINDOW * k;
    if (t <= end) ev.push({ t, kind: 'buy', label: r.instalments > 1 ? `${r.item || 'Purchase'}, payment ${k + 1} of ${r.instalments}` : r.item || 'Your purchase', amount: -r.instalment });
  }
  // same day: money in first, then bills, then the purchase
  const order = { in: 0, bill: 1, buy: 2 };
  ev.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind]);
  let bal = cashNow;
  let last = 0;
  const rows = [];
  for (const e of ev) {
    bal += -perDay * (e.t - last) + e.amount;
    last = e.t;
    rows.push({ ...e, date: addDays(today, e.t), balance: r2(bal) });
  }
  const endBal = r2(bal - perDay * (end - last));
  const after = rows.filter((x) => x.t >= target);
  const low = after.reduce((m, x) => (!m || x.balance < m.balance ? x : m), null);
  return { rows, endBalance: endBal, endDate: addDays(today, end), everydayPerDay: r2(perDay), lowest: low ? { date: low.date, balance: low.balance, label: low.label, kind: low.kind } : null };
}

const pct = (c) => (c >= 99.5 ? 'Over 99%' : c < 0.5 ? 'Under 1%' : `${Math.round(c)}%`);
const fmt = (cur, v) => `${cur} ${Math.round(v).toLocaleString('en-US')}`;
const nice = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Safe on X, risky on Y" plus the one-paragraph story of why. */
function storyOf(r) {
  const p = r.path;
  const buf = r.inputs.buffer;
  const lowRow = p?.lowest;
  const pill = [];
  if (r.chance >= 80) pill.push({ tone: 'safe', text: `Safe on ${nice(r.date)}` });
  else {
    if (lowRow && lowRow.balance < buf) pill.push({ tone: 'risky', text: `Risky on ${nice(lowRow.date)}` });
    else pill.push({ tone: 'risky', text: `Risky on ${nice(r.date)}` });
    if (r.safeDates.p80) pill.push({ tone: 'safe', text: `Safe from ${nice(r.safeDates.p80)}` });
  }
  if (!lowRow) return { pill, story: '' };
  const spend = `If you spend ${fmt(r.currency, r.price)} on ${nice(r.date)}${r.instalments > 1 ? ` (${r.instalments} payments)` : ''}`;
  if (lowRow.balance >= buf) {
    return { pill, story: `${spend}, your balance in a typical month is lowest on ${nice(lowRow.date)}${lowRow.kind === 'bill' ? ` after ${lowRow.label}` : ''}, at ${fmt(r.currency, lowRow.balance)}, still above your ${fmt(r.currency, buf)} line.` };
  }
  // money that would have saved it, but is likely to land after the low point
  const lateIn = p.rows.filter((x) => x.kind === 'in' && x.date > lowRow.date).sort((a, b) => b.amount - a.amount)[0];
  const cause = lowRow.kind === 'bill' ? ` when ${lowRow.label} (${fmt(r.currency, -p.rows.find((x) => x.date === lowRow.date && x.kind === 'bill').amount)}) leaves` : '';
  const why = lateIn ? `, because ${lateIn.client}'s payment${lateIn.number ? ` (#${lateIn.number})` : ''} is only likely around ${nice(lateIn.date)}${lateIn.risk === 'high' ? ', given how late they usually pay' : ''}` : '';
  let fix = '';
  if (r.safeDates.p80) {
    const cushion = p.rows.filter((x) => x.kind === 'in' && x.date > lowRow.date && x.date <= r.safeDates.p80).map((x) => x.client.split(' ')[0]);
    fix = ` By ${nice(r.safeDates.p80)}${cushion.length ? `, ${[...new Set(cushion)].slice(0, 3).join(' and ')}'s payment${cushion.length > 1 ? 's' : ''} should have cleared and` : ''} you'd stay above your ${fmt(r.currency, buf)} line in 8 out of 10 futures.`;
  }
  return { pill, story: `${spend}, your projected balance on ${nice(lowRow.date)} is ${fmt(r.currency, lowRow.balance)}${cause}${why}.${fix}` };
}

/** Plain-English answer built from the numbers (no AI needed, so it's always available). */
export function verdict(r) {
  return { ...verdictCore(r), ...storyOf(r) };
}

function verdictCore(r) {
  if (r.coveredByCash) {
    const what = r.instalments > 1 ? `${r.instalments} payments of ${fmt(r.currency, r.instalment)}` : 'it';
    return {
      level: 'yes',
      headline: `Yes. The money you have already covers ${what}${r.days === 0 ? ' today' : ` on ${nice(r.date)}`}.`,
      detail: `Even if no client pays you anything, your balance stays at least ${fmt(r.currency, r.lowestWithoutClientMoney)} in the 30 days after, above your ${fmt(r.currency, r.inputs.buffer)} line, with every bill and everyday cost taken out. So no unpaid invoice decides this one.`,
    };
  }
  const key = r.drivers
    .filter((d) => d.kind === 'invoice' && (d.impact ?? 0) >= 15 && d.chanceByDate < 97)
    .sort((a, b) => b.impact * (100 - b.chanceByDate) - a.impact * (100 - a.chanceByDate))[0];
  const keyText = key ? ` The invoice to watch is #${key.number} from ${key.client} (${fmt(r.currency, key.amount)}): it reaches you in time in ${key.chanceByDate}% of futures.` : '';
  const what = r.instalments > 1 ? `${r.instalments} payments of ${fmt(r.currency, r.instalment)}` : 'it';
  const bills = r.billsInWindow.length ? ` That includes ${r.billsInWindow.length === 1 ? `${r.billsInWindow[0].name} on ${nice(r.billsInWindow[0].date)}` : `${r.billsInWindow.length} bills`} in the month after.` : '';
  const cap = r.maxSafe.p80 > 0 ? ` To be 80% safe on ${nice(r.date)}, keep it under ${fmt(r.currency, r.maxSafe.p80)}.` : '';
  if (r.chance >= 99.5 && r.lowest.p10 >= r.inputs.buffer)
    return { level: 'yes', headline: `Yes, comfortably${r.days === 0 ? ', even today' : ''}.`, detail: `Even in a bad month (1 in 10) your balance stays at least ${fmt(r.currency, r.lowest.p10 - r.inputs.buffer)} above your buffer in the 30 days after buying ${what}.${bills}` };
  if (r.chance >= 90)
    return { level: 'yes', headline: `Yes. ${pct(r.chance)} chance you can buy ${what} on ${nice(r.date)}.`, detail: `Your balance stays above your ${fmt(r.currency, r.inputs.buffer)} buffer for the month after, with about ${fmt(r.currency, r.lowest.p50 - r.inputs.buffer)} to spare at its lowest in a typical future.${bills}${keyText}` };
  if (r.chance >= 60)
    return {
      level: 'maybe',
      headline: `Probably. ${pct(r.chance)} chance on ${nice(r.date)}.`,
      detail: `It depends on clients paying on their usual schedule.${keyText}${r.safeDates.p80 && r.safeDates.p80 > r.date ? ` Waiting until ${nice(r.safeDates.p80)} raises the chance to 80%.` : cap}`,
    };
  const when = r.safeDates.p80
    ? ` The earliest date with an 80% chance is ${nice(r.safeDates.p80)}.`
    : r.safeDatesWithNewWork.p80
      ? ` The money already owed to you isn't enough once bills, tax and fees are paid. If your regular clients keep sending work at their usual pace, it reaches an 80% chance on ${nice(r.safeDatesWithNewWork.p80)}.`
      : ' The money already owed to you isn\'t enough once bills, tax and fees are paid, so this needs new work first.';
  return {
    level: 'no',
    headline: r.chance < 0.5 ? `Not yet. Very unlikely by ${nice(r.date)}.` : `Not yet. Only a ${Math.round(r.chance)}% chance on ${nice(r.date)}.`,
    detail: `In a typical future you'd dip about ${fmt(r.currency, r.shortfall.likely)} below your buffer ${r.instalments > 1 ? 'while you pay it off' : 'in the month after buying'}, and ${fmt(r.currency, r.shortfall.badCase)} in a bad month.${r.chanceWithNewWork - r.chance >= 20 ? ` That counts only money already invoiced; if your regular clients keep sending work at their usual pace, the chance is ${pct(r.chanceWithNewWork).toLowerCase()}.` : when}${cap}${keyText}`,
  };
}

/**
 * When each unpaid invoice is likely to be paid, from the same per-client model the Budget
 * Estimator uses (400 seeded draws per invoice). Returns Map(invoiceId -> { date, early, late,
 * chance }) where date is the median, early/late the 10th/90th percentile, and chance the
 * probability it's paid at all. Dates are never in the past.
 */
export function expectedPayments(invoices, today = isoDate()) {
  const M = learn(today);
  const out = new Map();
  const N = 400;
  for (const inv of invoices) {
    if (!isOpen(inv)) continue;
    const s = delaySampler(M, inv.clientId);
    const lateNow = Math.max(0, daysBetween(inv.dueDate, today));
    const rnd = mulberry32(hash(`${inv.id}:${today}`));
    const minDelay = daysBetween(inv.dueDate, today);
    const days = [];
    for (let k = 0; k < N; k++) days.push(Math.max(0, daysBetween(today, inv.dueDate) + s.draw(rnd, minDelay)));
    days.sort((a, b) => a - b);
    const ever = collectChance(M, inv.clientId, lateNow, s.slowest);
    const within = (d) => (days.filter((x) => x <= d).length / N) * ever;
    out.set(inv.id, {
      date: addDays(today, Math.round(quantile(days, 0.5))),
      early: addDays(today, Math.round(quantile(days, 0.1))),
      late: addDays(today, Math.round(quantile(days, 0.9))),
      chance: Math.round(ever * 100),
      within30: Math.round(within(30) * 100),
      within: within,
      basedOn: s.own,
    });
  }
  return out;
}

/**
 * Money expected in the next `days`: each unpaid invoice counts for its amount times the
 * chance it's paid within that time (from the per-client timing model). Same shape as the
 * older forecastCashflow, plus the working, so the UI can show the exact sum.
 */
/** How a client usually pays: median days after the due date (negative = early), from their paid invoices. */
export function payHabit(clientId) {
  const late = listInvoices({ clientId })
    .filter((i) => isPaid(i) && i.paidDate)
    .map((i) => daysBetween(i.dueDate, i.paidDate))
    .sort((a, b) => a - b);
  if (!late.length) return { paid: 0, medianLate: null, upfront: false };
  const med = late[late.length >> 1];
  return { paid: late.length, medianLate: med, upfront: late.length >= 2 && med <= -7 };
}

export function forecastFromModel(days = 30, today = isoDate()) {
  const open = listInvoices().filter(isOpen);
  const pred = expectedPayments(open, today);
  const rows = open
    .map((inv) => {
      const p = pred.get(inv.id);
      const due = amountDue(inv);
      const probability = Math.round(p.within(days) * 100) / 100;
      return {
        invoice: inv.number,
        client: getClient(inv.clientId)?.name || 'Unknown',
        amount: due,
        currency: inv.currency,
        expectedDate: p.date,
        range: [p.early, p.late],
        dueDate: inv.dueDate,
        daysOverdue: Math.max(0, daysBetween(inv.dueDate, today)),
        habit: payHabit(inv.clientId),
        probability,
        expectedValue: r2(due * probability),
        basedOn: p.basedOn,
      };
    })
    .filter((r) => r.probability > 0)
    .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
  const by = (f) => rows.reduce((m, r) => ((m[r.currency] = r2((m[r.currency] || 0) + f(r))), m), {});
  return { horizonDays: days, expected: by((r) => r.expectedValue), bestCase: by((r) => r.amount), invoices: rows, method: 'amount × chance paid within the period, from each client\'s payment history' };
}
