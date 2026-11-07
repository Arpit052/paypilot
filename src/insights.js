// Analytics page: trends, comparisons with the previous period, payment behaviour per
// client, aging of unpaid money and the services that earn the most.
// Amounts are in the main currency (config.currency); other currencies are left out of
// the sums and counted separately so nothing is silently mixed.
import { config, isoDate, addDays, daysBetween, cents } from './config.js';
import { listInvoices, listClients, listSchedules } from './db.js';
import { isOpen, isPaid } from './analytics.js';
import { forecastFromModel } from './budget.js';

const r2 = (n) => cents(n);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function windowStats(invs, from, to) {
  const paid = invs.filter((i) => isPaid(i) && i.paidDate >= from && i.paidDate <= to);
  const sent = invs.filter((i) => i.status !== 'CANCELLED' && i.issueDate >= from && i.issueDate <= to);
  const delays = paid.map((i) => daysBetween(i.issueDate, i.paidDate)).filter((d) => d >= 0);
  return {
    revenue: r2(paid.reduce((t, i) => t + i.total, 0)),
    paidCount: paid.length,
    invoiced: r2(sent.reduce((t, i) => t + i.total, 0)),
    sentCount: sent.length,
    avgDaysToPay: delays.length ? Math.round(avg(delays)) : null,
    onTimeRate: paid.length ? Math.round((paid.filter((i) => i.paidDate <= i.dueDate).length / paid.length) * 100) : null,
    avgInvoice: sent.length ? r2(sent.reduce((t, i) => t + i.total, 0) / sent.length) : null,
  };
}

const pct = (a, b) => (a === null || b === null || !b ? null : Math.round(((a - b) / Math.abs(b)) * 100));

