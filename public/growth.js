import { api, header, esc, money, fmtDate, toast } from './common.js';

const $ = (id) => document.getElementById(id);
await header('growth');

let G = null;
const m = (v) => money(Math.round(v), G.currency);
const initials = (n) => String(n).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const days = (n) => (n === null || n === undefined ? '—' : `${n} day${n === 1 ? '' : 's'}`);

const TREND = {
  growing: (t) => ['up', `Up ${t.pct}%`],
  shrinking: (t) => ['down', `Down ${Math.abs(t.pct)}%`],
  steady: (t) => ['flat', t.pct ? `Steady (${t.pct > 0 ? '+' : ''}${t.pct}%)` : 'Steady'],
  new: () => ['new', 'New lately'],
  stopped: () => ['down', 'None lately'],
  quiet: () => ['flat', 'Quiet'],
  recurring: () => ['plan', 'On a plan'],
};
const trend = (t) => {
  const [cls, txt] = (TREND[t.label] || TREND.quiet)(t);
  return `<span class="gr-trend ${cls}">${esc(txt)}</span>`;
};
const VERDICT = { focus: 'Focus here', rising: 'Rising', steady: 'Steady', cooling: 'Cooling', slow: 'Slow to pay' };
const SEG_CLASS = { champion: 'good', loyal: 'calm', fix: 'warn', slipping: 'warn', new: 'calm', oneoff: 'calm', lost: 'mute' };

function renderKpis() {
  const c = G.concentration, d = G.dso;
  const slipping = G.segments.find((s) => s.key === 'slipping');
  const champs = G.segments.find((s) => s.key === 'champion');
  const card = (label, value, sub, help) => `<div class="cs kpi" title="${esc(help)}"><div class="kpi-top"><span class="cs-l">${label}</span></div><b class="cs-v">${value}</b><span class="cs-s">${sub}</span></div>`;
  const dsoSub = d.now === null ? 'not enough billing in the last 90 days' :
    `${d.change === null ? '' : d.change > 0 ? `<span class="bad-t">${d.change} days slower</span> than 90 days ago · ` : d.change < 0 ? `<span class="good-t">${-d.change} days faster</span> than 90 days ago · ` : 'same as 90 days ago · '}your terms are ${d.terms} days`;
  const concLabel = { spread: 'Spread out', moderate: 'Moderate', concentrated: 'Concentrated' }[c.label];
  $('kpis').innerHTML =
    card('Billed in 12 months', m(G.yearBilled), `${m(G.yearRevenue)} of it already received`, 'Every invoice issued in the last 365 days, paid or not.') +
    card('Days sales outstanding', d.now === null ? '—' : days(d.now), dsoSub, 'Money owed to you, divided by what you billed in the last 90 days, times 90. Roughly: how many days of work you are waiting to be paid for.') +
    card('Income concentration', concLabel, c.topClient ? `${esc(c.topClient.name)} is ${c.topClient.share}% · top 3 are ${c.top3Share}%` : 'no billing yet', `Herfindahl index ${c.hhi} (under 1,500 spread out, over 2,500 concentrated). High means a single lost client hurts a lot.`) +
    card(slipping ? 'Slipping away' : 'Champions', slipping ? `${slipping.count} client${slipping.count === 1 ? '' : 's'}` : `${champs ? champs.count : 0}`, slipping ? `${m(slipping.value)} billed by them last year` : 'high value, frequent, on time', slipping ? 'Clients past the point they usually send more work.' : 'Your most valuable, most reliable clients.');
}

function renderOpps() {
  if (!G.opportunities.length) {
    $('opps').innerHTML = '<p class="muted small">Nothing stands out yet. Opportunities appear once you have a few months of invoices.</p>';
    return;
  }
  $('opps').innerHTML = G.opportunities.map((o, k) => `
    <article class="gr-opp">
      <div class="gr-opp-n">${String(k + 1).padStart(2, '0')}</div>
      <h3>${esc(o.title)}</h3>
      <p>${esc(o.body)}</p>
      ${o.amount ? `<div class="gr-opp-amt"><b>${esc(m(o.amount))}</b> <span>${esc(o.amountLabel || '')}</span></div>` : ''}
      <div class="gr-opp-f"><span>Based on ${esc(o.basis)}</span>${o.link ? `<a href="${esc(o.link.href)}">${esc(o.link.label)}</a>` : ''}</div>
    </article>`).join('');
}

