// Budget Estimator: "Can I afford X on date D?"
//
// The money you'll have on D is uncertain because you don't know when (or if) each client
// pays. So instead of one guess we run thousands of possible futures (Monte Carlo) and count
// in how many of them you can pay for X and still keep your safety buffer.
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
//  6. Costs. Your monthly costs are spread evenly per day and taken off.
// Result: probability, a range (P10 / P50 / P90), the likely shortfall, the earliest date it
// becomes safe, and which invoices decide the answer.
import { config, isoDate, addDays, addMonths, daysBetween } from './config.js';
import { listInvoices, listSchedules, listClients, kvGet, kvSet, getClient } from './db.js';
import { isOpen, isPaid, clientStats, invoiceTotals } from './analytics.js';

const SIMS = 4000;
const SMOOTH_SD = 1.5; // days of noise added to each historical delay
const PRIOR_WEIGHT = 3; // how many "pretend" data points the shared pool counts as
const HALF_LIFE = 60; // days past the client's slowest payment for the chance of payment to halve
const r2 = (n) => Math.round(n * 100) / 100;
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
export function budgetProfile() {
  return { cashNow: 0, monthlyCosts: 0, buffer: 0, ...(kvGet(PROFILE_KEY) || {}) };
}
function saveProfile(p) {
  kvSet(PROFILE_KEY, { cashNow: p.cashNow, monthlyCosts: p.monthlyCosts, buffer: p.buffer, updatedAt: new Date().toISOString() });
}

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const num = (v, label, { min = 0, max = 1e8, dflt } = {}) => {
  if ((v === undefined || v === null || v === '') && dflt !== undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be a number between ${min} and ${max.toLocaleString('en-US')}`);
  return r2(n);
};

/**
 * Run the estimate. Inputs: price, date (YYYY-MM-DD), and optionally cashNow, monthlyCosts,
 * buffer (default to the saved profile), item (a label), save (remember the money inputs).
 */
export function estimateBudget(input = {}, today = isoDate()) {
  const prof = budgetProfile();
  const price = num(input.price, 'Price', { min: 0.01 });
  const date = String(input.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('Pick the date you want to buy it');
  if (date < today) throw bad('The date has to be today or later');
  if (daysBetween(today, date) > 365) throw bad('Pick a date within the next 12 months');
  const cashNow = num(input.cashNow, 'Money you have now', { min: -1e7, dflt: prof.cashNow });
  const monthlyCosts = num(input.monthlyCosts, 'Monthly costs', { dflt: prof.monthlyCosts });
  const buffer = num(input.buffer, 'Safety buffer', { dflt: prof.buffer });
  if (input.save !== false) saveProfile({ cashNow, monthlyCosts, buffer });

  const cur = config.currency;
  const M = learn(today);
  const target = daysBetween(today, date); // day index of the purchase
  const H = Math.max(target + 45, 90); // timeline we chart (days from today)
  const costPerDay = monthlyCosts / 30.44;
  const need = (t) => price + buffer + costPerDay * t - cashNow; // money that must arrive by day t

  // ---- the things that might pay you ----
  const streams = [];
  const otherCurrency = [];
  for (const inv of listInvoices().filter(isOpen)) {
    if (inv.currency !== cur) {
      otherCurrency.push(inv.number);
      continue;
    }
    const due = amountDue(inv);
    if (!(due > 0)) continue;
    const s = delaySampler(M, inv.clientId);
    const lateNow = Math.max(0, daysBetween(inv.dueDate, today));
    streams.push({
      kind: 'invoice',
      id: inv.id,
      number: inv.number,
      clientId: inv.clientId,
      client: getClient(inv.clientId)?.name || 'Unknown',
      amount: due,
      dueDate: inv.dueDate,
      daysOverdue: lateNow,
      dueOffset: daysBetween(today, inv.dueDate), // day index of the due date
      minDelay: daysBetween(inv.dueDate, today), // can't have been paid before today
      pPay: collectChance(M, inv.clientId, lateNow, s.slowest),
      sampler: s,
    });
  }
  for (const sc of listSchedules().filter((x) => x.active && x.currency === cur)) {
    const total = invoiceTotals(sc.items, sc.taxPercent).total;
    const s = delaySampler(M, sc.clientId);
    let run = sc.nextRun < today ? today : sc.nextRun;
    for (let n = 0; n < 60 && daysBetween(today, run) <= H; n++) {
      const dueOffset = daysBetween(today, run) + sc.dueInDays;
      streams.push({
        kind: 'retainer',
        id: `${sc.id}:${run}`,
        clientId: sc.clientId,
        client: getClient(sc.clientId)?.name || 'Unknown',
        amount: total,
        dueDate: addDays(run, sc.dueInDays),
        issueDate: run,
        dueOffset,
        minDelay: -sc.dueInDays, // can be paid any time after it's sent
        pPay: collectChance(M, sc.clientId, 0, s.slowest),
        sampler: s,
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
  const seed = hash(JSON.stringify([today, price, date, cashNow, monthlyCosts, buffer, streams.map((s) => [s.id, s.amount]), M.sample]));
  const rnd = mulberry32(seed);
  const dayIn = new Float64Array((H + 1) * SIMS); // invoiced money arriving on each day, per sim
  const dayNew = new Float64Array((H + 1) * SIMS); // likely new work arriving on each day, per sim
  const arrivedBy = streams.map(() => new Uint8Array(SIMS)); // did stream k arrive by the target day?
  const payDays = streams.map(() => []);
  for (let s = 0; s < SIMS; s++) {
    const base = s * (H + 1);
    streams.forEach((st, k) => {
      if (rnd() > st.pPay) return; // never paid in this future
      const d = st.sampler.draw(rnd, st.minDelay);
      const day = Math.max(0, st.dueOffset + d);
      if (day <= target) arrivedBy[k][s] = 1;
      if (day <= H) {
        dayIn[base + day] += st.amount;
        payDays[k].push(day);
      }
    });
    for (const w of newWork) {
      const jobs = poisson(rnd, w.ratePerDay * H);
      for (let j = 0; j < jobs; j++) {
        const issued = 1 + Math.floor(rnd() * H);
        const amt = w.amounts[Math.floor(rnd() * w.amounts.length)];
        const day = issued + w.terms + w.sampler.draw(rnd, -w.terms);
        if (day >= 0 && day <= H) dayNew[base + day] += amt;
      }
    }
  }

  // ---- read the futures ----
  const okAt = new Uint32Array(H + 1);
  const okAtNew = new Uint32Array(H + 1);
  const cumByDay = Array.from({ length: H + 1 }, () => new Float64Array(SIMS));
  const atTarget = new Float64Array(SIMS);
  const atTargetNew = new Float64Array(SIMS);
  const affordAtTarget = new Uint8Array(SIMS);
  for (let s = 0; s < SIMS; s++) {
    let cum = 0;
    let cumNew = 0;
    const base = s * (H + 1);
    for (let t = 0; t <= H; t++) {
      cum += dayIn[base + t];
      cumNew += dayIn[base + t] + dayNew[base + t];
      cumByDay[t][s] = cum;
      if (cum >= need(t)) okAt[t]++;
      if (cumNew >= need(t)) okAtNew[t]++;
      if (t === target) {
        atTarget[s] = cum;
        atTargetNew[s] = cumNew;
        affordAtTarget[s] = cum >= need(t) ? 1 : 0;
      }
    }
  }
  const p = okAt[target] / SIMS;
  const pNew = okAtNew[target] / SIMS;
  const sorted = Float64Array.from(atTarget).sort();
  const sortedNew = Float64Array.from(atTargetNew).sort();
  const needed = r2(need(target));
  const cashAt = (inflow) => r2(cashNow + inflow - costPerDay * target - price); // left after buying
  const shortSims = [...atTarget].filter((v) => v < needed);
  const expectedShortfall = shortSims.length ? r2(mean(shortSims.map((v) => needed - v))) : 0;
  // earliest day, on or after the date you asked about, with at least chance q
  const firstDay = (arr, q) => {
    for (let t = target; t <= H; t++) if (arr[t] / SIMS >= q) return addDays(today, t);
    return null;
  };

  // which invoices decide it: P(afford | it arrives) - P(afford | it doesn't)
  const drivers = streams
    .map((st, k) => {
      let yes = 0, yesOk = 0, no = 0, noOk = 0;
      for (let s = 0; s < SIMS; s++) {
        if (arrivedBy[k][s]) {
          yes++;
          yesOk += affordAtTarget[s];
        } else {
          no++;
          noOk += affordAtTarget[s];
        }
      }
      const days = payDays[k].slice().sort((a, b) => a - b);
      return {
        kind: st.kind,
        number: st.number || null,
        client: st.client,
        amount: st.amount,
        dueDate: st.dueDate,
        issueDate: st.issueDate || null,
        daysOverdue: st.daysOverdue || 0,
        risk: clientStats(st.clientId, today).riskLabel,
        history: st.sampler.own,
        chancePaidEver: Math.round(st.pPay * 100),
        chanceByDate: Math.round((yes / SIMS) * 100),
        likelyDate: days.length ? addDays(today, Math.round(quantile(days, 0.5))) : null,
        earlyDate: days.length ? addDays(today, Math.round(quantile(days, 0.1))) : null,
        lateDate: days.length ? addDays(today, Math.round(quantile(days, 0.9))) : null,
        impact: yes >= 40 && no >= 40 ? Math.round((yesOk / yes - noOk / no) * 100) : null,
      };
    })
    .filter((d) => d.kind === 'invoice' || d.issueDate <= date);

  // chart: chance and cash range per day
  const step = H > 120 ? 3 : H > 60 ? 2 : 1;
  const timeline = [];
  for (let t = 0; t <= H; t += step) {
    const col = Float64Array.from(cumByDay[t]).sort();
    const left = (v) => r2(cashNow + v - costPerDay * t);
    timeline.push({
      date: addDays(today, t),
      chance: Math.round((okAt[t] / SIMS) * 1000) / 10,
      chanceNew: Math.round((okAtNew[t] / SIMS) * 1000) / 10,
      p10: left(quantile(col, 0.1)),
      p50: left(quantile(col, 0.5)),
      p90: left(quantile(col, 0.9)),
      line: r2(price + buffer),
    });
  }

  const P = (q) => r2(quantile(sorted, q));
  const result = {
    item: String(input.item || '').trim().slice(0, 80),
    price,
    date,
    currency: cur,
    inputs: { cashNow, monthlyCosts, buffer },
    days: target,
    costsUntil: r2(costPerDay * target),
    needed: Math.max(0, needed), // money that must still come in by the date
    chance: Math.round(p * 1000) / 10,
    chanceWithNewWork: Math.round(pNew * 1000) / 10,
    margin: Math.round(Math.sqrt((p * (1 - p)) / SIMS) * 1.96 * 1000) / 10, // 95% Monte Carlo error, in points
    inflow: { p10: P(0.1), p50: P(0.5), p90: P(0.9), mean: r2(mean([...atTarget])), withNewWorkP50: r2(quantile(sortedNew, 0.5)) },
    leftAfter: { p10: cashAt(P(0.1)), p50: cashAt(P(0.5)), p90: cashAt(P(0.9)) },
    shortfall: {
      likely: r2(Math.max(0, needed - P(0.5))), // in a typical future
      badCase: r2(Math.max(0, needed - P(0.1))), // in a bad 1-in-10 future
      ifShort: expectedShortfall, // average gap in the futures where it falls short
    },
    safeDates: { p50: firstDay(okAt, 0.5), p80: firstDay(okAt, 0.8), p95: firstDay(okAt, 0.95) },
    safeDatesWithNewWork: { p80: firstDay(okAtNew, 0.8) },
    owedTotal: r2(streams.filter((s) => s.kind === 'invoice').reduce((t, s) => t + s.amount, 0)),
    drivers: drivers.sort((a, b) => (b.impact ?? -1) - (a.impact ?? -1) || b.amount - a.amount),
    newWorkClients: newWork.map((w) => ({ client: w.client, perMonth: Math.round(w.ratePerDay * 30.44 * 10) / 10 })),
    timeline,
    model: {
      simulations: SIMS,
      paymentsLearnedFrom: M.sample,
      clientsWithHistory: M.byClient.size,
      smoothingDays: SMOOTH_SD,
      priorWeight: PRIOR_WEIGHT,
      halfLifeDays: HALF_LIFE,
      otherCurrencyLeftOut: otherCurrency,
      lowData: M.sample < 10,
    },
  };
  result.verdict = verdict(result);
  return result;
}

const pct = (c) => (c >= 99.5 ? 'Over 99%' : c < 0.5 ? 'Under 1%' : `${Math.round(c)}%`);
const fmt = (cur, v) => `${cur} ${Math.round(v).toLocaleString('en-US')}`;
const nice = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Plain-English answer built from the numbers (no AI needed, so it's always available). */
export function verdict(r) {
  // the invoice most likely to break the plan: matters a lot AND might not arrive in time
  const key = r.drivers
    .filter((d) => d.kind === 'invoice' && (d.impact ?? 0) >= 15 && d.chanceByDate < 97)
    .sort((a, b) => b.impact * (100 - b.chanceByDate) - a.impact * (100 - a.chanceByDate))[0];
  const keyText = key ? ` The invoice to watch is #${key.number} from ${key.client} (${fmt(r.currency, key.amount)}): it reaches you in time in ${key.chanceByDate}% of futures.` : '';
  if (r.needed <= 0)
    return { level: 'yes', headline: 'Yes, you can afford it now.', detail: `What you have already covers it, your costs until ${nice(r.date)} and your buffer, without waiting for any client.` };
  if (r.chance >= 90)
    return { level: 'yes', headline: `Yes. ${pct(r.chance)} chance you can buy it on ${nice(r.date)}.`, detail: `In a typical future you'd have ${fmt(r.currency, r.leftAfter.p50)} left after buying it, above your buffer.${keyText}` };
  if (r.chance >= 60)
    return {
      level: 'maybe',
      headline: `Probably. ${pct(r.chance)} chance on ${nice(r.date)}.`,
      detail: `It depends on clients paying on their usual schedule.${keyText}${r.safeDates.p80 && r.safeDates.p80 > r.date ? ` Waiting until ${nice(r.safeDates.p80)} raises the chance to 80%.` : ''}`,
    };
  const when = r.safeDates.p80
    ? ` The earliest date with an 80% chance is ${nice(r.safeDates.p80)}.`
    : r.safeDatesWithNewWork.p80
      ? ` The money already owed to you isn't enough once your costs are paid. If your regular clients keep sending work at their usual pace, it reaches an 80% chance on ${nice(r.safeDatesWithNewWork.p80)}.`
      : ' The money already owed to you isn\'t enough once your costs are paid, so this needs new work first.';
  return {
    level: 'no',
    headline: r.chance < 0.5 ? `Not yet. Very unlikely by ${nice(r.date)}.` : `Not yet. Only a ${Math.round(r.chance)}% chance on ${nice(r.date)}.`,
    detail: `In a typical future you'd be about ${fmt(r.currency, r.shortfall.likely)} short, and ${fmt(r.currency, r.shortfall.badCase)} short in a bad month.${when}${keyText}`,
  };
}

