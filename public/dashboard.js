import { api, header, esc, money, moneyMap, fmtDate, toast, RISK_TEXT, daysLateText, openInvoiceDrawer, markPaidButton, copyPayLink } from './common.js';

const $ = (id) => document.getElementById(id);
const cfg = await header('dashboard');
const cur = cfg.currency;

const state = { filter: 'all', sort: { key: 'issueDate', dir: 'desc' }, q: '', month: null };
let data = { invoices: [], dash: null };

const OPEN = ['SENT', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'SCHEDULED'];
const isPaid = (i) => ['PAID', 'MARKED_AS_PAID'].includes(i.status);
const FILTERS = {
  all: { label: 'All invoices', fn: () => true },
  open: { label: 'Waiting to be paid', fn: (i) => OPEN.includes(i.status) },
  overdue: { label: 'Overdue', fn: (i) => i.displayStatus === 'OVERDUE' },
  paid: { label: 'Paid', fn: isPaid },
  paidThisMonth: { label: 'Paid this month', fn: (i) => isPaid(i) && i.paidDate?.startsWith(data.dash.today.slice(0, 7)) },
  expected30: { label: 'Expected in the next 30 days', fn: (i) => data.dash.forecast.invoices.some((f) => f.invoice === i.number) },
};

// ---------------- figures (clickable) ----------------
function renderFigures() {
  const s = data.dash.summary;
  const card = (filter, k, v, sub, extra = '') =>
    `<button class="fig ${extra} ${state.filter === filter ? 'active' : ''}" data-filter="${filter}" aria-pressed="${state.filter === filter}">
      <div class="k">${k}</div><div class="v num">${v}</div><div class="s">${sub}</div></button>`;
  $('figures').innerHTML =
    card('paidThisMonth', 'Earned this month', moneyMap(s.earned, cur), `${s.paidInvoices} paid invoice${s.paidInvoices === 1 ? '' : 's'}`) +
    card('open', 'Waiting to be paid', moneyMap(s.outstanding, cur), `${s.openInvoices} open`) +
    card('overdue', 'Overdue', moneyMap(s.overdue, cur), s.overdueInvoices ? `${s.overdueInvoices} invoice${s.overdueInvoices > 1 ? 's' : ''} late` : 'Nothing late', s.overdueInvoices ? 'late' : '') +
    card('expected30', 'Expected in 30 days', moneyMap(data.dash.forecast.expected, cur), "Weighted by each client's habits");
}