function renderIndustries() {
  const rows = G.industries;
  if (!rows.length) { $('industries').innerHTML = '<p class="muted small">No clients yet.</p>'; return; }
  const max = Math.max(1, ...rows.map((r) => r.billed));
  $('industries').innerHTML = `<table class="data gr-table">
    <thead><tr><th>Industry</th><th>Clients</th><th>Billed, 12 months</th><th class="r">Per client</th><th class="r">Paid on time</th><th class="r">Days to pay</th><th>Trend</th><th>Score</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r.verdict === 'focus' ? 'gr-focus' : ''}">
      <td><b>${esc(r.name)}</b>${r.name === 'Not set' ? '<br><span class="muted small">set it in the table below</span>' : ''}</td>
      <td><span class="muted small">${r.clients} · ${esc(r.clientNames.join(', '))}</span></td>
      <td><div class="gr-bar"><i style="width:${Math.max(2, (r.billed / max) * 100)}%"></i></div><span class="num">${esc(m(r.billed))}</span> <span class="muted small">${r.share}% of billing</span></td>
      <td class="r">${esc(m(r.perClient))}</td>
      <td class="r">${r.onTime === null ? '—' : `${r.onTime}%`}</td>
      <td class="r">${r.daysToPay === null ? '—' : r.daysToPay}</td>
      <td>${trend(r.trend)}</td>
      <td><div class="gr-score" title="Score ${r.score} of 100"><i style="width:${r.score}%"></i></div></td>
      <td><span class="gr-v ${r.verdict}">${VERDICT[r.verdict]}</span></td>
    </tr>`).join('')}</tbody></table>`;
}

function renderMap() {
  const cs = G.clients.filter((c) => c.avgLate !== null || c.value > 0);
  if (!cs.length) { $('map').innerHTML = '<p class="muted small">No paid invoices yet.</p>'; return; }
  const W = 560, H = 400, L = 54, R = 18, T = 16, B = 40;
  const xMax = Math.max(14, ...cs.map((c) => c.avgLate || 0)) * 1.15;
  const yMax = Math.max(100, ...cs.map((c) => c.value)) * 1.15;
  const x = (v) => L + 16 + ((v || 0) / xMax) * (W - L - R - 16);
  const y = (v) => T + (1 - v / yMax) * (H - T - B);
  const mid = G.medianValue;
  const terms = 7; // the same line the segments use for a slow payer
  const kfmt = (v) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v));
  let g = '';
  // quadrant lines: median value, and the usual payment terms
  g += `<line x1="${x(terms)}" x2="${x(terms)}" y1="${T}" y2="${H - B}" stroke="#3f3f46" stroke-dasharray="4 4"/><line x1="${L}" x2="${W - R}" y1="${y(mid)}" y2="${y(mid)}" stroke="#3f3f46" stroke-dasharray="4 4"/>`;
  g += `<text x="${L + 8}" y="${T + 14}" font-size="11" fill="#a1a1aa">Grow these</text><text x="${W - R - 8}" y="${T + 14}" font-size="11" fill="#a1a1aa" text-anchor="end">Fix the terms</text>`;
  g += `<text x="${L + 8}" y="${H - B - 8}" font-size="11" fill="#71717a">Nurture</text><text x="${W - R - 8}" y="${H - B - 8}" font-size="11" fill="#71717a" text-anchor="end">Rethink</text>`;
  for (let k = 0; k <= 3; k++) {
    const v = (yMax / 1.15) * (k / 3);
    g += `<text x="${L - 8}" y="${y(v) + 4}" font-size="10.5" fill="#71717a" text-anchor="end">${kfmt(v)}</text>`;
  }
  for (let k = 0; k <= 4; k++) {
    const v = Math.round(((xMax / 1.15) * k) / 4);
    if (k && v === Math.round(((xMax / 1.15) * (k - 1)) / 4)) continue;
    g += `<text x="${x(v)}" y="${H - B + 16}" font-size="10.5" fill="#71717a" text-anchor="middle">${v}d</text>`;
  }
  g += `<text x="${(L + W - R) / 2}" y="${H - 4}" font-size="11" fill="#a1a1aa" text-anchor="middle">Average days late, past each invoice's own due date · dashed line = 7 days</text>`;
  g += `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#27272a"/>`;
  const dots = cs.map((c, i) => {
    const cx = x(c.avgLate), cy = y(c.value);
    const fill = { grow: '#e4e4e7', fix_terms: '#fbbf24', nurture: '#a1a1aa', rethink: '#fb7185' }[c.quadrant];
    const r = 6 + Math.min(8, Math.sqrt(c.invoicesYear || 1) * 2);
    const right = cx > W - 140;
    return `<g class="gr-dot" data-i="${i}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity=".9" stroke="#09090b" stroke-width="2"/><text x="${right ? cx - r - 6 : cx + r + 6}" y="${cy + 4}" font-size="11.5" fill="#d4d4d8" text-anchor="${right ? 'end' : 'start'}">${esc(c.name.split(' ')[0])}</text></g>`;
  }).join('');
  $('map').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Clients by yearly value and days to pay">${g}${dots}</svg><div class="an-tip gr-tip hidden" id="mapTip"></div>`;
  const tip = $('mapTip');
  $('map').querySelectorAll('.gr-dot').forEach((el) => {
    const c = cs[Number(el.dataset.i)];
    el.addEventListener('mouseenter', () => {
      tip.innerHTML = `<b>${esc(c.name)}</b>${c.company ? ` · ${esc(c.company)}` : ''}<br>${esc(m(c.value))} billed in 12 months · ${c.invoicesYear} invoice${c.invoicesYear === 1 ? '' : 's'}<br>${c.daysToPay === null ? 'no payments yet' : `pays in ${c.daysToPay} days, ${c.avgLate ? `${c.avgLate} days late` : 'on time'} on average`}${c.onTime !== null ? ` · ${c.onTime}% on time` : ''}`;
      tip.classList.remove('hidden');
      const box = $('map').getBoundingClientRect(), b = el.getBoundingClientRect();
      tip.style.left = `${Math.min(box.width - 230, Math.max(0, b.left - box.left + b.width / 2 - 110))}px`;
      tip.style.top = `${b.top - box.top - 78}px`;
    });
    el.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  });
}

