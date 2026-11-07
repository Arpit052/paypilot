import { api, header, esc, money, fmtDate, RISK_TEXT } from './common.js';

const cfg = await header('budget');
const $ = (id) => document.getElementById(id);
const cur = cfg.currency;
document.querySelectorAll('.cur').forEach((x) => (x.textContent = cur));
if (cur !== 'USD') $('feeText').textContent = '3.49%';
const m = (v) => money(Math.round(v), cur);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const pctText = (c) => (c >= 99.5 ? '>99%' : c < 0.5 ? '<1%' : `${Math.round(c)}%`);
const ord = (d) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;

// ---------------- inputs ----------------
$('date').min = cfg.today;
$('date').max = addDays(cfg.today, 365);
$('date').value = addDays(cfg.today, 30);
const params = new URLSearchParams(location.search);
if (params.get('price')) $('price').value = params.get('price');
if (params.get('date')) $('date').value = params.get('date');
if (params.get('item')) $('item').value = params.get('item');

const eom = () => {
  const [y, mo] = cfg.today.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};
$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('date').value = b.dataset.eom !== undefined ? eom() : addDays(cfg.today, Number(b.dataset.days));
  markChip();
});
function markChip() {
  document.querySelectorAll('#chips button').forEach((b) => {
    const v = b.dataset.eom !== undefined ? eom() : addDays(cfg.today, Number(b.dataset.days));
    b.setAttribute('aria-pressed', String(v === $('date').value));
  });
}
$('date').addEventListener('change', markChip);
markChip();

