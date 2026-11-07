import { api, header, esc, money, fmtDate } from './common.js';

const $ = (id) => document.getElementById(id);
await header('analytics');

let months = 6;
let series = 'received';
let A = null;
const m = (v) => money(v, A.currency);

function delta(change, { unit = '%', lowerIsBetter = false } = {}) {
  if (change === null || change === undefined) return '';
  if (change === 0) return '<span class="dl flat">● no change</span>';
  const good = lowerIsBetter ? change < 0 : change > 0;
  return `<span class="dl ${good ? 'up' : 'down'}">${change > 0 ? '▲' : '▼'} ${Math.abs(change)}${unit}</span>`;
}

function renderSummary() {
  const k = A.kpis, st = A.stability;
  const late = A.overdueTotal;
  const health = (() => {
    const ot = k.onTimeRate.value ?? 0;
    const lateShare = k.outstanding.value ? late / Math.max(1, st.perMonth || k.outstanding.value) : 0;
    if (ot >= 75 && lateShare < 0.25) return ['good', 'Healthy', 'Most clients pay on time and little money is late.'];
    if (ot >= 45 && lateShare < 0.6) return ['fair', 'Fair', 'Money comes in, but late payers slow you down.'];
    return ['poor', 'Needs attention', 'Too much of your money arrives late or is still owed.'];
  })();
  const perMonth = A.months ? k.revenue.value / A.months : 0;
  $('summary').innerHTML = `
    <div class="an-sum-h"><span class="an-health ${health[0]}"><i></i>${health[1]}</span><span class="muted small">${esc(health[2])}</span></div>
    <p class="an-sum-p">In the last ${A.months} months you received <b>${esc(m(k.revenue.value))}</b> from ${A.paidCount} payment${A.paidCount === 1 ? '' : 's'}, about <b>${esc(m(Math.round(perMonth)))} a month</b>.
      ${k.avgDaysToPay.value !== null ? `Clients took <b>${k.avgDaysToPay.value} days</b> on average from invoice to payment, and <b>${A.onTimeCount} of ${A.paidCount}</b> paid by the due date.` : ''}
      ${k.outstanding.value ? `Right now <b>${esc(m(k.outstanding.value))}</b> is still owed${late ? `, <b class="bad-t">${esc(m(late))}</b> of it late` : ', none of it late'}.` : 'Nothing is owed to you right now.'}
      ${A.topClient && A.topClient.share >= 30 ? `${esc(A.topClient.name)} alone is ${A.topClient.share}% of your income.` : ''}</p>`;
}

function renderKpis() {
  const k = A.kpis, st = A.stability;
  const card = (label, value, d, sub, help) => `<div class="cs kpi" ${help ? `title="${esc(help)}"` : ''}><div class="kpi-top"><span class="cs-l">${label}</span>${d}</div><b class="cs-v">${value}</b><span class="cs-s">${sub}</span></div>`;
  const vsPrev = (txt) => (A.hasPrev ? txt : 'first period with data');
  $('kpis').innerHTML =
    card('Received', m(k.revenue.value), delta(k.revenue.change), vsPrev(`vs ${m(k.revenue.prev)} the ${A.months} months before`), 'Money that actually reached you in this period.') +
    card('Days to get paid', k.avgDaysToPay.value !== null ? `${k.avgDaysToPay.value} days` : '—', delta(k.avgDaysToPay.change, { unit: 'd', lowerIsBetter: true }), 'from sending an invoice to the money arriving', 'Average time between the invoice date and the payment date. Lower is better.') +
    card('Paid on time', k.onTimeRate.value !== null ? `${k.onTimeRate.value}%` : '—', delta(k.onTimeRate.change, { unit: ' pts' }), `${A.onTimeCount} of ${A.paidCount} invoices paid by the due date`, 'Share of paid invoices that arrived on or before their due date.') +
    card('Average invoice', k.avgInvoice.value !== null ? m(k.avgInvoice.value) : '—', delta(k.avgInvoice.change), `${k.invoiced.count} invoices sent · ${m(k.invoiced.value)} billed`, 'Billed amount divided by invoices sent in this period.') +
    card('Still owed', m(k.outstanding.value), '', A.overdueTotal ? `<span class="bad-t">${esc(m(A.overdueTotal))} of it late</span> · ${k.outstanding.count} invoices` : `${k.outstanding.count} unpaid invoice${k.outstanding.count === 1 ? '' : 's'}, none late`, 'Every unpaid invoice, due or not.') +
    card('Expected in 30 days', m(k.expected30.value), '', "weighted by how each client usually pays", 'Each unpaid invoice counted by the chance it arrives within 30 days, based on that client.') +
    card('Steady income', st.recurringShare ? `${st.recurringShare}%` : '0%', '', st.recurringShare ? 'of income comes from retainers' : 'no retainers yet · <a href="/clients#offers">see suggestions</a>', 'Share of income from clients on a monthly plan.') +
    card('Repeat clients', `${k.repeatClients.value}<small> / ${k.repeatClients.of}</small>`, '', 'clients billed two or more times', 'Clients you billed at least twice in this period.');
}