function renderSegments() {
  if (!G.segments.length) { $('segments').innerHTML = '<p class="muted small">No clients yet.</p>'; return; }
  const total = G.segments.reduce((t, s) => t + s.value, 0) || 1;
  $('segments').innerHTML = `<ul class="gr-segs">${G.segments.map((s) => `
    <li class="${SEG_CLASS[s.key] || ''}">
      <div class="gr-seg-h"><i></i><b>${esc(s.label)}</b><span class="muted small">${s.count} client${s.count === 1 ? '' : 's'}</span><span class="num gr-seg-v">${esc(m(s.value))}</span></div>
      <div class="gr-bar thin"><i style="width:${Math.max(2, (s.value / total) * 100)}%"></i></div>
      <p>${esc(s.clients.join(', '))}. <span class="muted">${esc(s.help)}</span></p>
    </li>`).join('')}</ul>`;
}

function renderAreas() {
  const rows = G.areas;
  if (!rows.length) { $('areas').innerHTML = '<p class="muted small">No line items yet.</p>'; return; }
  const max = Math.max(1, ...rows.map((r) => r.revenue));
  const pair = (r) => {
    const top = Math.max(1, r.recent, r.before);
    return `<span class="gr-pair" title="3 months before: ${esc(m(r.before))} · last 3 months: ${esc(m(r.recent))}"><i style="height:${(r.before / top) * 100}%"></i><i class="now" style="height:${(r.recent / top) * 100}%"></i></span>`;
  };
  $('areas').innerHTML = `<table class="data gr-table">
    <thead><tr><th>Work area</th><th>Billed, 12 months</th><th class="r">Avg line</th><th class="r">Clients</th><th class="r">Repeat buyers</th><th class="r">Days to pay</th><th>Last 3 months vs 3 before</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><b>${esc(r.name)}</b><br><span class="muted small">${esc(r.examples.join(', '))}</span></td>
      <td><div class="gr-bar"><i style="width:${Math.max(2, (r.revenue / max) * 100)}%"></i></div><span class="num">${esc(m(r.revenue))}</span> <span class="muted small">${r.share}%</span></td>
      <td class="r">${esc(m(r.avgLine))}</td>
      <td class="r">${r.clients}</td>
      <td class="r">${r.repeatClients}</td>
      <td class="r">${r.daysToPay === null ? '—' : r.daysToPay}</td>
      <td><div class="gr-tr">${r.recurring ? '' : pair(r)}${trend(r.trend)}</div></td>
    </tr>`).join('')}</tbody></table>`;
}

const SEG_LABEL = { champion: 'Champion', loyal: 'Loyal', fix: 'Valuable but slow', slipping: 'Slipping away', new: 'New', oneoff: 'One-off', lost: 'Gone quiet' };
function renderClients() {
  const cs = [...G.clients].sort((a, b) => b.value - a.value);
  $('clients').innerHTML = `<datalist id="indList">${G.industryOptions.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>
  <table class="data gr-table">
    <thead><tr><th>Client</th><th>Industry</th><th>Segment</th><th class="r">Billed, 12 months</th><th class="r">Usually buys every</th><th class="r">Last invoice</th><th class="r">Pays in</th></tr></thead>
    <tbody>${cs.map((c) => `<tr>
      <td><div class="cl-who"><span class="avatar" aria-hidden="true">${esc(initials(c.name))}</span><span><b>${esc(c.name)}</b>${c.onPlan ? ' <span class="pill monthly">Retainer</span>' : ''}<br><span class="muted small">${esc(c.company || 'Private client')}</span></span></div></td>
      <td><input class="gr-ind" list="indList" data-id="${esc(c.id)}" value="${esc(c.industry)}" placeholder="Set industry" aria-label="Industry for ${esc(c.name)}"></td>
      <td><span class="gr-seg-pill ${SEG_CLASS[c.segment] || ''}">${SEG_LABEL[c.segment] || c.segment}</span></td>
      <td class="r">${esc(m(c.value))}</td>
      <td class="r">${c.cadence ? days(c.cadence) : '—'}</td>
      <td class="r">${esc(fmtDate(c.lastInvoice))}<br><span class="muted small">${c.daysSinceLast} days ago</span></td>
      <td class="r">${c.daysToPay === null ? '—' : days(c.daysToPay)}</td>
    </tr>`).join('')}</tbody></table>`;
  $('clients').querySelectorAll('.gr-ind').forEach((inp) => {
    let before = inp.value;
    inp.addEventListener('change', async () => {
      const v = inp.value.trim();
      if (v === before) return;
      try {
        await api(`/api/clients/${encodeURIComponent(inp.dataset.id)}/industry`, { method: 'POST', body: { industry: v } });
        before = v;
        toast(v ? `Industry set to ${v}` : 'Industry cleared');
        await load(false);
      } catch (e) {
        toast(e.message);
      }
    });
  });
}

async function loadPlan(refresh) {
  const btn = $('planBtn');
  btn.disabled = true;
  if (refresh) $('planHead').textContent = 'Writing a new plan from your numbers…';
  try {
    const p = await api('/api/growth/plan', { method: 'POST', body: { refresh } });
    $('planHead').textContent = p.headline;
    $('planSteps').innerHTML = p.steps.map((s) => `<li>${esc(s)}</li>`).join('');
    $('planSrc').textContent = p.source === 'ai' ? `Written by AI from the figures on this page${p.cached ? ' (saved earlier)' : ''}. Every number comes from your invoices.` : p.note || 'From your numbers.';
  } catch (e) {
    $('planHead').textContent = 'Could not write a plan right now.';
    $('planSrc').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function load(withPlan = true) {
  G = await api('/api/growth');
  renderKpis();
  renderOpps();
  renderIndustries();
  renderMap();
  renderSegments();
  renderAreas();
  renderClients();
  if (withPlan) loadPlan(false);
}

$('planBtn').addEventListener('click', () => loadPlan(true));
await load();