// bills editor
function billRow(b = {}) {
  const row = document.createElement('div');
  row.className = 'bg-bill';
  row.innerHTML = `<input data-b="name" maxlength="40" placeholder="e.g. Rent, software, loan" value="${esc(b.name || '')}" aria-label="Bill name">
    <input data-b="amount" type="number" min="0" step="0.01" placeholder="0" value="${b.amount ?? ''}" aria-label="Amount" inputmode="decimal">
    <select data-b="day" aria-label="Day of month">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${Number(b.day || 1) === i + 1 ? 'selected' : ''}>${ord(i + 1)}</option>`).join('')}</select>
    <button type="button" class="bg-x" aria-label="Remove bill">×</button>`;
  row.querySelector('.bg-x').onclick = () => row.remove();
  $('bills').append(row);
}
const readBills = () =>
  [...document.querySelectorAll('.bg-bill')]
    .map((r) => ({ name: r.querySelector('[data-b=name]').value.trim() || 'Bill', amount: Number(r.querySelector('[data-b=amount]').value) || 0, day: Number(r.querySelector('[data-b=day]').value) }))
    .filter((b) => b.amount > 0);
$('addBill').onclick = () => billRow();
$('bills').insertAdjacentHTML('beforebegin', '<div class="bg-bill-h"><span>What</span><span>Per month</span><span>Leaves on</span><span></span></div>');

const { profile, paypalBalance, upcoming, receivedSince } = await api('/api/budget/profile?balance=1');
// before the first estimate: show what's coming in, so the page is useful straight away
if (upcoming?.length && !params.get('price')) {
  const total = upcoming.reduce((t, u) => t + u.amount * u.probability, 0);
  const habitText = (u) => {
    const h = u.habit || {};
    if (!h.paid) return 'New client: estimated from how your other clients pay';
    if (h.upfront) return `Usually pays in advance, about ${-h.medianLate} days before the due date`;
    if (h.medianLate <= 0) return `Usually pays on time${h.medianLate < 0 ? ` (${-h.medianLate} days early)` : ''}, from ${h.paid} past payment${h.paid === 1 ? '' : 's'}`;
    return `Usually pays ${h.medianLate} day${h.medianLate === 1 ? '' : 's'} late, from ${h.paid} past payment${h.paid === 1 ? '' : 's'}`;
  };
  $('empty').innerHTML = `<div class="bg-up-h"><div><b>Money on its way</b><span>Each unpaid invoice: when it's due, how that client usually pays, and so when the money is most likely to land. Add a price and a date to check a purchase against it.</span></div><div class="bg-up-t"><em>Expected in 45 days</em><b>${esc(m(total))}</b></div></div>
    <ul class="bg-up bg-up2">${upcoming
      .map((u) => `<li>
        <div class="bg-up-main"><time>${esc(fmtDate(u.date))}</time><span><b>${esc(u.client)}</b> · #${esc(u.invoice)}</span><i class="bg-bar"><i style="width:${Math.round(u.probability * 100)}%" class="${u.probability >= 0.8 ? 'ok' : u.probability >= 0.5 ? 'mid' : 'low'}"></i></i><em title="Chance it's paid within 45 days">${Math.round(u.probability * 100)}%</em><b>${esc(m(u.amount))}</b></div>
        <div class="bg-up-why"><span>Due ${esc(fmtDate(u.due))}${u.overdue ? ` <em class="bad-t">· ${u.overdue} day${u.overdue === 1 ? '' : 's'} overdue</em>` : ''}</span><span>${esc(habitText(u))}</span><span>Likely between ${esc(fmtDate(u.range[0]))} and ${esc(fmtDate(u.range[1]))} (8 in 10)</span></div>
      </li>`)
      .join('')}</ul>`;
  $('empty').classList.add('bg-upcoming');
}
if (profile.cashNow || receivedSince?.total) $('cash').value = Math.round(((profile.cashNow || 0) + (receivedSince?.total || 0)) * 100) / 100;
if (!receivedSince?.since && receivedSince?.recent?.total) {
  const r = receivedSince.recent;
  $('cashNote').innerHTML = `You were paid <b>${esc(m(r.total))}</b> in the last 14 days (after PayPal fees${r.items.length ? `, latest #${esc(r.items[0].number)} from ${esc(r.items[0].client)}` : ''}). If it isn't counted in "Have now" yet, <button type="button" class="linkbtn small" id="addRecent">add it</button>.`;
  $('cashNote').classList.remove('hidden');
  $('addRecent').onclick = () => {
    $('cash').value = Math.round(((Number($('cash').value) || 0) + r.total) * 100) / 100;
    $('cashNote').textContent = `Added ${m(r.total)} to "Have now".`;
  };
}
if (receivedSince?.total) {
  const list = receivedSince.items.slice(0, 3).map((x) => `#${x.number} from ${x.client}`).join(', ');
  $('cashNote').innerHTML = `Includes <b>${esc(m(receivedSince.total))}</b> paid to you since you last checked (${esc(list)}${receivedSince.items.length > 3 ? '…' : ''}), after fees and tax.`;
  $('cashNote').classList.remove('hidden');
}
if (profile.everyday) $('everyday').value = profile.everyday;
if (profile.buffer) $('buffer').value = profile.buffer;
if (profile.taxPct) $('tax').value = profile.taxPct;
$('fees').checked = profile.fees !== false;
(profile.bills?.length ? profile.bills : [{ name: '', amount: '', day: 1 }]).forEach(billRow);
if (paypalBalance !== null && paypalBalance !== undefined) {
  $('useBal').textContent = `Use PayPal balance (${money(paypalBalance, cur)})`;
  $('useBal').classList.remove('hidden');
  $('useBal').onclick = () => ($('cash').value = paypalBalance);
}

let exclude = new Set();
const body = () => ({
  item: $('item').value,
  price: Number($('price').value),
  date: $('date').value,
  instalments: Number($('inst').value),
  cashNow: Number($('cash').value) || 0,
  buffer: Number($('buffer').value) || 0,
  everyday: Number($('everyday').value) || 0,
  bills: readBills(),
  taxPct: Number($('tax').value) || 0,
  fees: $('fees').checked,
  exclude: [...exclude],
});

async function run() {
  $('err').textContent = '';
  if (!(Number($('price').value) > 0)) return ($('err').textContent = 'Enter the price of what you want to buy.');
  $('go').disabled = true;
  $('go').textContent = 'Running 4,000 futures…';
  try {
    const r = await api('/api/budget/estimate', { body: body() });
    render(r);
    history.replaceState(null, '', `?price=${r.price}&date=${r.date}${r.item ? `&item=${encodeURIComponent(r.item)}` : ''}`);
  } catch (err) {
    $('err').textContent = err.message;
  } finally {
    $('go').disabled = false;
    $('go').textContent = 'Estimate';
  }
}
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  run();
});