$('figures').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  setFilter(state.filter === b.dataset.filter ? 'all' : b.dataset.filter);
  $('invoices').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function setFilter(f) {
  state.filter = f;
  document.querySelectorAll('#seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === f)));
  renderFigures();
  renderTable();
}

// ---------------- chart (months clickable) ----------------
function chartSvg({ months }) {
  const W = 640, H = 300, padL = 8, padB = 28, padT = 24, gap = 22;
  const max = Math.max(1, ...months.map((b) => b.value));
  const bw = (W - padL * 2 - gap * (months.length - 1)) / months.length;
  let out = `<defs><linearGradient id="barg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d4d4d8"/><stop offset="1" stop-color="#52525b" stop-opacity=".55"/></linearGradient>
    <linearGradient id="barsel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#a1a1aa" stop-opacity=".8"/></linearGradient></defs>`;
  for (let g = 0; g <= 3; g++) {
    const gy = padT + ((H - padB - padT) * g) / 3;
    out += `<line x1="0" x2="${W}" y1="${gy}" y2="${gy}" stroke="rgba(255,255,255,0.06)"/>`;
  }
  months.forEach((b, i) => {
    const x = padL + i * (bw + gap);
    const h = ((H - padB - padT) * b.value) / max;
    const y = H - padB - h;
    const sel = state.month === b.key;
    out += `<g class="bar" role="button" tabindex="0" data-month="${b.key}" aria-label="${b.label}: ${money(b.value, cur)}. Show payments">`;
    out += `<rect x="${x - 6}" y="${padT - 10}" width="${bw + 12}" height="${H - padT + 10}" fill="transparent"/>`;
    out += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(h, 1)}" rx="6" fill="url(#${sel ? 'barsel' : 'barg'})"><title>${b.label}: ${money(b.value, cur)}</title></rect>`;
    if (b.value) out += `<text x="${x + bw / 2}" y="${y - 7}" text-anchor="middle" font-size="12" font-weight="700" fill="${sel ? '#e0f2fe' : '#c7cdea'}">${money(b.value, cur)}</text>`;
    out += `<text x="${x + bw / 2}" y="${H - 9}" text-anchor="middle" font-size="12" fill="${sel ? '#7dd3fc' : '#7e88aa'}" font-weight="${sel ? 800 : 500}">${b.label}</text></g>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Money received per month">${out}</svg>`;
}

// three plain facts under the chart: best month, monthly average, this month vs last
function chartStats({ months }) {
  if (!months.length) return '';
  const best = months.reduce((a, b) => (b.value > a.value ? b : a));
  const done = months.slice(0, -1); // the current month isn't over yet
  const avg = done.length ? done.reduce((t, m) => t + m.value, 0) / done.length : 0;
  const cur0 = months.at(-1), prev = months.at(-2);
  let trend = 'No payments last month';
  if (prev?.value) {
    const pct = Math.round(((cur0.value - prev.value) / prev.value) * 100);
    trend = pct === 0 ? `Same as ${prev.label}` : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}% vs ${prev.label}`;
  }
  const stat = (label, value, sub) => `<div class="cstat"><span class="muted">${label}</span><b>${value}</b><span class="muted">${sub}</span></div>`;
  return `<div class="chart-stats">
    ${stat('Best month', money(best.value, cur), best.label)}
    ${stat('Monthly average', money(Math.round(avg * 100) / 100, cur), `last ${done.length} full months`)}
    ${stat(`${cur0.label} so far`, money(cur0.value, cur), trend)}
  </div>`;
}

async function showMonth(key) {
  state.month = key;
  $('chart').innerHTML = chartSvg(data.dash.chart);
  const p = await api(`/api/payments?month=${key}`);
  const label = new Date(key + '-01T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('monthDetail').innerHTML = `
    <div class="month-detail">
      <div class="md-head"><h3>Payments received in ${label}</h3><button class="btn ghost small" id="mdClose">Close</button></div>
      <p class="muted" style="margin:0 0 8px">${p.count ? `${moneyMap(p.total, cur)} from ${p.count} payment${p.count > 1 ? 's' : ''}` : 'No payments received this month.'}</p>
      ${p.count ? `<table class="data"><thead><tr><th>Paid on</th><th>Client</th><th>Invoice</th><th>Work</th><th>Timing</th><th class="r">Amount</th></tr></thead><tbody>${p.payments
        .map((x) => `<tr><td>${fmtDate(x.paidDate)}</td><td>${esc(x.client)}</td><td class="num">#${esc(x.number)}</td><td class="muted">${esc(x.work).slice(0, 48)}</td><td>${x.daysLate ? `<span style="color:var(--due)">${daysLateText(x.daysLate)}</span>` : 'On time'}</td><td class="r num">${money(x.amount, x.currency)}</td></tr>`)
        .join('')}</tbody></table>` : ''}
    </div>`;
  $('mdClose').onclick = () => {
    state.month = null;
    $('monthDetail').innerHTML = '';
    $('chart').innerHTML = chartSvg(data.dash.chart);
  };
}

$('chart').addEventListener('click', (e) => {
  const g = e.target.closest('[data-month]');
  if (g) showMonth(g.dataset.month);
});
$('chart').addEventListener('keydown', (e) => {
  const g = e.target.closest('[data-month]');
  if (g && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    showMonth(g.dataset.month);
  }
});

// ---------------- top customers ----------------
async function renderLeaders() {
  const { customers } = await api('/api/insights/top-customers?limit=5');
  $('leaders').innerHTML = customers.length
    ? customers
        .map(
          (c) => `<li>
            <span class="rank ${c.rank === 1 ? 'first' : ''}">${c.rank}</span>
            <div class="who"><b>${esc(c.client)}</b><span class="muted">${c.invoices} paid invoice${c.invoices > 1 ? 's' : ''} · ${c.share}% of revenue</span>
              <span class="share"><i style="width:${Math.max(c.share, 3)}%"></i></span></div>
            <span class="num amt">${money(c.totalPaid, c.currency)}</span>
          </li>`
        )
        .join('')
    : '<li class="muted">No payments yet.</li>';
}

// ---------------- invoice table (filter, search, sort) ----------------
const COLS = [
  ['number', '#'],
  ['client', 'Client'],
  ['work', 'Work'],
  ['issueDate', 'Issued'],
  ['dueDate', 'Due'],
  ['displayStatus', 'Invoice status'],
  ['total', 'Amount', 'r'],
];

function sortVal(i, key) {
  if (key === 'work') return i.items.map((x) => x.name).join(', ').toLowerCase();
  if (key === 'total') return i.total;
  if (key === 'number') return Number(String(i.number).replace(/\D/g, '')) || 0;
  return String(i[key] ?? '').toLowerCase();
}

function renderTable() {
  const { key, dir } = state.sort;
  const q = state.q.trim().toLowerCase();
  const rows = data.invoices
    .filter(FILTERS[state.filter].fn)
    .filter((i) => !q || `${i.client} ${i.items.map((x) => x.name).join(' ')} ${i.number}`.toLowerCase().includes(q))
    .sort((a, b) => {
      const x = sortVal(a, key), y = sortVal(b, key);
      return (x > y ? 1 : x < y ? -1 : 0) * (dir === 'asc' ? 1 : -1);
    });
  const total = rows.reduce((s, i) => s + (i.currency === cur ? i.total : 0), 0);
  $('filterNote').innerHTML =
    state.filter !== 'all' || q
      ? `Showing <b>${rows.length}</b> invoice${rows.length === 1 ? '' : 's'} (${FILTERS[state.filter].label.toLowerCase()}${q ? `, matching "${esc(state.q)}"` : ''}), totalling <b>${money(total, cur)}</b>. <button class="linkbtn" id="clearF">Show all</button>`
      : '';
  $('clearF')?.addEventListener('click', () => {
    state.q = '';
    $('search').value = '';
    setFilter('all');
  });

  if (!data.invoices.length) {
    $('invoices').innerHTML = `<div class="empty">No invoices yet.<br><a class="btn" href="/assistant">Create one with the Assistant</a> <button class="btn ghost" id="seedBtn">Load demo history</button></div>`;
    $('seedBtn').onclick = async () => { await api('/api/demo/seed', { body: {} }); load(); };
    return;
  }
  const mock = cfg.paypalMode === 'mock';
  const th = ([k, label, cls]) => {
    const active = key === k;
    return `<th class="${cls || ''}" aria-sort="${active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button class="sort" data-sort="${k}">${label}<span class="arrow">${active ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span></button></th>`;
  };
  $('invoices').innerHTML = rows.length
    ? `<table class="data"><thead><tr>${COLS.map(th).join('')}<th></th></tr></thead><tbody>${rows
        .map(
          (i) => `<tr class="clickable" data-inv="${esc(i.id)}" tabindex="0" title="Click to see this invoice's timeline">
            <td class="num">${esc(i.number)}</td>
            <td>${esc(i.client)}</td>
            <td class="muted">${esc(i.items.map((x) => x.name).join(', ')).slice(0, 60)}</td>
            <td>${fmtDate(i.issueDate)}</td>
            <td>${fmtDate(i.dueDate)}</td>
            <td><span class="pill ${i.displayStatus}">${i.displayStatus === 'OVERDUE' ? 'Overdue' : i.displayStatus.charAt(0) + i.displayStatus.slice(1).toLowerCase().replace(/_/g, ' ')}</span>${i.source === 'seed' ? ' <span class="muted" title="Demo history, not on PayPal">demo</span>' : i.source === 'import' ? ' <span class="muted" title="Created on PayPal, imported by PayPilot">imported</span>' : ''}${i.depositAmount ? ` <span class="muted" title="Deposit due upfront">deposit ${money(i.depositAmount, i.currency)}</span>` : ''}</td>
            <td class="r num">${money(i.total, i.currency)}</td>
            <td class="r">${
              OPEN.includes(i.status)
                ? `<div class="row-acts">${i.payerUrl ? `<button class="linkbtn small" data-copylink="${esc(i.payerUrl)}" title="Copy the PayPal link your client pays from">Copy link</button>` : ''}${markPaidButton(i.id)}</div>`
                : ''
            }</td>
          </tr>`
        )
        .join('')}</tbody></table>`
    : '<div class="empty">No invoices match this filter.</div>';
}

$('invoices').addEventListener('click', async (e) => {
  const s = e.target.closest('[data-sort]');
  if (s) {
    const k = s.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === 'desc' ? 'asc' : 'desc' };
    return renderTable();
  }
  const cp = e.target.closest('[data-copylink]');
  if (cp) return copyPayLink(cp.dataset.copylink);
  if (e.target.closest('a, button')) return;
  const row = e.target.closest('[data-inv]');
  if (row) showInvoice(row.dataset.inv);
});
$('invoices').addEventListener('keydown', (e) => {
  const row = e.target.closest?.('[data-inv]');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    showInvoice(row.dataset.inv);
  }
});
function showInvoice(id) {
  const inv = data.invoices.find((x) => x.id === id);
  if (!inv) return;
  openInvoiceDrawer(inv, {
    today: data.dash?.today,
    mock: cfg.paypalMode === 'mock',
    onSimulatePay: async (pid) => {
      await api(`/api/mock/pay/${pid}`, { body: {} });
      load();
    },
  });
}
$('seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (b) setFilter(b.dataset.f);
});
$('search').addEventListener('input', (e) => {
  state.q = e.target.value;
  renderTable();
});

