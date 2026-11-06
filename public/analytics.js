import { api, header, esc, money, fmtDate } from './common.js';

const $ = (id) => document.getElementById(id);
await header('analytics');

let months = 6;
let series = 'received';
let A = null;
const m = (v) => money(v, A.currency);

function delta(change, { unit = '%', lowerIsBetter = false } = {}) {
  if (change === null || change === undefined) return '<span class="dl none">no earlier data</span>';
  if (change === 0) return '<span class="dl flat">● no change</span>';
  const good = lowerIsBetter ? change < 0 : change > 0;
  return `<span class="dl ${good ? 'up' : 'down'}">${change > 0 ? '▲' : '▼'} ${Math.abs(change)}${unit}</span>`;
}

function renderKpis() {
  const k = A.kpis;
  const card = (label, value, d, sub) => `<div class="cs kpi"><div class="kpi-top"><span class="cs-l">${label}</span>${d}</div><b class="cs-v">${value}</b><span class="cs-s">${sub}</span></div>`;
  $('kpis').innerHTML =
    card('Revenue', m(k.revenue.value), delta(k.revenue.change), `vs ${m(k.revenue.prev)} the ${months} months before`) +
    card('Days to get paid', k.avgDaysToPay.value !== null ? `${k.avgDaysToPay.value}d` : '—', delta(k.avgDaysToPay.change, { unit: 'd', lowerIsBetter: true }), 'from invoice to money, on average') +
    card('Paid on time', k.onTimeRate.value !== null ? `${k.onTimeRate.value}%` : '—', delta(k.onTimeRate.change, { unit: ' pts' }), 'of invoices paid by the due date') +
    card('Average invoice', k.avgInvoice.value !== null ? m(k.avgInvoice.value) : '—', delta(k.avgInvoice.change), `${k.invoiced.count} invoices · ${m(k.invoiced.value)} billed`) +
    card('Still owed', m(k.outstanding.value), '', `${k.outstanding.count} unpaid invoice${k.outstanding.count === 1 ? '' : 's'}`) +
    card('Expected in 30 days', m(k.expected30.value), '', "weighted by each client's habits") +
    card('Repeat clients', `${k.repeatClients.value}<small> / ${k.repeatClients.of}</small>`, '', 'billed two or more times') +
    card('Period', `${months} months`, '', `${fmtDate(A.from)} – ${fmtDate(A.to)}`);
}

