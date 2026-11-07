import { api, header, esc, money, fmtDate, RISK_TEXT } from './common.js';

const cfg = await header('budget');
const $ = (id) => document.getElementById(id);
const cur = cfg.currency;
document.querySelectorAll('.cur').forEach((x) => (x.textContent = cur));
const m = (v) => money(Math.round(v), cur);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const pctText = (c) => (c >= 99.5 ? '>99%' : c < 0.5 ? '<1%' : `${Math.round(c)}%`);

// ---------------- inputs ----------------
$('date').min = cfg.today;
$('date').max = addDays(cfg.today, 365);
$('date').value = addDays(cfg.today, 30);
const params = new URLSearchParams(location.search);
if (params.get('price')) $('price').value = params.get('price');
if (params.get('date')) $('date').value = params.get('date');
if (params.get('item')) $('item').value = params.get('item');

$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.eom !== undefined) {
    const [y, mo] = cfg.today.split('-').map(Number);
    $('date').value = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  } else $('date').value = addDays(cfg.today, Number(b.dataset.days));
  markChip();
});
function markChip() {
  const [y, mo] = cfg.today.split('-').map(Number);
  const eom = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  document.querySelectorAll('#chips button').forEach((b) => {
    const v = b.dataset.eom !== undefined ? eom : addDays(cfg.today, Number(b.dataset.days));
    b.setAttribute('aria-pressed', String(v === $('date').value));
  });
}
$('date').addEventListener('change', markChip);
markChip();

const { profile, paypalBalance } = await api('/api/budget/profile?balance=1');
if (profile.cashNow) $('cash').value = profile.cashNow;
if (profile.monthlyCosts) $('costs').value = profile.monthlyCosts;
if (profile.buffer) $('buffer').value = profile.buffer;
if (paypalBalance !== null && paypalBalance !== undefined) {
  $('useBal').textContent = `Use PayPal balance (${money(paypalBalance, cur)})`;
  $('useBal').classList.remove('hidden');
  $('useBal').onclick = () => ($('cash').value = paypalBalance);
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = '';
  if (!(Number($('price').value) > 0)) return ($('err').textContent = 'Enter the price of what you want to buy.');
  $('go').disabled = true;
  $('go').textContent = 'Running 4,000 futures…';
  try {
    const r = await api('/api/budget/estimate', {
      body: { item: $('item').value, price: Number($('price').value), date: $('date').value, cashNow: Number($('cash').value) || 0, monthlyCosts: Number($('costs').value) || 0, buffer: Number($('buffer').value) || 0 },
    });
    render(r);
    history.replaceState(null, '', `?price=${r.price}&date=${r.date}${r.item ? `&item=${encodeURIComponent(r.item)}` : ''}`);
  } catch (err) {
    $('err').textContent = err.message;
  } finally {
    $('go').disabled = false;
    $('go').textContent = 'Estimate';
  }
});

// ---------------- result ----------------
let R = null;
let view = 'chance';

function gauge(chance, level) {
  // half circle, 0% left to 100% right
  const a = Math.PI * (1 - Math.min(100, Math.max(0, chance)) / 100);
  const x = 60 + 50 * Math.cos(a);
  const y = 60 - 50 * Math.sin(a);
  const large = 0;
  return `<svg viewBox="0 0 120 70" class="bg-gauge" role="img" aria-label="${Math.round(chance)}% chance">
    <path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke="#1f1f23" stroke-width="9" stroke-linecap="round"/>
    ${chance > 0.5 ? `<path d="M10 60 A50 50 0 ${large} 1 ${x.toFixed(2)} ${y.toFixed(2)}" fill="none" class="g-${level}" stroke-width="9" stroke-linecap="round"/>` : ''}
    <line x1="${(60 + 50 * Math.cos(Math.PI * 0.2)).toFixed(2)}" y1="${(60 - 50 * Math.sin(Math.PI * 0.2)).toFixed(2)}" x2="${(60 + 41 * Math.cos(Math.PI * 0.2)).toFixed(2)}" y2="${(60 - 41 * Math.sin(Math.PI * 0.2)).toFixed(2)}" stroke="#71717a" stroke-width="1.5"/>
    <text x="60" y="54" text-anchor="middle" class="g-num">${pctText(chance)}</text>
    <text x="60" y="68" text-anchor="middle" class="g-sub">chance</text>
  </svg>`;
}