// ---------------- money brief ----------------
function pct(n) {
  if (n === null || n === undefined) return '';
  if (n === 0) return 'the same';
  return n > 0 ? `<span style="color:var(--paid)">up ${n}%</span>` : `<span style="color:var(--late)">down ${Math.abs(n)}%</span>`;
}

function renderBrief(b) {
  const f = b.facts;
  const L = f.lifetime;
  const step = (n, title, body) => `<li class="bstep"><span class="bnum">${n}</span><div><h3>${title}</h3>${body}</div></li>`;
  let n = 0;
  const steps = [];
  steps.push(step(++n, 'Total earned so far', `<p><b class="big num">${moneyMap(L.totalEarned, cur)}</b> from ${L.paidInvoices} paid invoices${L.since ? ` since ${fmtDate(L.since)}` : ''}.</p>
    <p class="muted">${L.onTimeRate !== null ? `${L.onTimeRate}% paid on time · ` : ''}${L.avgDaysToGetPaid !== null ? `clients take ${L.avgDaysToGetPaid} days on average to pay` : ''}</p>`));
  const tm = f.thisMonth;
  steps.push(step(++n, `This month (${tm.label})`, `<p><b class="big num">${money(tm.earned, cur)}</b> from ${tm.paidInvoices} payment${tm.paidInvoices === 1 ? '' : 's'}.</p>
    <p class="muted">${tm.lastMonthLabel}: ${money(tm.lastMonthEarned, cur)}${tm.changePct !== null ? (tm.changePct === 0 ? ' · same as last month' : ` · ${pct(tm.changePct)} vs last month`) : ''}</p>`));
  steps.push(step(++n, 'Top customers', f.topCustomers.length ? `<ol class="mini">${f.topCustomers.map((c) => `<li><b>${esc(c.client)}</b>: ${money(c.totalPaid, c.currency)} <span class="muted">(${c.invoices} invoices, ${c.share}% of revenue)</span></li>`).join('')}</ol>` : '<p class="muted">No payments yet.</p>'));
  steps.push(step(++n, 'Overdue, by customer', f.overdue.byCustomer.length ? `<p><b class="num">${money(f.overdue.total, cur)}</b> is late across ${f.overdue.invoices} invoice${f.overdue.invoices > 1 ? 's' : ''}:</p><ul class="mini">${f.overdue.byCustomer.map((o) => `<li><b>${esc(o.client)}</b>: <span style="color:var(--late)">${money(o.amount, o.currency)}</span> <span class="muted">(invoice ${o.invoices.map((x) => '#' + esc(x)).join(', ')} · up to ${o.maxDaysOverdue} days late · ${o.remindersSent} reminder${o.remindersSent === 1 ? '' : 's'} sent)</span></li>`).join('')}</ul>` : '<p>Nothing is overdue.</p>'));
  steps.push(step(++n, 'Still to collect', `<p><b class="num">${money(f.outstanding.total, cur)}</b> open across ${f.outstanding.invoices} invoice${f.outstanding.invoices === 1 ? '' : 's'}. Expected in the next 30 days: <b class="num">${money(f.next30Days.expected, cur)}</b> <span class="muted">(best case ${money(f.next30Days.bestCase, cur)})</span>.</p>`));
  if (f.watchList.length) steps.push(step(++n, 'Clients to watch', `<ul class="mini">${f.watchList.map((w) => `<li><b>${esc(w.client)}</b>: ${RISK_TEXT[w.risk]} risk, usually ${daysLateText(w.avgDaysLate).toLowerCase()}${w.outstanding ? `, owes ${money(w.outstanding, cur)}` : ''}</li>`).join('')}</ul>`));
  const ai = b.ai
    ? `${b.ai.headline ? `<p class="headline">${esc(b.ai.headline)}</p>` : ''}${b.ai.actions.length ? `<ol class="mini">${b.ai.actions.map((a) => `<li>${esc(a).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`).join('')}</ol>` : ''}`
    : `<p class="muted">AI recommendations are unavailable right now (${esc(b.aiError || 'unknown error')}). The numbers above are always up to date.</p>`;
  steps.push(step(++n, 'Recommended next steps', ai));
  $('briefBody').innerHTML = `<ol class="bsteps">${steps.join('')}</ol>`;
}

