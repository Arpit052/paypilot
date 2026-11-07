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
    `<div class="fig-wrap">${card('expected30', 'Expected in 30 days', moneyMap(data.dash.forecast.expected, cur), "Weighted by each client's habits")}
      <button class="fig-info" type="button" aria-label="How this number is worked out" aria-describedby="figPop">i</button>
      <div class="fig-pop" id="figPop" role="tooltip">${forecastWorking()}</div></div>`;
}

function forecastWorking() {
  const f = data.dash.forecast;
  const rows = f.invoices.filter((r) => r.currency === cur);
  if (!rows.length) return '<b>Nothing expected</b><p>No unpaid invoices are likely to be paid in the next 30 days.</p>';
  const total = rows.reduce((t, r) => t + r.expectedValue, 0);
  return `<b>How this number is worked out</b>
    <p>Each unpaid invoice counts for its amount times the chance it's paid in the next 30 days. The chance comes from how that client has paid before.</p>
    <table><tbody>${rows
      .map((r) => `<tr><td>${esc(r.client)} <span>#${esc(r.invoice)}</span></td><td class="r">${money(r.amount, cur)}</td><td class="x">×</td><td class="r">${Math.round(r.probability * 100)}%</td><td class="r"><b>${money(r.expectedValue, cur)}</b></td></tr>`)
      .join('')}</tbody><tfoot><tr><td colspan="4">Expected in 30 days</td><td class="r"><b>${money(Math.round(total * 100) / 100, cur)}</b></td></tr></tfoot></table>
    <p class="fig-pop-n">Likely dates: ${rows.map((r) => `${esc(r.client.split(' ')[0])} ${fmtDate(r.expectedDate)}`).join(' · ')}</p>`;
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
  ['money', 'Paid / expected'],
  ['displayStatus', 'Invoice status'],
  ['total', 'Amount', 'r'],
];

function sortVal(i, key) {
  if (key === 'work') return i.items.map((x) => x.name).join(', ').toLowerCase();
  if (key === 'total') return i.total;
  if (key === 'number') return Number(String(i.number).replace(/\D/g, '')) || 0;
  if (key === 'money') return i.paidDate || i.expected?.date || '';
  return String(i[key] ?? '').toLowerCase();
}

// when the money came in, or when it's likely to
function moneyDate(i) {
  if (i.paidDate) {
    const d = i.paidLateDays;
    const t = d === null ? '' : d <= 0 ? (d < 0 ? `${-d}d early` : 'on time') : `${d}d late`;
    return `<span class="md paid">${fmtDate(i.paidDate)}</span><span class="md-s ${d > 0 ? 'late' : 'ok'}">${t}</span>`;
  }
  if (i.expected?.date && OPEN.includes(i.status))
    return `<span class="md exp" title="Likely ${fmtDate(i.expected.date)}; 8 in 10 times between ${fmtDate(i.expected.early)} and ${fmtDate(i.expected.late)}. ${i.expected.chance}% chance it's paid at all, based on ${i.expected.basedOn} past payment${i.expected.basedOn === 1 ? '' : 's'} from this client.">≈ ${fmtDate(i.expected.date)}</span><span class="md-s">${i.expected.early === i.expected.late ? 'likely' : `${fmtDate(i.expected.early)} – ${fmtDate(i.expected.late)}`}</span>`;
  return '<span class="muted">—</span>';
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
            <td>${moneyDate(i)}</td>
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
  const inv = data.invoices.find((x) => x.id === id) || data.invoices.find((x) => x.number === id);
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
  const tm = f.thisMonth;
  const bold = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/#(\d{3,})/g, '<a href="/?inv=$1" class="br-inv">#$1</a>');
  const delta = tm.changePct === null ? '' : tm.changePct === 0 ? '<span class="br-d">same as last month</span>' : `<span class="br-d ${tm.changePct > 0 ? 'up' : 'down'}">${tm.changePct > 0 ? '▲' : '▼'} ${Math.abs(tm.changePct)}% vs ${esc(tm.lastMonthLabel.split(' ')[0])}</span>`;
  const ai = b.ai
    ? `<div class="br-ai"><div class="br-ai-h"><span class="br-ai-tag">PayPilot's take</span>${b.ai.headline ? `<p>${bold(b.ai.headline)}</p>` : ''}</div>
        ${b.ai.actions.length ? `<ol class="br-acts">${b.ai.actions.map((a, i) => `<li><span>${i + 1}</span><div>${bold(a)}</div></li>`).join('')}</ol>` : ''}</div>`
    : `<div class="br-ai off"><span class="br-ai-tag">PayPilot's take</span><p class="muted" title="${esc(b.aiError || '')}">AI notes are unavailable right now${/key/i.test(b.aiError || '') ? ' (check the AI key in .env)' : ''}. Every number below is computed from your invoices and always up to date.</p></div>`;
  const maxTop = Math.max(...f.topCustomers.map((c) => c.share), 1);
  $('briefBody').innerHTML = `${ai}
    <div class="br-kpis">
      <div><span>Earned so far</span><b>${moneyMap(L.totalEarned, cur)}</b><em>${L.paidInvoices} paid invoices${L.since ? ` since ${esc(fmtDate(L.since))}` : ''}</em></div>
      <div><span>${esc(tm.label)}</span><b>${money(tm.earned, cur)}</b><em>${tm.paidInvoices} payment${tm.paidInvoices === 1 ? '' : 's'} ${delta}</em></div>
      <div><span>Expected in 30 days</span><b>${money(f.next30Days.expected, cur)}</b><em>of ${money(f.outstanding.total, cur)} still open · best case ${money(f.next30Days.bestCase, cur)}</em></div>
      <div><span>Overdue</span><b class="${f.overdue.total ? 'late-t' : ''}">${money(f.overdue.total, cur)}</b><em>${f.overdue.invoices ? `${f.overdue.invoices} invoice${f.overdue.invoices > 1 ? 's' : ''} past due` : 'nothing late'}</em></div>
    </div>
    <div class="br-cols">
      <div class="br-col"><h3>Top customers</h3>${f.topCustomers.length ? `<ul class="br-list">${f.topCustomers.map((c, i) => `<li><span class="br-rank">${i + 1}</span><div class="br-who"><b>${esc(c.client)}</b><span>${c.invoices} invoices · ${c.share}% of revenue</span><i style="width:${(c.share / maxTop) * 100}%"></i></div><span class="br-amt">${money(c.totalPaid, c.currency)}</span></li>`).join('')}</ul>` : '<p class="muted small">No payments yet.</p>'}</div>
      <div class="br-col"><h3>Late money</h3>${f.overdue.byCustomer.length ? `<ul class="br-list">${f.overdue.byCustomer.map((o) => `<li><span class="br-dot"></span><div class="br-who"><b>${esc(o.client)}</b><span>${o.invoices.map((x) => `<a href="/?inv=${esc(x)}" class="br-inv">#${esc(x)}</a>`).join(', ')} · ${o.maxDaysOverdue} day${o.maxDaysOverdue === 1 ? '' : 's'} late · ${o.remindersSent ? `${o.remindersSent} reminder${o.remindersSent === 1 ? '' : 's'} sent` : 'not reminded yet'}</span></div><span class="br-amt late-t">${money(o.amount, o.currency)}</span></li>`).join('')}</ul>` : '<p class="muted small">Nothing is overdue. Nice.</p>'}
        ${f.watchList.length ? `<h3 style="margin-top:18px">Clients to watch</h3><ul class="br-list">${f.watchList.map((w) => `<li><span class="pill ${w.risk}">${RISK_TEXT[w.risk]}</span><div class="br-who"><b>${esc(w.client)}</b><span>usually ${esc(daysLateText(w.avgDaysLate).toLowerCase())}</span></div>${w.outstanding ? `<span class="br-amt">${money(w.outstanding, cur)} owed</span>` : ''}</li>`).join('')}</ul>` : ''}
      </div>
    </div>`;
}

$('briefBody').addEventListener('click', (e) => {
  const a = e.target.closest('.br-inv');
  if (!a) return;
  e.preventDefault();
  showInvoice(new URL(a.href).searchParams.get('inv'));
});
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
    el.innerHTML = ''; // the top bar already says "Demo mode"
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