// ---------------- result ----------------
let R = null;
let view = 'chance';

function gauge(chance, level) {
  const a = Math.PI * (1 - Math.min(100, Math.max(0, chance)) / 100);
  const x = 60 + 50 * Math.cos(a);
  const y = 60 - 50 * Math.sin(a);
  const tick = (r) => [60 + r * Math.cos(Math.PI * 0.2), 60 - r * Math.sin(Math.PI * 0.2)].map((v) => v.toFixed(2));
  const [t1x, t1y] = tick(50), [t2x, t2y] = tick(41);
  return `<svg viewBox="0 0 120 70" class="bg-gauge" role="img" aria-label="${Math.round(chance)}% chance">
    <path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke="#1f1f23" stroke-width="9" stroke-linecap="round"/>
    ${chance > 0.5 ? `<path d="M10 60 A50 50 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}" fill="none" class="g-${level}" stroke-width="9" stroke-linecap="round"/>` : ''}
    <line x1="${t1x}" y1="${t1y}" x2="${t2x}" y2="${t2y}" stroke="#71717a" stroke-width="1.5"/>
    <text x="60" y="54" text-anchor="middle" class="g-num">${pctText(chance)}</text>
    <text x="60" y="68" text-anchor="middle" class="g-sub">chance</text>
  </svg>`;
}