function render(r) {
  R = r;
  const v = r.verdict;
  const tag = { yes: r.needed <= 0 ? 'Covered' : 'Likely', maybe: 'Uncertain', no: 'Unlikely' }[v.level];
  const shortNow = r.leftAfter.p50 < r.inputs.buffer;
  const target = fmtDate(r.date);
  const drivers = r.drivers.filter((d) => d.kind === 'invoice');
  const retainers = r.drivers.filter((d) => d.kind === 'retainer');
  $('result').innerHTML = `
    <div class="panel bg-verdict lvl-${v.level}">
      ${gauge(r.chance, v.level)}
      <div class="bg-v-text">
        <span class="bg-tag">${tag}${r.item ? ` · ${esc(r.item)}` : ''} · ${esc(m(r.price))} on ${esc(target)}</span>
        <h2>${esc(v.headline)}</h2>
        <p>${esc(v.detail)}</p>
      </div>
    </div>

    <div class="bg-stats">
      <div><span>Chance on ${esc(target)}</span><b>${pctText(r.chance)}</b><em>± ${r.margin} pts (95% sure)</em></div>
      <div><span>Must come in by then</span><b>${r.needed > 0 ? esc(m(r.needed)) : '—'}</b><em>price${r.costsUntil ? ` + ${esc(m(r.costsUntil))} costs` : ''}${r.inputs.buffer ? ` + buffer` : ''} − cash</em></div>
      <div><span>${shortNow ? 'Short by, typically' : 'Left after buying'}</span><b class="${shortNow ? 'bad-t' : ''}">${esc(m(shortNow ? r.shortfall.likely || r.inputs.buffer - r.leftAfter.p50 : r.leftAfter.p50))}</b><em>in the middle future (P50)</em></div>
      <div><span>Safe to buy from</span><b>${r.safeDates.p80 ? esc(fmtDate(r.safeDates.p80)) : 'Not in sight'}</b><em>${r.safeDates.p80 ? `80% chance · 95%: ${r.safeDates.p95 ? esc(fmtDate(r.safeDates.p95)) : 'later'}` : 'from money already owed'}</em></div>
    </div>

    <section class="panel">
      <div class="bg-chart-h">
        <div><h2>${view === 'chance' ? 'Chance you can buy it, by date' : 'Money left after buying, by date'}</h2><p class="muted small">${view === 'chance' ? 'Solid line: only money already invoiced. Dotted: if your regular clients keep sending work.' : 'Shaded: 8 in 10 futures fall here. Line: the middle one. Dashed: what you need to buy it and keep your buffer.'}</p></div>
        <div class="seg small-seg" role="group" aria-label="Chart" id="views"><button data-v="chance" aria-pressed="${view === 'chance'}">Chance</button><button data-v="money" aria-pressed="${view === 'money'}">Money range</button></div>
      </div>
      <div class="an-chart bg-chart" id="chart"></div>
    </section>

    <div class="bg-two">
      <section class="panel">
        <h2>On ${esc(target)}, after buying</h2>
        <p class="muted small" style="margin:-6px 0 16px">How much you'd have left, across all ${r.model.simulations.toLocaleString('en-US')} futures.</p>
        ${rangeBar(r)}
        <dl class="bg-facts">
          <div><dt>Bad month (1 in 10)</dt><dd class="${r.leftAfter.p10 < r.inputs.buffer ? 'bad-t' : ''}">${esc(m(r.leftAfter.p10))}</dd></div>
          <div><dt>Typical</dt><dd>${esc(m(r.leftAfter.p50))}</dd></div>
          <div><dt>Good month (9 in 10)</dt><dd>${esc(m(r.leftAfter.p90))}</dd></div>
          <div><dt>When it falls short</dt><dd>${r.shortfall.ifShort ? `${esc(m(r.shortfall.ifShort))} short on average<span class="muted small"> · ${pctText(100 - r.chance)} of futures</span>` : 'It never does'}</dd></div>
        </dl>
      </section>
      <section class="panel">
        <h2>If your regular clients keep sending work</h2>
        <p class="muted small" style="margin:-6px 0 14px">Not counted above. Based on how often each repeat client has hired you in the last 6 months.</p>
        <div class="bg-nw"><b>${pctText(r.chanceWithNewWork)}</b><span>chance on ${esc(target)}${r.safeDatesWithNewWork.p80 ? ` · 80% from ${esc(fmtDate(r.safeDatesWithNewWork.p80))}` : ''}</span></div>
        ${r.newWorkClients.length ? `<ul class="bg-nwl">${r.newWorkClients.map((c) => `<li><span>${esc(c.client)}</span><em>about ${c.perMonth} job${c.perMonth === 1 ? '' : 's'} a month</em></li>`).join('')}</ul>` : '<p class="muted small">No repeat clients outside retainers yet.</p>'}
      </section>
    </div>

    <section class="panel" style="padding:0!important">
      <div class="sec-pad"><div><h2>What decides it</h2><p class="muted small" style="margin:2px 0 0">Each unpaid invoice, how likely it reaches you by ${esc(target)}, and how much the answer depends on it.</p></div></div>
      ${drivers.length ? `<div class="table-wrap"><table class="data bg-table"><thead><tr><th>Invoice</th><th>Client</th><th class="r">Amount</th><th>Pays</th><th>Arrives by ${esc(target)}</th><th>Likely date</th><th class="r" title="How much the chance changes if this invoice arrives in time vs not">Swing</th></tr></thead><tbody>${drivers
        .map(
          (d) => `<tr><td><b>#${esc(d.number)}</b>${d.daysOverdue ? `<br><span class="bad-t small">${d.daysOverdue}d overdue</span>` : `<br><span class="muted small">due ${esc(fmtDate(d.dueDate))}</span>`}</td>
          <td>${esc(d.client)}<br><span class="muted small">${d.history} past payment${d.history === 1 ? '' : 's'} · ${d.chancePaidEver}% pays at all</span></td>
          <td class="r num">${esc(m(d.amount))}</td>
          <td><span class="pill ${d.risk}">${RISK_TEXT[d.risk] || d.risk}</span></td>
          <td><div class="bg-bar"><i style="width:${d.chanceByDate}%" class="${d.chanceByDate >= 80 ? 'ok' : d.chanceByDate >= 50 ? 'mid' : 'low'}"></i></div><span class="small">${d.chanceByDate}%</span></td>
          <td>${d.likelyDate ? `${esc(fmtDate(d.likelyDate))}<br><span class="muted small">${esc(fmtDate(d.earlyDate))} – ${esc(fmtDate(d.lateDate))}</span>` : '<span class="muted">—</span>'}</td>
          <td class="r">${d.impact === null ? '<span class="muted">—</span>' : `<b class="${d.impact >= 30 ? 'swing-hi' : ''}">${d.impact > 0 ? '+' : ''}${d.impact} pts</b>`}</td></tr>`
        )
        .join('')}</tbody></table></div>` : '<div class="list-empty"><b>Nothing unpaid</b><span>The answer only depends on your cash, costs and retainers.</span></div>'}
      ${retainers.length ? `<p class="muted small bg-ret">Also counted: ${retainers.length} retainer invoice${retainers.length === 1 ? '' : 's'} before ${esc(target)} (${retainers.map((d) => `${esc(d.client)} ${esc(m(d.amount))}, sent ${esc(fmtDate(d.issueDate))}`).join('; ')}).</p>` : ''}
    </section>

    <details class="panel bg-how">
      <summary><b>How this works</b><span class="muted small">Monte Carlo simulation, learned from ${r.model.paymentsLearnedFrom} of your past payments</span></summary>
      <ol>
        <li><b>Learn each client's habit.</b> For every paid invoice PayPilot knows how many days after the due date the money came. That list is each client's payment habit. Clients with only a few payments are blended with everyone's history (their own data counts for n / (n + ${r.model.priorWeight})), and each draw gets about ${r.model.smoothingDays} days of noise so the model doesn't only repeat the past exactly.</li>
        <li><b>Respect what already happened.</b> An unpaid invoice hasn't been paid yet, so only futures where it arrives today or later are kept. If a client is later than they've ever been, the extra wait follows an exponential curve fitted to their late payments.</li>
        <li><b>Allow for money that never comes.</b> Each invoice is paid at all with a probability that starts at 98% and rises with every invoice the client has paid. Once it's later than the client's slowest payment ever, that chance halves every ${r.model.halfLifeDays} days.</li>
        <li><b>Play out ${r.model.simulations.toLocaleString('en-US')} futures.</b> In each one, every invoice and retainer gets a pay date (or never pays). Your monthly costs are taken off day by day. A future counts as "yes" if, on the date, you can pay ${esc(m(r.price))} and still keep ${esc(m(r.inputs.buffer))}.</li>
        <li><b>Read the answer.</b> The chance is the share of "yes" futures (± ${r.margin} points of simulation error). The range comes from the 10th, 50th and 90th percentile futures. "Swing" compares futures where an invoice arrives in time with those where it doesn't.</li>
      </ol>
      ${r.model.lowData ? '<p class="bg-warn">There isn\'t much payment history yet, so this leans on general patterns more than on your clients. It gets sharper with every paid invoice.</p>' : ''}
      ${r.model.otherCurrencyLeftOut.length ? `<p class="muted small">Left out: invoices in other currencies (${r.model.otherCurrencyLeftOut.map((n) => `#${esc(n)}`).join(', ')}).</p>` : ''}
    </details>`;
  $('views').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    view = b.dataset.v;
    render(R);
  });
  drawChart();
}