// ---------------- trend chart (area + hover crosshair) ----------------
function renderChart() {
  const pts = A.weeks.map((w) => ({ x: w.end, v: w[series] }));
  const total = pts.reduce((t, p) => t + p.v, 0);
  $('trendTotal').innerHTML = `${esc(m(total))} <span class="muted small">${series === 'received' ? 'received' : 'invoiced'} in ${months} months</span>`;
  const W = 1000, H = 280, L = 52, R = 12, T = 18, B = 34;
  const max = Math.max(100, ...pts.map((p) => p.v));
  const nice = (() => { const s = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / s) * s; })();
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, pts.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / nice);
  // smooth line (monotone-ish cubic)
  let d = `M${x(0)},${y(pts[0].v)}`;
  for (let i = 1; i < pts.length; i++) {
    const cx = (x(i - 1) + x(i)) / 2;
    d += ` C${cx},${y(pts[i - 1].v)} ${cx},${y(pts[i].v)} ${x(i)},${y(pts[i].v)}`;
  }
  const area = `${d} L${x(pts.length - 1)},${H - B} L${x(0)},${H - B} Z`;
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const v = (nice * g) / 4;
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,${g ? 0.06 : 0.12})"/><text x="${L - 10}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#71717a">${v >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v)}</text>`;
  }
  const step = Math.ceil(pts.length / 6);
  const labels = pts.map((p, i) => (i % step === 0 || i === pts.length - 1 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#71717a">${esc(fmtDate(p.x))}</text>` : '')).join('');
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Revenue per week">
      <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fafafa" stop-opacity=".22"/><stop offset="1" stop-color="#fafafa" stop-opacity="0"/></linearGradient></defs>
      ${grid}<path d="${area}" fill="url(#ag)"/><path d="${d}" fill="none" stroke="#e4e4e7" stroke-width="2"/>${labels}
      <line id="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#fafafa" stroke-width="1" opacity="0"/>
      <circle id="crossDot" r="5" fill="#09090b" stroke="#fafafa" stroke-width="2" opacity="0"/>
      <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="hit"/>
    </svg><div class="an-tip hidden" id="tip"></div><div class="an-xpill hidden" id="xpill"></div>`;
  const svg = $('chart').querySelector('svg');
  const tip = $('tip'), xp = $('xpill');
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((sx - L) / (W - L - R)) * (pts.length - 1))));
    const px = x(i), py = y(pts[i].v);
    $('cross').setAttribute('x1', px); $('cross').setAttribute('x2', px); $('cross').setAttribute('opacity', '.5');
    $('crossDot').setAttribute('cx', px); $('crossDot').setAttribute('cy', py); $('crossDot').setAttribute('opacity', '1');
    const w = A.weeks[i];
    tip.innerHTML = `<span class="muted">${esc(fmtDate(w.start))} – ${esc(fmtDate(w.end))}</span><b>${esc(m(w[series]))}</b><span class="muted">${series === 'received' ? `${esc(m(w.invoiced))} invoiced` : `${esc(m(w.received))} received`}</span>`;
    tip.classList.remove('hidden');
    const left = (px / W) * r.width;
    tip.style.left = `${Math.min(r.width - 170, Math.max(0, left + 12))}px`;
    tip.style.top = `${(py / H) * r.height - 30}px`;
    xp.textContent = fmtDate(w.end);
    xp.classList.remove('hidden');
    xp.style.left = `${left}px`;
  };
  const leave = () => { tip.classList.add('hidden'); xp.classList.add('hidden'); $('cross').setAttribute('opacity', '0'); $('crossDot').setAttribute('opacity', '0'); };
  $('hit').addEventListener('mousemove', move);
  $('hit').addEventListener('mouseleave', leave);
  $('hit').addEventListener('touchmove', (e) => move(e.touches[0]), { passive: true });
}

// ---------------- distributions ----------------
function renderTiming() {
  const total = A.timing.reduce((t, b) => t + b.count, 0) || 1;
  const col = { early: 'var(--paid)', late7: '#fbbf24', late30: '#fb923c', late30p: '#f87171' };
  $('timing').innerHTML = `<div class="stack-bar">${A.timing.map((b) => (b.count ? `<span style="width:${(b.count / total) * 100}%;background:${col[b.key]}" title="${esc(b.label)}: ${b.count}"></span>` : '')).join('')}</div>
    <ul class="dist">${A.timing.map((b) => `<li><i style="background:${col[b.key]}"></i><span>${esc(b.label)}</span><b>${b.count}</b><em>${Math.round((b.count / total) * 100)}%</em></li>`).join('')}</ul>`;
  const maxA = Math.max(1, ...A.aging.map((a) => a.amount));
  const colA = { current: 'var(--paid)', a30: '#fbbf24', a60: '#fb923c', a60p: '#f87171' };
  $('aging').innerHTML = `<ul class="hbars">${A.aging
    .map((a) => `<li><span>${esc(a.label)}</span><div><i style="width:${(a.amount / maxA) * 100}%;background:${colA[a.key]}"></i></div><b>${esc(m(a.amount))}</b><em>${a.count}</em></li>`)
    .join('')}</ul>`;
  $('insights').innerHTML = A.insights.length ? A.insights.map((t) => `<li>${esc(t)}</li>`).join('') : '<li class="muted">Insights appear once you have a few paid invoices.</li>';
}

function spark(vals) {
  const max = Math.max(1, ...vals);
  const w = 80, h = 24;
  const pts = vals.map((v, i) => `${(i * w) / Math.max(1, vals.length - 1)},${h - 2 - (v / max) * (h - 4)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="#a1a1aa" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

function renderClients() {
  $('clients').innerHTML = A.clients.length
    ? `<table class="data an-table"><thead><tr><th>Client</th><th class="r">Revenue</th><th>Share</th><th class="r">Change</th><th class="r">Invoices</th><th class="r">On time</th><th class="r">Usually</th><th class="r">Owed</th><th>Trend</th></tr></thead><tbody>${A.clients
        .map(
          (c) => `<tr>
          <td><b>${esc(c.name)}</b>${c.company ? `<br><span class="muted small">${esc(c.company)}</span>` : ''}</td>
          <td class="r num"><b>${esc(m(c.revenue))}</b></td>
          <td><div class="share-bar"><i style="width:${c.share}%"></i></div><span class="muted small">${c.share}%</span></td>
          <td class="r">${delta(c.change)}</td>
          <td class="r num">${c.invoices}</td>
          <td class="r num">${c.onTimeRate !== null ? `${c.onTimeRate}%` : '—'}</td>
          <td class="r">${c.avgDaysLate === null ? '—' : c.avgDaysLate === 0 ? '<span class="ok-t">on time</span>' : `<span class="${c.avgDaysLate >= 7 ? 'bad-t' : 'warn-t'}">${c.avgDaysLate}d late</span>`}</td>
          <td class="r num">${c.outstanding ? `<span class="${c.overdue ? 'bad-t' : ''}">${esc(m(c.outstanding))}</span>` : '—'}</td>
          <td>${spark(c.monthly)}</td></tr>`
        )
        .join('')}</tbody></table>`
    : '<div class="empty">No client activity in this period.</div>';
  const maxS = Math.max(1, ...A.services.map((s) => s.amount));
  $('services').innerHTML = A.services.length
    ? `<ul class="hbars svc">${A.services.map((s) => `<li><span>${esc(s.name)}</span><div><i style="width:${(s.amount / maxS) * 100}%"></i></div><b>${esc(m(s.amount))}</b><em>${s.count}×</em></li>`).join('')}</ul>`
    : '<div class="muted small">Nothing billed in this period.</div>';
}

async function load() {
  A = await api(`/api/analytics?months=${months}`);
  $('anSub').textContent = `${fmtDate(A.from)} – ${fmtDate(A.to)} · amounts in ${A.currency}${A.otherCurrency ? ` (${A.otherCurrency} invoice${A.otherCurrency > 1 ? 's' : ''} in other currencies not included)` : ''}`;
  renderKpis();
  renderChart();
  renderTiming();
  renderClients();
}

$('period').addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]');
  if (!b) return;
  months = Number(b.dataset.m);
  document.querySelectorAll('#period button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  load();
});
$('series').addEventListener('click', (e) => {
  const b = e.target.closest('[data-s]');
  if (!b) return;
  series = b.dataset.s;
  document.querySelectorAll('#series button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderChart();
});
window.addEventListener('pp:changed', load);
await load();