export function analytics({ months = 6 } = {}, today = isoDate()) {
  months = [3, 6, 12].includes(Number(months)) ? Number(months) : 6;
  const cur = config.currency;
  const all = listInvoices().filter((i) => i.currency === cur);
  const otherCurrency = listInvoices().length - all.length;
  const days = Math.round(months * 30.4);
  const from = addDays(today, -days + 1);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -days + 1);
  const now = windowStats(all, from, today);
  const prev = windowStats(all, prevFrom, prevTo);

  // weekly received + invoiced, for the trend chart
  const weeks = [];
  const weekCount = Math.ceil(days / 7);
  for (let w = weekCount - 1; w >= 0; w--) {
    const end = addDays(today, -w * 7);
    const start = addDays(end, -6);
    const received = all.filter((i) => isPaid(i) && i.paidDate >= start && i.paidDate <= end).reduce((t, i) => t + i.total, 0);
    const invoiced = all.filter((i) => i.status !== 'CANCELLED' && i.issueDate >= start && i.issueDate <= end).reduce((t, i) => t + i.total, 0);
    weeks.push({ start, end, received: r2(received), invoiced: r2(invoiced) });
  }

  // when clients pay, relative to the due date
  const paidNow = all.filter((i) => isPaid(i) && i.paidDate >= from && i.paidDate <= today);
  const late = (i) => daysBetween(i.dueDate, i.paidDate);
  const timing = [
    { key: 'early', label: 'Early or on time', count: paidNow.filter((i) => late(i) <= 0).length },
    { key: 'late7', label: '1–7 days late', count: paidNow.filter((i) => late(i) >= 1 && late(i) <= 7).length },
    { key: 'late30', label: '8–30 days late', count: paidNow.filter((i) => late(i) >= 8 && late(i) <= 30).length },
    { key: 'late30p', label: '30+ days late', count: paidNow.filter((i) => late(i) > 30).length },
  ];

  // unpaid money by age
  const open = all.filter(isOpen);
  const ageOf = (i) => daysBetween(i.dueDate, today);
  const aging = [
    { key: 'current', label: 'Not due yet', invs: open.filter((i) => ageOf(i) <= 0) },
    { key: 'a30', label: '1–30 days', invs: open.filter((i) => ageOf(i) >= 1 && ageOf(i) <= 30) },
    { key: 'a60', label: '31–60 days', invs: open.filter((i) => ageOf(i) >= 31 && ageOf(i) <= 60) },
    { key: 'a60p', label: '60+ days', invs: open.filter((i) => ageOf(i) > 60) },
  ].map((b) => ({ key: b.key, label: b.label, count: b.invs.length, amount: r2(b.invs.reduce((t, i) => t + i.total, 0)) }));

  // per-client behaviour in the period
  const clients = listClients()
    .map((c) => {
      const mine = all.filter((i) => i.clientId === c.id);
      const n = windowStats(mine, from, today);
      const p = windowStats(mine, prevFrom, prevTo);
      const paidMine = mine.filter((i) => isPaid(i) && i.paidDate >= from);
      const lateDays = paidMine.map(late);
      const openMine = mine.filter(isOpen);
      return {
        id: c.id,
        name: c.name,
        company: c.company || '',
        role: c.role || '',
        revenue: n.revenue,
        prevRevenue: p.revenue,
        change: pct(n.revenue, p.revenue),
        invoices: n.sentCount,
        paidCount: n.paidCount,
        avgDaysLate: lateDays.length ? Math.max(0, Math.round(avg(lateDays))) : null,
        onTimeRate: n.onTimeRate,
        outstanding: r2(openMine.reduce((t, i) => t + i.total, 0)),
        overdue: r2(openMine.filter((i) => ageOf(i) > 0).reduce((t, i) => t + i.total, 0)),
        lastPaid: mine.filter(isPaid).map((i) => i.paidDate).sort().at(-1) || null,
        monthly: Array.from({ length: months }, (_, k) => {
          const mEnd = addDays(today, -k * 30);
          const mStart = addDays(mEnd, -29);
          return r2(mine.filter((i) => isPaid(i) && i.paidDate >= mStart && i.paidDate <= mEnd).reduce((t, i) => t + i.total, 0));
        }).reverse(),
      };
    })
    .filter((c) => c.revenue || c.outstanding || c.invoices)
    .sort((a, b) => b.revenue - a.revenue || b.outstanding - a.outstanding);
  const totalRev = clients.reduce((t, c) => t + c.revenue, 0) || 1;
  clients.forEach((c) => (c.share = Math.round((c.revenue / totalRev) * 100)));

  // what earns the most (line items in the period)
  const svc = new Map();
  for (const i of all.filter((x) => x.status !== 'CANCELLED' && x.issueDate >= from)) {
    for (const it of i.items || []) {
      if (it.lateFee) continue;
      const key = String(it.name).replace(/\s*(,|\(| - ).*$/, '').trim() || it.name;
      const row = svc.get(key) || { name: key, amount: 0, count: 0 };
      row.amount += it.quantity * it.unitPrice;
      row.count += 1;
      svc.set(key, row);
    }
  }
  const services = [...svc.values()].map((s) => ({ ...s, amount: r2(s.amount) })).sort((a, b) => b.amount - a.amount).slice(0, 6);

  // concentration + repeat business
  const top = clients[0];
  const repeat = clients.filter((c) => c.invoices >= 2).length;
  const fc = forecastFromModel(30, today);

  // calendar months, oldest first (the current month is marked partial)
  const monthly = [];
  const [ty, tm] = today.split('-').map(Number);
  for (let k = months - 1; k >= 0; k--) {
    const d = new Date(Date.UTC(ty, tm - 1 - k, 1));
    const key = d.toISOString().slice(0, 7);
    const inMonth = (date) => date && date.slice(0, 7) === key;
    const paid = all.filter((i) => isPaid(i) && inMonth(i.paidDate));
    monthly.push({
      key,
      label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
      year: d.getUTCFullYear(),
      received: r2(paid.reduce((t, i) => t + i.total, 0)),
      payments: paid.length,
      invoiced: r2(all.filter((i) => i.status !== 'CANCELLED' && inMonth(i.issueDate)).reduce((t, i) => t + i.total, 0)),
      partial: k === 0,
    });
  }
  // how steady income is (full months only)
  const full = monthly.filter((x) => !x.partial);
  const vals = full.map((x) => x.received);
  const mean = avg(vals) || 0;
  const sdv = vals.length > 1 ? Math.sqrt(vals.reduce((t, v) => t + (v - mean) ** 2, 0) / (vals.length - 1)) : 0;
  const lo = full.length ? full.reduce((a, b) => (b.received < a.received ? b : a)) : null;
  const hi = full.length ? full.reduce((a, b) => (b.received > a.received ? b : a)) : null;
  const onPlan = new Set(listSchedules().filter((x) => x.active).map((x) => x.clientId));
  const recurringRevenue = clients.filter((c) => onPlan.has(c.id)).reduce((t, c) => t + c.revenue, 0);
  const stability = {
    perMonth: r2(mean),
    swingPct: mean ? Math.round((sdv / mean) * 100) : null, // coefficient of variation
    low: lo && { label: `${lo.label} ${lo.year}`, amount: lo.received },
    high: hi && { label: `${hi.label} ${hi.year}`, amount: hi.received },
    recurringShare: now.revenue ? Math.round((recurringRevenue / now.revenue) * 100) : 0,
    months: full.length,
  };

  const fmt = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v);
  const insights = [];
  const add = (tone, text, link) => insights.push({ tone, text, link });
  const overdueAmt = aging.filter((a) => a.key !== 'current').reduce((t, a) => t + a.amount, 0);
  if (overdueAmt) add('warn', `${fmt(overdueAmt)} is overdue right now, across ${aging.filter((a) => a.key !== 'current').reduce((t, a) => t + a.count, 0)} invoices.`, { href: '/invoices', label: 'Chase it' });
  const slow = clients.filter((c) => c.avgDaysLate !== null && c.avgDaysLate >= 7).sort((a, b) => b.avgDaysLate - a.avgDaysLate)[0];
  if (slow) add('warn', `${slow.name} pays ${slow.avgDaysLate} days late on average. Ask for a deposit on the next job, or send reminders sooner.`, { href: '/clients', label: 'See client' });
  if (top && top.share >= 35) add('warn', `${top.name} brings in ${top.share}% of your revenue. If they left, income would drop by about a third; worth growing other clients.`);
  if (now.revenue && prev.revenue) {
    const ch = pct(now.revenue, prev.revenue);
    add(ch >= 0 ? 'good' : 'warn', ch >= 0 ? `Revenue is up ${ch}% on the previous ${months} months.` : `Revenue is down ${-ch}% on the previous ${months} months.`);
  }
  if (stability.swingPct !== null && stability.months >= 3 && stability.swingPct >= 35)
    add('info', `Your monthly income swings by about ${stability.swingPct}% around ${fmt(stability.perMonth)}. Retainers make it steadier.`, { href: '/clients#offers', label: 'Suggested retainers' });
  const fast = clients.filter((c) => c.onTimeRate === 100 && c.paidCount >= 2 && !onPlan.has(c.id))[0];
  if (fast) add('good', `${fast.name} has paid every invoice on time. A good client to offer a monthly plan.`, { href: '/clients#offers', label: 'Retainers' });
  if (services[0]) add('info', `Your best-earning work is “${services[0].name}”: ${fmt(services[0].amount)} from ${services[0].count} invoice line${services[0].count > 1 ? 's' : ''}.`);

  return {
    currency: cur,
    months,
    from,
    to: today,
    otherCurrency,
    hasPrev: prev.paidCount + prev.sentCount > 0,
    paidCount: now.paidCount,
    onTimeCount: paidNow.filter((i) => late(i) <= 0).length,
    overdueTotal: r2(overdueAmt),
    monthly,
    stability,
    topClient: top ? { name: top.name, share: top.share } : null,
    kpis: {
      revenue: { value: now.revenue, prev: prev.revenue, change: pct(now.revenue, prev.revenue) },
      invoiced: { value: now.invoiced, prev: prev.invoiced, change: pct(now.invoiced, prev.invoiced), count: now.sentCount },
      avgDaysToPay: { value: now.avgDaysToPay, prev: prev.avgDaysToPay, change: now.avgDaysToPay !== null && prev.avgDaysToPay !== null ? now.avgDaysToPay - prev.avgDaysToPay : null },
      onTimeRate: { value: now.onTimeRate, prev: prev.onTimeRate, change: now.onTimeRate !== null && prev.onTimeRate !== null ? now.onTimeRate - prev.onTimeRate : null },
      avgInvoice: { value: now.avgInvoice, prev: prev.avgInvoice, change: pct(now.avgInvoice, prev.avgInvoice) },
      outstanding: { value: r2(open.reduce((t, i) => t + i.total, 0)), count: open.length },
      expected30: { value: r2((fc.expected && typeof fc.expected === 'object' ? fc.expected[cur] : fc.expected) || 0) },
      repeatClients: { value: repeat, of: clients.length },
    },
    weeks,
    timing,
    aging,
    clients,
    services,
    insights,
  };
}