function rangeBar(r) {
  const vals = [r.leftAfter.p10, r.leftAfter.p50, r.leftAfter.p90, r.inputs.buffer, 0];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 100;
  const x = (v) => ((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  return `<div class="bg-range">
    <div class="bg-range-track"></div>
    <div class="bg-range-band" style="left:${x(r.leftAfter.p10)}%;width:${Math.max(0.8, x(r.leftAfter.p90) - x(r.leftAfter.p10))}%"></div>
    <div class="bg-range-mid" style="left:${x(r.leftAfter.p50)}%"></div>
    <div class="bg-range-line" style="left:${x(r.inputs.buffer)}%"><span>${r.inputs.buffer ? `Buffer ${esc(m(r.inputs.buffer))}` : 'Zero'}</span></div>
  </div>`;
}

function drawChart() {
  const pts = R.timeline;
  const W = 1000, H = 260, L = 58, Rr = 14, T = 16, B = 32;
  const x = (i) => L + (i * (W - L - Rr)) / Math.max(1, pts.length - 1);
  const ti = pts.findIndex((p) => p.date >= R.date);
  let ymin = 0, ymax = 100, y;
  let body = '';
  if (view === 'chance') {
    y = (v) => T + (H - T - B) * (1 - v / 100);
    const line = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    const area = `${line('chance')} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
    for (const g of [0, 25, 50, 75, 100]) body += `<line x1="${L}" x2="${W - Rr}" y1="${y(g)}" y2="${y(g)}" stroke="rgba(255,255,255,${g ? 0.05 : 0.12})"/><text x="${L - 10}" y="${y(g) + 4}" text-anchor="end" font-size="11" fill="#71717a">${g}%</text>`;
    body += `<line x1="${L}" x2="${W - Rr}" y1="${y(80)}" y2="${y(80)}" stroke="#52525b" stroke-dasharray="4 5"/><text x="${W - Rr}" y="${y(80) - 6}" text-anchor="end" font-size="11" fill="#a1a1aa">80% safe line</text>`;
    body += `<defs><linearGradient id="bgA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fafafa" stop-opacity=".16"/><stop offset="1" stop-color="#fafafa" stop-opacity="0"/></linearGradient></defs>`;
    body += `<path d="${area}" fill="url(#bgA)"/><path d="${line('chanceNew')}" fill="none" stroke="#a78bfa" stroke-width="1.6" stroke-dasharray="2 4"/><path d="${line('chance')}" fill="none" stroke="#e4e4e7" stroke-width="2"/>`;
  } else {
    ymin = Math.min(...pts.map((p) => p.p10), 0, pts[0].line);
    ymax = Math.max(...pts.map((p) => p.p90), pts[0].line);
    const span = ymax - ymin || 1;
    ymin -= span * 0.06;
    ymax += span * 0.06;
    y = (v) => T + (H - T - B) * (1 - (v - ymin) / (ymax - ymin));
    const top = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.p90).toFixed(1)}`).join(' ');
    const bottom = pts.map((p, i) => `L${x(pts.length - 1 - i).toFixed(1)},${y(pts[pts.length - 1 - i].p10).toFixed(1)}`).join(' ');
    const mid = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.p50).toFixed(1)}`).join(' ');
    for (let g = 0; g <= 4; g++) {
      const v = ymin + ((ymax - ymin) * g) / 4;
      body += `<line x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.05)"/><text x="${L - 10}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#71717a">${Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v)}</text>`;
    }
    body += `<path d="${top} ${bottom} Z" fill="rgba(250,250,250,0.09)"/><path d="${mid}" fill="none" stroke="#e4e4e7" stroke-width="2"/>`;
    body += `<line x1="${L}" x2="${W - Rr}" y1="${y(pts[0].line)}" y2="${y(pts[0].line)}" stroke="#a78bfa" stroke-dasharray="4 5"/><text x="${W - Rr}" y="${y(pts[0].line) - 6}" text-anchor="end" font-size="11" fill="#c4b5fd">Needed: ${esc(m(pts[0].line))}</text>`;
  }
  if (ti >= 0) body += `<line x1="${x(ti)}" x2="${x(ti)}" y1="${T}" y2="${H - B}" stroke="#fafafa" stroke-width="1" stroke-dasharray="3 4" opacity=".55"/><text x="${x(ti) + 6}" y="${T + 10}" font-size="11" fill="#e4e4e7">${esc(fmtDate(R.date))}</text>`;
  const step = Math.ceil(pts.length / 7);
  body += pts.map((p, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#71717a">${esc(fmtDate(p.date))}</text>` : '')).join('');
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${view === 'chance' ? 'Chance over time' : 'Money range over time'}">${body}
      <line id="cx" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#fafafa" opacity="0"/><circle id="cd" r="4.5" fill="#09090b" stroke="#fafafa" stroke-width="2" opacity="0"/>
      <rect x="${L}" y="${T}" width="${W - L - Rr}" height="${H - T - B}" fill="transparent"/></svg><div class="an-tip hidden" id="tip"></div>`;
  const svg = $('chart').querySelector('svg');
  const tip = $('tip');
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((sx - L) / (W - L - Rr)) * (pts.length - 1))));
    const p = pts[i];
    const py = view === 'chance' ? y(p.chance) : y(p.p50);
    $('cx').setAttribute('x1', x(i)); $('cx').setAttribute('x2', x(i)); $('cx').setAttribute('opacity', '.35');
    $('cd').setAttribute('cx', x(i)); $('cd').setAttribute('cy', py); $('cd').setAttribute('opacity', '1');
    tip.innerHTML = view === 'chance'
      ? `<span class="muted">${esc(fmtDate(p.date))}</span><b>${pctText(p.chance)}</b><span class="muted">${pctText(p.chanceNew)} with new work</span>`
      : `<span class="muted">${esc(fmtDate(p.date))}</span><b>${esc(m(p.p50))}</b><span class="muted">${esc(m(p.p10))} to ${esc(m(p.p90))}</span>`;
    tip.classList.remove('hidden');
    const left = (x(i) / W) * r.width;
    tip.style.left = `${Math.min(r.width - 170, Math.max(0, left + 12))}px`;
    tip.style.top = `${Math.max(0, (py / H) * r.height - 34)}px`;
  });
  svg.addEventListener('mouseleave', () => {
    tip.classList.add('hidden');
    $('cx').setAttribute('opacity', '0');
    $('cd').setAttribute('opacity', '0');
  });
}

if (params.get('price')) $('form').requestSubmit();