$('briefBtn').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const refresh = btn.textContent === 'Refresh';
  btn.textContent = 'Thinking…';
  try {
    const b = await api('/api/brief', { body: { refresh } });
    renderBrief(b);
    $('briefMeta').textContent = `Generated ${new Date(b.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${b.cached ? ' · AI notes cached' : ''}`;
    btn.textContent = 'Refresh';
  } catch (err) {
    $('briefBody').innerHTML = `<p style="color:var(--late)">${esc(err.message)}</p>`;
    btn.textContent = 'Try again';
  } finally {
    btn.disabled = false;
  }
};

// ---------------- activity + load ----------------
function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return fmtDate(iso.slice(0, 10));
}

async function load() {
  const [dash, inv] = await Promise.all([api('/api/dashboard'), api('/api/invoices')]);
  data = { dash, invoices: inv.invoices };
  $('asof').textContent = `As of ${fmtDate(dash.today)}${dash.pendingApprovals ? ` · ${dash.pendingApprovals} draft${dash.pendingApprovals > 1 ? 's' : ''} waiting for your approval` : ''}`;
  renderFigures();
  renderLive(dash.sync);
  $('chart').innerHTML = chartSvg(dash.chart);
  $('chartStats').innerHTML = chartStats(dash.chart);
  $('feed').innerHTML = dash.activity.length
    ? dash.activity.map((a) => `<li><time datetime="${a.at}">${timeAgo(a.at)}</time><span>${esc(a.text)}</span></li>`).join('')
    : '<li class="muted">Nothing yet. Send your first invoice from the Assistant.</li>';
  renderTable();
  renderLeaders();
}