function render(r) {
  R = r;
  const v = r.verdict;
  const tag = { yes: 'Likely', maybe: 'Uncertain', no: 'Unlikely' }[v.level];
  const target = fmtDate(r.date);
  const drivers = r.drivers.filter((d) => d.kind === 'invoice');
  const retainers = r.drivers.filter((d) => d.kind === 'retainer');
  const below = r.lowest.p50 < r.inputs.buffer;
  const how = r.instalments > 1 ? `${r.instalments} × ${m(r.instalment)}` : m(r.price);
  $('result').innerHTML = `
    <div class="panel bg-verdict lvl-${v.level}">
      ${gauge(r.chance, v.level)}
      <div class="bg-v-text">
        <span class="bg-tag">${tag}${r.item ? ` · ${esc(r.item)}` : ''} · ${esc(how)} from ${esc(target)}</span>
        <h2>${esc(v.headline)}</h2>
        <p>${esc(v.detail)}</p>
      </div>
    </div>

    ${v.pill?.length ? `<div class="panel bg-story">
      <div class="bg-pills"><span class="bg-pl">Verdict</span>${v.pill.map((p) => `<span class="bg-pill ${p.tone}"><i></i>${esc(p.text)}</span>`).join('')}</div>
      ${v.story ? `<p>${esc(v.story)}</p>` : ''}
      ${pathTable(r)}
    </div>` : ''}

    <div class="bg-stats">
      <div><span>Chance on ${esc(target)}</span><b>${pctText(r.chance)}</b><em>± ${r.margin} pts (95% sure)</em></div>
      <div><span>Most you can safely spend</span><b>${esc(m(r.maxSafe.p80))}</b><em>80% sure · ${esc(m(r.maxSafe.p95))} at 95%</em></div>
      <div><span>Lowest balance after buying</span><b class="${below ? 'bad-t' : ''}">${esc(m(r.lowest.p50))}</b><em>typical, in the next ${r.model.windowDays * r.instalments} days</em></div>
      <div><span>Safe to buy from</span><b>${r.safeDates.p80 ? (r.safeDates.p80 === r.date ? 'On the date' : esc(fmtDate(r.safeDates.p80))) : 'Not in sight'}</b><em>${r.safeDates.p80 ? `80% chance · 95%: ${r.safeDates.p95 ? esc(fmtDate(r.safeDates.p95)) : 'later'}` : 'from money already owed'}</em></div>
    </div>

    ${r.wait.length > 1 ? `<div class="bg-wait"><span>If you wait</span>${r.wait.map((w, i) => `<button type="button" data-wd="${w.date}" class="${i === 0 ? 'on' : ''}"><b>${pctText(w.chance)}</b><em>${i === 0 ? 'on the date' : esc(fmtDate(w.date))}</em></button>`).join('')}</div>` : ''}

    <section class="panel">
      <div class="bg-chart-h">
        <div><h2>${view === 'chance' ? 'Chance it\'s safe, by the day you buy' : `Your balance if you buy on ${esc(target)}`}</h2><p class="muted small">${view === 'chance' ? 'Solid line: only money already invoiced. Dotted: if your regular clients keep sending work.' : 'Shaded: 8 in 10 futures fall here. Line: the middle one. Dashed: your "never go below" line.'}</p></div>
        <div class="seg small-seg" role="group" aria-label="Chart" id="views"><button data-v="chance" aria-pressed="${view === 'chance'}">Chance</button><button data-v="money" aria-pressed="${view === 'money'}">Balance</button></div>
      </div>
      <div class="an-chart bg-chart" id="chart"></div>
    </section>

    <div class="bg-two">
      <section class="panel">
        <h2>The ${r.model.windowDays * r.instalments} days after buying</h2>
        <p class="muted small" style="margin:-6px 0 16px">Your lowest balance in that time, across ${r.model.simulations.toLocaleString('en-US')} futures. It has to stay above ${esc(m(r.inputs.buffer))}.</p>
        ${rangeBar(r)}
        <dl class="bg-facts">
          <div><dt>Bad month (1 in 10)</dt><dd class="${r.lowest.p10 < r.inputs.buffer ? 'bad-t' : ''}">${esc(m(r.lowest.p10))}</dd></div>
          <div><dt>Typical</dt><dd class="${below ? 'bad-t' : ''}">${esc(m(r.lowest.p50))}</dd></div>
          <div><dt>Money going out until ${esc(fmtDate(r.windowEnd))}</dt><dd>${esc(m(r.outflowsUntilEnd))}</dd></div>
          <div><dt>When it falls short</dt><dd>${r.shortfall.ifShort ? `${esc(m(r.shortfall.ifShort))} short on average<span class="muted small"> · ${pctText(100 - r.chance)} of futures</span>` : 'It never does'}</dd></div>
        </dl>
        ${r.billsInWindow.length ? `<ul class="bg-billlist">${r.billsInWindow.map((b) => `<li><span>${esc(b.name)}</span><em>${esc(fmtDate(b.date))}</em><b>${esc(m(b.amount))}</b></li>`).join('')}</ul>` : ''}
      </section>
      <section class="panel">
        <h2>What reaches you</h2>
        <p class="muted small" style="margin:-6px 0 14px">Of the ${esc(m(r.owedTotal))} clients owe you${r.feeRate ? `, after PayPal's ${r.feeRate.pct}%${r.feeRate.fixed ? ` + ${money(r.feeRate.fixed, cur)}` : ''} fee` : ''}${r.inputs.taxPct ? ` and ${r.inputs.taxPct}% for tax` : ''}.</p>
        <div class="bg-nw"><b>${esc(m(r.owedNet))}</b><span>is yours to spend, if everyone pays</span></div>
        <div class="bg-sub-h">If your regular clients keep sending work</div>
        <div class="bg-nw small"><b>${pctText(r.chanceWithNewWork)}</b><span>chance on ${esc(target)}${r.safeDatesWithNewWork.p80 ? ` · 80% from ${esc(fmtDate(r.safeDatesWithNewWork.p80))}` : ''}</span></div>
        ${r.newWorkClients.length ? `<ul class="bg-nwl">${r.newWorkClients.map((c) => `<li><span>${esc(c.client)}</span><em>about ${c.perMonth} job${c.perMonth === 1 ? '' : 's'} a month</em></li>`).join('')}</ul>` : '<p class="muted small">No repeat clients outside retainers yet.</p>'}
      </section>
    </div>

    <section class="panel" style="padding:0!important">
      <div class="sec-pad"><div><h2>What decides it</h2><p class="muted small" style="margin:2px 0 0">Each unpaid invoice, how likely it reaches you by ${esc(target)}, and how much the answer depends on it. Untick one to see what happens if it's never paid.</p></div></div>
      ${r.coveredByCash ? `<div class="bg-covered"><b>Nothing here decides it.</b><span>Your cash covers this purchase and the month after even if none of these invoices is ever paid. They're listed for reference.</span></div>` : ''}
      ${drivers.length || r.excluded.length ? `<div class="table-wrap"><table class="data bg-table"><thead><tr><th>Count it</th><th>Invoice</th><th>Client</th><th class="r">Amount</th><th>Pays</th><th>Arrives by ${esc(target)}</th><th>Likely date</th><th class="r" title="How much the chance changes if this invoice arrives in time vs not">Swing</th></tr></thead><tbody>${drivers
        .map(
          (d) => `<tr><td><input type="checkbox" checked data-ex="${esc(d.number)}" aria-label="Count invoice ${esc(d.number)}"></td>
          <td><b>#${esc(d.number)}</b>${d.daysOverdue ? `<br><span class="bad-t small">${d.daysOverdue}d overdue</span>` : `<br><span class="muted small">due ${esc(fmtDate(d.dueDate))}</span>`}</td>
          <td>${esc(d.client)}<br><span class="muted small">${d.history} past payment${d.history === 1 ? '' : 's'} · ${d.chancePaidEver}% pays at all</span></td>
          <td class="r num">${esc(m(d.amount))}<br><span class="muted small">${esc(m(d.net))} to you</span></td>
          <td><span class="pill ${d.risk}">${RISK_TEXT[d.risk] || d.risk}</span></td>
          <td><div class="bg-bar"><i style="width:${d.chanceByDate}%" class="${d.chanceByDate >= 80 ? 'ok' : d.chanceByDate >= 50 ? 'mid' : 'low'}"></i></div><span class="small">${d.chanceByDate}%</span></td>
          <td>${d.likelyDate ? `${esc(fmtDate(d.likelyDate))}<br><span class="muted small">${esc(fmtDate(d.earlyDate))} – ${esc(fmtDate(d.lateDate))}</span>` : '<span class="muted">—</span>'}</td>
          <td class="r">${d.impact === null ? '<span class="muted">—</span>' : `<b class="${d.impact >= 30 ? 'swing-hi' : ''}">${d.impact > 0 ? '+' : ''}${d.impact} pts</b>`}</td></tr>`
        )
        .join('')}${r.excluded
        .map((x) => `<tr class="bg-off"><td><input type="checkbox" data-ex="${esc(x.number)}" aria-label="Count invoice ${esc(x.number)}"></td><td><b>#${esc(x.number)}</b></td><td>${esc(x.client)}</td><td class="r num">${esc(m(x.amount))}</td><td colspan="4"><span class="muted small">Treated as never paid</span></td></tr>`)
        .join('')}</tbody></table></div>` : '<div class="list-empty"><b>Nothing unpaid</b><span>The answer only depends on your cash, bills and retainers.</span></div>'}
      ${retainers.length ? `<p class="muted small bg-ret">Also counted: ${retainers.length} retainer invoice${retainers.length === 1 ? '' : 's'} in this time (${retainers.slice(0, 4).map((d) => `${esc(d.client)} ${esc(m(d.amount))}, sent ${esc(fmtDate(d.issueDate))}`).join('; ')}${retainers.length > 4 ? '; …' : ''}).</p>` : ''}
    </section>

    <details class="panel bg-how">
      <summary><b>How this works</b><span class="muted small">Monte Carlo simulation, learned from ${r.model.paymentsLearnedFrom} of your past payments</span></summary>
      <ol>
        <li><b>Learn each client's habit.</b> For every paid invoice PayPilot knows how many days after the due date the money came. Clients with only a few payments are blended with everyone's history (their own data counts for n / (n + ${r.model.priorWeight})), and each draw gets about ${r.model.smoothingDays} days of noise so the model doesn't only repeat the past exactly.</li>
        <li><b>Respect what already happened.</b> An unpaid invoice hasn't been paid yet, so only futures where it arrives today or later are kept. If a client is later than they've ever been, the extra wait follows an exponential curve fitted to their late payments.</li>
        <li><b>Allow for money that never comes.</b> Each invoice is paid at all with a probability that starts at 98% and rises with every invoice the client has paid. Once it's later than the client's slowest payment ever, that chance halves every ${r.model.halfLifeDays} days.</li>
        <li><b>Count only what reaches you.</b> Each payment loses ${r.feeRate ? `PayPal's ${r.feeRate.pct}%${r.feeRate.fixed ? ` + ${money(r.feeRate.fixed, cur)}` : ''} invoicing fee` : 'no fees (switched off)'}${r.inputs.taxPct ? ` and ${r.inputs.taxPct}% set aside for tax` : ''}. Bills leave on their day of the month and everyday spending is spread across each day.</li>
        <li><b>Play out ${r.model.simulations.toLocaleString('en-US')} futures.</b> A future counts as "yes" if, after paying ${r.instalments > 1 ? `each of the ${r.instalments} instalments` : esc(m(r.price))}, your balance never drops below ${esc(m(r.inputs.buffer))} for the next ${r.model.windowDays} days${r.instalments > 1 ? ' after each one' : ''}, so next month's rent is safe too.</li>
        <li><b>Read the answer.</b> The chance is the share of "yes" futures (± ${r.margin} points of simulation error). "Most you can safely spend" is the amount that still works in 80% of futures. "Swing" compares futures where an invoice arrives in time with those where it doesn't.</li>
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
  $('result').querySelectorAll('[data-ex]').forEach((cb) =>
    cb.addEventListener('change', () => {
      if (cb.checked) exclude.delete(cb.dataset.ex);
      else exclude.add(cb.dataset.ex);
      run();
    })
  );
  $('result').querySelectorAll('[data-wd]').forEach((b) =>
    b.addEventListener('click', () => {
      $('date').value = b.dataset.wd;
      markChip();
      run();
    })
  );
  drawChart();
}