// ---------------- trend chart (area + hover crosshair) ----------------
let view = 'month';
function renderMonthly() {
  const ms = A.monthly;
  const total = ms.reduce((t, x) => t + x.received, 0);
  $('trendLabel').textContent = 'Money received each month';
  $('trendTotal').innerHTML = `${esc(m(total))} <span class="muted small">received · ${esc(m(ms.reduce((t, x) => t + x.invoiced, 0)))} invoiced</span>`;
  $('legend').innerHTML = '<span><i class="lg-r"></i>Received</span><span><i class="lg-i"></i>Invoiced</span><span class="muted">This month is still in progress</span>';
  const W = 1000, H = 280, L = 52, R = 12, T = 26, B = 34;
  const max = Math.max(100, ...ms.map((x) => Math.max(x.received, x.invoiced)));
  const nice = (() => { const s = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / s) * s; })();
  const y = (v) => T + (H - T - B) * (1 - v / nice);
  const slot = (W - L - R) / ms.length;
  const bw = Math.min(34, slot * 0.3);
  let g = '';
  for (let k = 0; k <= 4; k++) {
    const v = (nice * k) / 4;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,${k ? 0.06 : 0.12})"/><text x="${L - 10}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#71717a">${v >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v)}</text>`;
  }
  const bars = ms.map((x, i) => {
    const cx = L + slot * i + slot / 2;
    const r = `<rect x="${cx - bw - 2}" y="${y(x.received)}" width="${bw}" height="${Math.max(0, H - B - y(x.received))}" rx="4" fill="${x.partial ? 'url(#hatch)' : '#e4e4e7'}"/>`;
    const inv = `<rect x="${cx + 2}" y="${y(x.invoiced)}" width="${bw}" height="${Math.max(0, H - B - y(x.invoiced))}" rx="4" fill="#3f3f46"/>`;
    const lab = x.received ? `<text x="${cx - bw / 2 - 2}" y="${y(x.received) - 7}" text-anchor="middle" font-size="11" fill="#d4d4d8">${x.received >= 1000 ? `${Math.round(x.received / 100) / 10}k` : Math.round(x.received)}</text>` : '';
    return `${r}${inv}${lab}<text x="${cx}" y="${H - 12}" text-anchor="middle" font-size="12" fill="${x.partial ? '#a1a1aa' : '#71717a'}">${esc(x.label)}${x.partial ? ' (so far)' : ''}</text><rect x="${cx - slot / 2}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent" data-i="${i}"/>`;
  }).join('');
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Money received and invoiced per month"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#a1a1aa"/><line x1="0" y1="0" x2="0" y2="6" stroke="#71717a" stroke-width="3"/></pattern></defs>${g}${bars}</svg><div class="an-tip hidden" id="tip"></div>`;
  const svg = $('chart').querySelector('svg');
  svg.addEventListener('mousemove', (ev) => {
    const t = ev.target.closest('[data-i]');
    const tip = $('tip');
    if (!t) return tip.classList.add('hidden');
    const x = ms[Number(t.dataset.i)];
    tip.innerHTML = `<span class="muted">${esc(x.label)} ${x.year}${x.partial ? ' · so far' : ''}</span><b>${esc(m(x.received))} received</b><span class="muted">${x.payments} payment${x.payments === 1 ? '' : 's'} · ${esc(m(x.invoiced))} invoiced</span>`;
    tip.classList.remove('hidden');
    const r = svg.getBoundingClientRect();
    tip.style.left = `${Math.min(r.width - 190, Math.max(0, ev.clientX - r.left + 14))}px`;
    tip.style.top = `${Math.max(0, ev.clientY - r.top - 40)}px`;
  });
  svg.addEventListener('mouseleave', () => $('tip').classList.add('hidden'));
}

function renderChart() {
  $('series').classList.toggle('hidden', view !== 'week');
  if (view === 'month') return renderMonthly();
  $('trendLabel').textContent = series === 'received' ? 'Money received each week' : 'Amount invoiced each week';
  $('legend').innerHTML = '';
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
  const onTime = A.timing.find((b) => b.key === 'early').count;
  const col = { early: 'var(--paid)', late7: '#fbbf24', late30: '#fb923c', late30p: '#f87171' };
  $('timing').innerHTML = `<div class="stack-bar">${A.timing.map((b) => (b.count ? `<span style="width:${(b.count / total) * 100}%;background:${col[b.key]}" title="${esc(b.label)}: ${b.count}"></span>` : '')).join('')}</div>
    <ul class="dist">${A.timing.map((b) => `<li><i style="background:${col[b.key]}"></i><span>${esc(b.label)}</span><b>${b.count}</b><em>${Math.round((b.count / total) * 100)}%</em></li>`).join('')}</ul>
    <p class="muted small" style="margin:12px 0 0">${A.paidCount ? `${Math.round((onTime / total) * 100)}% of payments arrived by the due date.${A.timing.find((b) => b.key === 'late30').count + A.timing.find((b) => b.key === 'late30p').count ? ' Payments more than a week late usually come from the same one or two clients.' : ''}` : ''}</p>`;
  const maxA = Math.max(1, ...A.aging.map((a) => a.amount));
  const colA = { current: 'var(--paid)', a30: '#fbbf24', a60: '#fb923c', a60p: '#f87171' };
  $('aging').innerHTML = `<ul class="hbars">${A.aging
    .map((a) => `<li><span>${esc(a.label)}</span><div><i style="width:${(a.amount / maxA) * 100}%;background:${colA[a.key]}"></i></div><b>${esc(m(a.amount))}</b><em>${a.count} inv.</em></li>`)
    .join('')}</ul>
    <p class="muted small" style="margin:12px 0 0">${A.overdueTotal ? `${esc(m(A.overdueTotal))} is past due. <a href="/followups">Open Collections</a>` : 'Nothing is past due.'}</p>`;
  $('insights').innerHTML = A.insights.length
    ? A.insights.map((t) => `<li class="${t.tone}"><i></i><span>${esc(t.text)}</span>${t.link ? `<a href="${esc(t.link.href)}">${esc(t.link.label)} →</a>` : ''}</li>`).join('')
    : '<li class="muted">Notes appear once you have a few paid invoices.</li>';
  const st = A.stability;
  $('steady').innerHTML = st.months
    ? `<div class="an-steady"><div><span>Average month</span><b>${esc(m(st.perMonth))}</b></div><div><span>Swing</span><b>${st.swingPct === null ? '—' : `±${st.swingPct}%`}</b></div></div>
       <ul class="hbars">${st.low ? `<li><span>Lowest, ${esc(st.low.label.split(' ')[0])}</span><div><i style="width:${st.high?.amount ? (st.low.amount / st.high.amount) * 100 : 0}%;background:#71717a"></i></div><b>${esc(m(st.low.amount))}</b><em></em></li>` : ''}${st.high ? `<li><span>Highest, ${esc(st.high.label.split(' ')[0])}</span><div><i style="width:100%;background:#e4e4e7"></i></div><b>${esc(m(st.high.amount))}</b><em></em></li>` : ''}</ul>
       <p class="muted small" style="margin:12px 0 0">${st.swingPct === null ? '' : st.swingPct < 25 ? 'Your income is fairly steady month to month.' : st.swingPct < 50 ? 'Some months are much better than others. Keep about one month of costs as a cushion.' : 'Income swings a lot. Plan with your lowest month, not your average, and consider retainers.'}${st.recurringShare ? ` ${st.recurringShare}% comes from retainers.` : ''}</p>`
    : '<p class="muted small">Needs at least one full month of payments.</p>';
}

function spark(vals) {
  const max = Math.max(1, ...vals);
  const w = 80, h = 24;
  const pts = vals.map((v, i) => `${(i * w) / Math.max(1, vals.length - 1)},${h - 2 - (v / max) * (h - 4)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="#a1a1aa" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

function renderClients() {
  $('clients').innerHTML = A.clients.length
    ? `<table class="data an-table"><thead><tr><th>Client</th><th class="r">Revenue</th><th>Share</th>${A.hasPrev ? '<th class="r">Change</th>' : ''}<th class="r">Invoices</th><th class="r">On time</th><th class="r">Usually</th><th class="r">Owed</th><th>Trend</th></tr></thead><tbody>${A.clients
        .map(
          (c) => `<tr>
          <td><b>${esc(c.name)}</b>${c.company || c.role ? `<br><span class="muted small">${esc([c.role, c.company].filter(Boolean).join(', '))}</span>` : ''}</td>
          <td class="r num"><b>${esc(m(c.revenue))}</b></td>
          <td><div class="share-bar"><i style="width:${c.share}%"></i></div><span class="muted small">${c.share}%</span></td>
          ${A.hasPrev ? `<td class="r">${c.change === null ? (c.prevRevenue ? '' : '<span class="dl none">new</span>') : delta(c.change)}</td>` : ''}
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
  renderSummary();
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
$('view').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  view = b.dataset.v;
  document.querySelectorAll('#view button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderChart();
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