// Live status: PayPilot checks PayPal by itself every couple of minutes.
// The small button forces a check right now (e.g. a client says "I just paid").
function renderLive(sync) {
  const el = $('livePill');
  if (!sync?.live) {
    el.innerHTML = `<a class="lp demo" href="/settings" title="Connect PayPal to see real payments arrive automatically"><span class="lp-dot"></span>Demo mode · <b>Connect PayPal</b></a>`;
    return;
  }
  const when = sync.lastAt ? timeAgo(sync.lastAt) : 'starting…';
  el.innerHTML = `<span class="lp" title="PayPilot checks PayPal for payments every ${Math.round(sync.everySeconds / 60) || 1} min and imports invoices you create on paypal.com"><span class="lp-dot on"></span>Live with PayPal · checked ${esc(when)}</span>
    <button class="lp-btn" id="checkNow" title="Check PayPal now" aria-label="Check PayPal now"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>`;
  $('checkNow').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.classList.add('spin');
    try {
      const r = await api('/api/sync', { body: {} });
      const parts = [];
      if (r.changed) parts.push(`${r.changed} invoice${r.changed > 1 ? 's' : ''} updated`);
      if (r.imported) parts.push(`${r.imported} new from PayPal`);
      toast(parts.length ? parts.join(' · ') : 'Up to date. No new payments.');
      await load();
    } catch (err) {
      toast(err.message);
      b.disabled = false;
      b.classList.remove('spin');
    }
  };
}
setInterval(() => data?.dash?.sync && renderLive(data.dash.sync), 30000);

await load();
// a payment arrived (pushed live from the server): refresh the numbers right away
window.addEventListener('pp:notification', (e) => {
  if (e.detail.kind === 'payment') load().catch(() => {});
});
setInterval(() => document.visibilityState === 'visible' && load().catch(() => {}), 15000);
window.addEventListener('pp:changed', () => load());
// deep link from search: /?inv=<id> opens that invoice
{
  const id = new URLSearchParams(location.search).get('inv');
  if (id) {
    showInvoice(id);
    history.replaceState(null, '', '/');
  }
}