function pathTable(r) {
  const p = r.path;
  if (!p?.rows?.length) return '';
  const buf = r.inputs.buffer;
  return `<details class="bg-path" ${r.chance < 80 ? 'open' : ''}><summary>Typical path, day by day <span class="muted small">each payment on its most likely date${p.everydayPerDay ? ` · everyday spending of ${esc(m(p.everydayPerDay * 30.44))} a month spread across the days` : ''}</span></summary>
    <table class="data"><thead><tr><th>Date</th><th>What happens</th><th class="r">Amount</th><th class="r">Balance after</th></tr></thead><tbody>
    <tr class="bg-p-start"><td>${esc(fmtDate(cfg.today))}</td><td>Today</td><td class="r"></td><td class="r num">${esc(m(r.inputs.cashNow))}</td></tr>
    ${p.rows
      .map((x) => `<tr class="k-${x.kind} ${x.balance < buf && x.date >= r.date ? 'below' : ''} ${p.lowest && x.date === p.lowest.date && x.balance === p.lowest.balance ? 'lowest' : ''}"><td>${esc(fmtDate(x.date))}</td><td>${esc(x.label)}${x.kind === 'in' && x.risk === 'high' ? ' <span class="pill high">High</span>' : ''}</td><td class="r num ${x.amount >= 0 ? 'ok-t' : ''}">${x.amount >= 0 ? '+' : '−'}${esc(m(Math.abs(x.amount)))}</td><td class="r num">${esc(m(x.balance))}</td></tr>`)
      .join('')}
    <tr class="bg-p-start"><td>${esc(fmtDate(p.endDate))}</td><td>End of the safety window</td><td class="r"></td><td class="r num">${esc(m(p.endBalance))}</td></tr>
    </tbody></table></details>`;
}

function rangeBar(r) {
  const vals = [r.lowest.p10, r.lowest.p50, r.lowest.p90, r.inputs.buffer, 0];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 100;
  const x = (v) => ((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  return `<div class="bg-range">
    <div class="bg-range-track"></div>
    <div class="bg-range-band" style="left:${x(r.lowest.p10)}%;width:${Math.max(0.8, x(r.lowest.p90) - x(r.lowest.p10))}%"></div>
    <div class="bg-range-mid" style="left:${x(r.lowest.p50)}%"></div>
    <div class="bg-range-line" style="left:${x(r.inputs.buffer)}%"><span>${r.inputs.buffer ? `Never below ${esc(m(r.inputs.buffer))}` : 'Zero'}</span></div>
  </div>`;
}

function drawChart() {
  const chance = view === 'chance';
  const pts = chance ? R.timeline : R.balance;
  const W = 1000, H = 260, L = 58, Rr = 14, T = 16, B = 32;
  const x = (i) => L + (i * (W - L - Rr)) / Math.max(1, pts.length - 1);
  const ti = pts.findIndex((p) => p.date >= R.date);
  let y;
  let body = '';
  if (chance) {
    y = (v) => T + (H - T - B) * (1 - v / 100);
    const line = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    const area = `${line('chance')} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
    for (const g of [0, 25, 50, 75, 100]) body += `<line x1="${L}" x2="${W - Rr}" y1="${y(g)}" y2="${y(g)}" stroke="rgba(255,255,255,${g ? 0.05 : 0.12})"/><text x="${L - 10}" y="${y(g) + 4}" text-anchor="end" font-size="11" fill="#71717a">${g}%</text>`;
    body += `<line x1="${L}" x2="${W - Rr}" y1="${y(80)}" y2="${y(80)}" stroke="#52525b" stroke-dasharray="4 5"/><text x="${W - Rr}" y="${y(80) - 6}" text-anchor="end" font-size="11" fill="#a1a1aa">80% safe line</text>`;
    body += `<defs><linearGradient id="bgA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fafafa" stop-opacity=".16"/><stop offset="1" stop-color="#fafafa" stop-opacity="0"/></linearGradient></defs>`;
    body += `<path d="${area}" fill="url(#bgA)"/><path d="${line('chanceNew')}" fill="none" stroke="#a78bfa" stroke-width="1.6" stroke-dasharray="2 4"/><path d="${line('chance')}" fill="none" stroke="#e4e4e7" stroke-width="2"/>`;
  } else {
    let ymin = Math.min(...pts.map((p) => p.p10), R.inputs.buffer, 0);
    let ymax = Math.max(...pts.map((p) => p.p90), R.inputs.buffer);
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
    if (ymin < 0) body += `<line x1="${L}" x2="${W - Rr}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(251,113,133,.35)"/>`;
    body += `<path d="${top} ${bottom} Z" fill="rgba(250,250,250,0.09)"/><path d="${mid}" fill="none" stroke="#e4e4e7" stroke-width="2"/>`;
    body += `<line x1="${L}" x2="${W - Rr}" y1="${y(R.inputs.buffer)}" y2="${y(R.inputs.buffer)}" stroke="#a78bfa" stroke-dasharray="4 5"/><text x="${W - Rr}" y="${y(R.inputs.buffer) - 6}" text-anchor="end" font-size="11" fill="#c4b5fd">Never below ${esc(m(R.inputs.buffer))}</text>`;
  }
  if (ti >= 0) body += `<line x1="${x(ti)}" x2="${x(ti)}" y1="${T}" y2="${H - B}" stroke="#fafafa" stroke-width="1" stroke-dasharray="3 4" opacity=".55"/><text x="${x(ti) + 6}" y="${T + 10}" font-size="11" fill="#e4e4e7">${esc(fmtDate(R.date))}</text>`;
  const step = Math.ceil(pts.length / 7);
  body += pts.map((p, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#71717a">${esc(fmtDate(p.date))}</text>` : '')).join('');
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${chance ? 'Chance by purchase date' : 'Balance over time'}">${body}
      <line id="cx" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#fafafa" opacity="0"/><circle id="cd" r="4.5" fill="#09090b" stroke="#fafafa" stroke-width="2" opacity="0"/>
      <rect x="${L}" y="${T}" width="${W - L - Rr}" height="${H - T - B}" fill="transparent"/></svg><div class="an-tip hidden" id="tip"></div>`;
  const svg = $('chart').querySelector('svg');
  const tip = $('tip');
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((sx - L) / (W - L - Rr)) * (pts.length - 1))));
    const p = pts[i];
    const py = chance ? y(p.chance) : y(p.p50);
    $('cx').setAttribute('x1', x(i)); $('cx').setAttribute('x2', x(i)); $('cx').setAttribute('opacity', '.35');
    $('cd').setAttribute('cx', x(i)); $('cd').setAttribute('cy', py); $('cd').setAttribute('opacity', '1');
    tip.innerHTML = chance
      ? `<span class="muted">Buy on ${esc(fmtDate(p.date))}</span><b>${pctText(p.chance)}</b><span class="muted">${pctText(p.chanceNew)} with new work</span>`
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

if (params.get('price')) run();
