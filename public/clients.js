import { api, header, esc, money, fmtDate, toast, RISK_TEXT, daysLateText } from './common.js';

const cfg = await header('clients');
const $ = (id) => document.getElementById(id);
let clients = [];
let rank = {};
const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
document.querySelector('.cur').textContent = cfg.currency;

// ---------------- clients ----------------
function renderClients() {
  const q = $('q').value.trim().toLowerCase();
  const list = clients.filter((c) => !q || [c.name, c.company, c.email].some((x) => String(x || '').toLowerCase().includes(q)));
  $('clients').innerHTML = list.length
    ? `<table class="data cl-table"><thead><tr><th>Client</th><th>Risk</th><th class="r">Usually pays</th><th class="r">Invoices</th><th class="r">Total paid</th><th class="r">Owed</th><th class="r">Overdue</th><th></th></tr></thead><tbody>${list
        .map((c) => {
          const r = rank[c.id];
          return `<tr id="${esc(c.id)}">
            <td><div class="cl-who"><span class="avatar" aria-hidden="true">${esc(initials(c.name))}</span><span><b>${esc(c.name)}</b>${r?.rank === 1 ? ' <span class="pill top">Top client</span>' : ''}<br><span class="muted small">${c.company ? `${esc(c.company)} · ` : ''}${esc(c.email)}</span></span></div></td>
            <td><span class="pill ${c.riskLabel}">${RISK_TEXT[c.riskLabel]}</span></td>
            <td class="r">${daysLateText(c.avgDaysLate)}</td>
            <td class="r num">${c.invoiceCount}</td>
            <td class="r num">${money(c.totalPaid, c.currency)}${r ? `<br><span class="muted small">${r.share}% of revenue</span>` : ''}</td>
            <td class="r num">${c.outstanding ? money(c.outstanding, c.currency) : '<span class="muted">—</span>'}</td>
            <td class="r num">${c.overdueCount ? `<span class="bad-t">${money(c.overdueAmount, c.currency)}</span>` : '<span class="muted">—</span>'}</td>
            <td class="r"><button class="rm-client" data-rm="${esc(c.id)}" title="Remove from PayPilot (PayPal isn't changed)">Remove</button></td>
          </tr>`;
        })
        .join('')}</tbody></table>`
    : `<div class="list-empty"><b>${q ? 'No match' : 'No clients yet'}</b><span>${q ? 'Try another name or email.' : 'They appear here after your first invoice.'}</span></div>`;
  if (location.hash) document.getElementById(location.hash.slice(1))?.classList.add('flash');
}
async function loadClients() {
  const [{ clients: list }, { customers }] = await Promise.all([api('/api/clients'), api('/api/insights/top-customers?limit=50')]);
  clients = list;
  rank = Object.fromEntries(customers.map((c) => [c.clientId, c]));
  renderClients();
  $('rClient').innerHTML = list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.company ? ` · ${esc(c.company)}` : ''}</option>`).join('') + '<option value="__new">+ New client…</option>';
  if (!list.length) $('rClient').value = '__new';
  $('newClientFields').classList.toggle('hidden', $('rClient').value !== '__new');
}
$('q').addEventListener('input', renderClients);
$('clients').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  if (!b.classList.contains('sure')) {
    document.querySelectorAll('.rm-client.sure').forEach((x) => { x.classList.remove('sure'); x.textContent = 'Remove'; });
    b.classList.add('sure');
    b.textContent = 'Remove? Click again';
    setTimeout(() => { if (b.isConnected) { b.classList.remove('sure'); b.textContent = 'Remove'; } }, 4000);
    return;
  }
  b.disabled = true;
  try {
    await api(`/api/clients/${encodeURIComponent(b.dataset.rm)}`, { method: 'DELETE' });
    toast('Client removed from PayPilot');
    loadClients();
  } catch (err) {
    toast(err.message);
    b.disabled = false;
  }
});

// ---------------- retainers ----------------
async function loadRetainers() {
  const { schedules } = await api('/api/schedules');
  $('retainers').innerHTML = schedules.length
    ? schedules
        .map(
          (s) => `<article class="ret ${s.active ? '' : 'paused'}">
        <div class="ret-top"><span class="avatar" aria-hidden="true">${esc(initials(s.client))}</span>
          <div class="ret-who"><b>${esc(s.client)}</b><span>${esc(s.items.map((i) => i.name).join(', '))}</span></div>
          <span class="ret-state">${s.active ? (s.draftWaiting ? '<i class="w"></i>Draft waiting' : '<i class="on"></i>Active') : '<i></i>Paused'}</span></div>
        <div class="ret-amt"><b>${esc(money(s.total, s.currency))}</b><span>/ ${s.frequency === 'weekly' ? 'week' : 'month'}</span></div>
        <dl class="ret-facts">
          <div><dt>Next invoice</dt><dd>${s.active ? esc(fmtDate(s.nextRun)) : '—'}</dd></div>
          <div><dt>Billed so far</dt><dd>${esc(money(s.billedSoFar, s.currency))}<span> · ${s.invoicesSent} invoice${s.invoicesSent === 1 ? '' : 's'}</span></dd></div>
          <div><dt>Worth per year</dt><dd>${esc(money(s.perYear, s.currency))}</dd></div>
        </dl>
        ${s.active ? `<div class="ret-dates">${s.upcoming.map((d, i) => `<span class="${i ? '' : 'first'}">${esc(fmtDate(d))}</span>`).join('')}</div>` : ''}
        <div class="ret-acts">
          ${s.draftWaiting ? '<a class="btn small" href="/assistant">Review draft</a>' : ''}
          <button class="btn ghost small" data-op="${s.active ? 'pause' : 'resume'}" data-id="${esc(s.id)}">${s.active ? 'Pause' : 'Resume'}</button>
          <button class="linkbtn small" data-op="delete" data-id="${esc(s.id)}">Delete</button>
        </div>
      </article>`
        )
        .join('')
    : `<div class="ret-empty"><b>No retainers yet</b><span>Bill a client the same amount every week or month, like a design retainer or monthly support.</span><button class="btn small" type="button" data-new>New retainer</button></div>`;
}
$('retainers').addEventListener('click', async (e) => {
  if (e.target.closest('[data-new]')) return openDrawer();
  const b = e.target.closest('[data-op]');
  if (!b) return;
  const { op, id } = b.dataset;
  if (op === 'delete' && !b.dataset.confirm) {
    b.dataset.confirm = '1';
    b.textContent = 'Delete? Click again';
    return;
  }
  await api(`/api/schedules/${id}/${op}`, { body: {} });
  toast({ pause: 'Retainer paused', resume: 'Retainer resumed', delete: 'Retainer deleted' }[op]);
  loadRetainers();
});

// ---------------- new retainer drawer ----------------
function openDrawer() {
  $('rStart').value = cfg.today;
  $('rDue').value = String([0, 7, 15, 30].includes(cfg.defaultTermsDays) ? cfg.defaultTermsDays : 7);
  $('recErr').textContent = '';
  preview();
  $('drawer').classList.remove('hidden');
  setTimeout(() => $('rDesc').focus(), 50);
}
const closeDrawer = () => $('drawer').classList.add('hidden');
$('newRet').onclick = openDrawer;
$('drawer').addEventListener('click', (e) => e.target.closest('[data-close]') && closeDrawer());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());
$('rClient').addEventListener('change', () => $('newClientFields').classList.toggle('hidden', $('rClient').value !== '__new'));

function preview() {
  const amt = Number($('rAmount').value) || 0;
  const weekly = $('rFreq').value === 'weekly';
  const start = $('rStart').value || cfg.today;
  const dates = [];
  let d = new Date(`${start}T12:00:00Z`);
  for (let i = 0; i < 3; i++) {
    dates.push(d.toISOString().slice(0, 10));
    d = weekly ? new Date(d.getTime() + 7 * 864e5) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 12));
  }
  $('retPreview').innerHTML = amt
    ? `<span>First three invoices</span><div>${dates.map((x) => `<b>${esc(fmtDate(x))}</b>`).join('')}</div><em>${esc(money(amt * (weekly ? 52 : 12), cfg.currency))} a year · each one waits for your approval</em>`
    : '<span>Enter an amount to see the schedule.</span>';
}
$('recForm').addEventListener('input', preview);

$('recForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('recErr').textContent = '';
  const isNew = $('rClient').value === '__new';
  const c = clients.find((x) => x.id === $('rClient').value);
  try {
    const { action } = await api('/api/schedules', {
      body: {
        clientName: isNew ? $('rName').value : c.name,
        clientEmail: isNew ? $('rEmail').value : c.email,
        description: $('rDesc').value,
        amount: Number($('rAmount').value),
        frequency: $('rFreq').value,
        startDate: $('rStart').value,
        dueInDays: Number($('rDue').value),
      },
    });
    toast(action.result.firstDraftId ? 'Retainer created. The first invoice is waiting for your approval.' : `Retainer created. First invoice on ${fmtDate(action.payload.startDate)}.`);
    e.target.reset();
    closeDrawer();
    // ---------------- suggested retainers ----------------
let offers = [];
let word = 'monthly retainer';
const first = (n) => n.split(/\s+/)[0];

function spendBars(o) {
  const vals = o.pattern.monthly;
  const max = Math.max(...vals, o.offer.price) || 1;
  const W = 220, H = 64, gap = 6;
  const bw = (W - gap * (vals.length - 1)) / vals.length;
  const y = (v) => H - (v / max) * (H - 6);
  const bars = vals.map((v, i) => `<rect x="${i * (bw + gap)}" y="${y(v)}" width="${bw}" height="${Math.max(1.5, H - y(v))}" rx="3" fill="${v ? '#3f3f46' : '#1c1c1f'}"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H + 2}" class="of-bars" role="img" aria-label="Monthly spend, last ${vals.length} months">${bars}<line x1="0" x2="${W}" y1="${y(o.offer.price)}" y2="${y(o.offer.price)}" stroke="#a78bfa" stroke-dasharray="4 4"/></svg>`;
}

function renderOffers() {
  $('offersWrap').classList.toggle('hidden', !offers.length);
  $('offerList').innerHTML = offers
    .map((o) => {
      const p = o.pattern, f = o.offer;
      const m = (v) => money(Math.round(v), o.currency);
      const d1 = (v) => (Math.round(v * 10) / 10).toString();
      const speed = f.payment.retainerClients !== null && f.payment.client !== null
        ? `<div><dt>Pays now</dt><dd>${f.payment.client <= f.payment.retainerClients + 0.2 ? 'On time' : `${d1(f.payment.client)} days late`}<span> · your retainer clients: ${d1(f.payment.retainerClients)}</span></dd></div>`
        : `<div><dt>Invoices a year</dt><dd>${f.invoicesNow} → ${f.invoicesPlan}</dd></div>`;
      return `<article class="of ${o.status}" data-cid="${esc(o.clientId)}">
        <div class="ret-top"><span class="avatar" aria-hidden="true">${esc(initials(o.client))}</span>
          <div class="ret-who"><b>${esc(o.client)}</b><span>${esc(o.company || o.email)}</span></div>
          <span class="ret-state">${o.status === 'offered' ? `<i class="w"></i>Offer sent ${esc(fmtDate(o.offeredAt))}` : `<i class="on"></i>Good fit`}</span></div>
        <p class="of-why">Worked with you in <b>${p.activeMonths} of the last ${p.months} months</b>, about every ${p.cadenceDays} days${p.usual.length ? `, usually for ${p.usual.slice(0, 2).map((x) => `“${esc(x)}”`).join(' and ')}` : ''}.</p>
        <div class="of-mid">
          <div class="of-price"><span>Suggested ${esc(f.word)}</span><b>${esc(m(f.price))}<small> / month</small></b><em>${f.discount}% less than a typical month with you (${esc(m(p.perActiveMonth))})</em></div>
          <div class="of-chart">${spendBars(o)}<span>Spend per month (last ${p.months}) · <i class="of-key"></i> plan price</span></div>
        </div>
        <dl class="ret-facts of-facts">
          <div><dt>You, per year</dt><dd class="${f.yearChange >= 0 ? 'good-t' : ''}">${f.yearChange >= 0 ? '+' : '−'}${esc(m(Math.abs(f.yearChange)))}<span> · ${f.yearChange >= 0 ? `${esc(m(f.yearNow))} → ${esc(m(f.yearPlan))}` : 'for fixed monthly income'}</span></dd></div>
          <div><dt>A typical month, for ${esc(first(o.client))}</dt><dd>${esc(m(p.perActiveMonth))} → ${esc(m(f.price))}<span> · −${f.discount}%</span></dd></div>
          ${speed}
        </dl>
        <div class="ret-acts">
          <button class="btn small" data-of="write">${o.draft ? 'View offer' : 'Write offer'}</button>
          <button class="btn ghost small" data-of="yes">${esc(first(o.client))} said yes</button>
          <button class="linkbtn small" data-of="dismiss">Not now</button>
        </div>
      </article>`;
    })
    .join('');
}
async function loadOffers() {
  const r = await api('/api/offers');
  offers = r.offers;
  word = r.word;
  renderOffers();
  if (location.hash === '#offers') document.getElementById('offers')?.scrollIntoView({ block: 'start' });
}

const od = $('offerDrawer');
const closeOffer = () => od.classList.add('hidden');
od.addEventListener('click', (e) => e.target.closest('[data-oclose]') && closeOffer());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeOffer());

async function openWrite(o, refresh = false) {
  $('odTitle').textContent = `Offer for ${o.client}`;
  $('odBody').innerHTML = '<div class="of-loading">Writing the offer…</div>';
  od.classList.remove('hidden');
  try {
    const { draft } = await api(`/api/offers/${encodeURIComponent(o.clientId)}/draft`, { body: { refresh } });
    $('odBody').innerHTML = `
      <p class="muted small" style="margin:0 0 4px">Send it from your own email. PayPilot doesn't email clients, so it sounds like you and lands in a thread they know.</p>
      <label for="odTo">To</label><input id="odTo" value="${esc(o.email)}" readonly>
      <label for="odSubj">Subject</label><input id="odSubj" value="${esc(draft.subject)}">
      <label for="odMsg">Message</label><textarea id="odMsg" rows="12">${esc(draft.message)}</textarea>
      <span class="muted small">${draft.draftedBy === 'ai' ? 'Written by AI from your invoice history. Edit anything.' : 'Written from a template (AI not available). Edit anything.'}</span>
      <div class="of-acts">
        <button class="btn small" type="button" id="odCopy">Copy message</button>
        <a class="btn ghost small" id="odMail" href="#">Open in email app</a>
        <button class="linkbtn small" type="button" id="odAgain">Rewrite</button>
      </div>
      <div class="ret-preview"><span>Sent it?</span><button class="btn ghost small" type="button" id="odSent" style="margin:0;align-self:flex-start">Mark as sent</button><em>You'll see "Offer sent" on the card until ${esc(first(o.client))} replies.</em></div>`;
    const mail = () => `mailto:${encodeURIComponent(o.email)}?subject=${encodeURIComponent($('odSubj').value)}&body=${encodeURIComponent($('odMsg').value)}`;
    $('odMail').onclick = (e) => { e.preventDefault(); location.href = mail(); };
    $('odCopy').onclick = async () => {
      const text = `Subject: ${$('odSubj').value}\n\n${$('odMsg').value}`;
      try { await navigator.clipboard.writeText(text); } catch {
        const t = Object.assign(document.createElement('textarea'), { value: text });
        document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
      }
      toast('Offer copied. Paste it into an email to your client.');
    };
    $('odAgain').onclick = () => openWrite(o, true);
    $('odSent').onclick = async () => {
      await api(`/api/offers/${encodeURIComponent(o.clientId)}/offered`, { body: {} });
      toast('Marked as sent');
      closeOffer();
      loadOffers();
    };
  } catch (err) {
    $('odBody').innerHTML = `<div class="slip-error">${esc(err.message)}</div>`;
  }
}

function openYes(o) {
  const [y, mo] = cfg.today.split('-').map(Number);
  const firstNext = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
  $('odTitle').textContent = `Start ${o.client}'s ${o.offer.word}`;
  $('odBody').innerHTML = `
    <form id="odYes" class="ret-form" style="gap:6px">
      <p class="muted small" style="margin:0 0 4px">Great news. This creates the ${esc(o.offer.word)}. On each date the invoice is drafted for you to approve, then sent through PayPal.</p>
      <div class="two">
        <div><label for="odPrice">Price per month (${esc(o.currency)})</label><input id="odPrice" type="number" min="1" step="0.01" value="${o.offer.price}" required></div>
        <div><label for="odStart">First invoice</label><input id="odStart" type="date" value="${firstNext}" min="${cfg.today}" required></div>
      </div>
      <div class="ret-preview" id="odPrev"></div>
      <div class="slip-error" id="odErr" role="alert"></div>
      <button class="btn" type="submit" style="width:100%">Create ${esc(o.offer.word)}</button>
    </form>`;
  const prev = () => {
    const p = Number($('odPrice').value) || 0;
    const change = p * 12 - o.offer.yearNow;
    $('odPrev').innerHTML = `<span>${esc(money(p * 12, o.currency))} a year from ${esc(o.client)}</span><em>${change >= 0 ? `${esc(money(change, o.currency))} more than at today's pace` : `${esc(money(-change, o.currency))} less than today's pace, in exchange for fixed, on-time income`}</em>`;
  };
  $('odPrice').addEventListener('input', prev);
  prev();
  od.classList.remove('hidden');
  $('odYes').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { action } = await api(`/api/offers/${encodeURIComponent(o.clientId)}/accept`, { body: { price: Number($('odPrice').value), startDate: $('odStart').value } });
      toast(action.result.firstDraftId ? 'Retainer created. The first invoice is waiting for your approval.' : `Retainer created. First invoice on ${fmtDate(action.payload.startDate)}.`);
      closeOffer();
      await Promise.all([loadOffers(), loadRetainers()]);
    } catch (err) {
      $('odErr').textContent = err.message;
    }
  });
}

$('offerList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-of]');
  if (!b) return;
  const o = offers.find((x) => x.clientId === b.closest('[data-cid]').dataset.cid);
  if (b.dataset.of === 'write') return openWrite(o);
  if (b.dataset.of === 'yes') return openYes(o);
  if (b.dataset.of === 'dismiss') {
    await api(`/api/offers/${encodeURIComponent(o.clientId)}/dismiss`, { body: {} });
    toast(`Hidden for 60 days`);
    loadOffers();
  }
});

await Promise.all([loadClients(), loadRetainers(), loadOffers()]);
  } catch (err) {
    $('recErr').textContent = err.message;
  }
});

// ---------------- suggested retainers ----------------
let offers = [];
let word = 'monthly retainer';
const first = (n) => n.split(/\s+/)[0];

function spendBars(o) {
  const vals = o.pattern.monthly;
  const max = Math.max(...vals, o.offer.price) || 1;
  const W = 220, H = 64, gap = 6;
  const bw = (W - gap * (vals.length - 1)) / vals.length;
  const y = (v) => H - (v / max) * (H - 6);
  const bars = vals.map((v, i) => `<rect x="${i * (bw + gap)}" y="${y(v)}" width="${bw}" height="${Math.max(1.5, H - y(v))}" rx="3" fill="${v ? '#3f3f46' : '#1c1c1f'}"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H + 2}" class="of-bars" role="img" aria-label="Monthly spend, last ${vals.length} months">${bars}<line x1="0" x2="${W}" y1="${y(o.offer.price)}" y2="${y(o.offer.price)}" stroke="#a78bfa" stroke-dasharray="4 4"/></svg>`;
}

function renderOffers() {
  $('offersWrap').classList.toggle('hidden', !offers.length);
  $('offerList').innerHTML = offers
    .map((o) => {
      const p = o.pattern, f = o.offer;
      const m = (v) => money(Math.round(v), o.currency);
      const d1 = (v) => (Math.round(v * 10) / 10).toString();
      const speed = f.payment.retainerClients !== null && f.payment.client !== null
        ? `<div><dt>Pays now</dt><dd>${f.payment.client <= f.payment.retainerClients + 0.2 ? 'On time' : `${d1(f.payment.client)} days late`}<span> · your retainer clients: ${d1(f.payment.retainerClients)}</span></dd></div>`
        : `<div><dt>Invoices a year</dt><dd>${f.invoicesNow} → ${f.invoicesPlan}</dd></div>`;
      return `<article class="of ${o.status}" data-cid="${esc(o.clientId)}">
        <div class="ret-top"><span class="avatar" aria-hidden="true">${esc(initials(o.client))}</span>
          <div class="ret-who"><b>${esc(o.client)}</b><span>${esc(o.company || o.email)}</span></div>
          <span class="ret-state">${o.status === 'offered' ? `<i class="w"></i>Offer sent ${esc(fmtDate(o.offeredAt))}` : `<i class="on"></i>Good fit`}</span></div>
        <p class="of-why">Worked with you in <b>${p.activeMonths} of the last ${p.months} months</b>, about every ${p.cadenceDays} days${p.usual.length ? `, usually for ${p.usual.slice(0, 2).map((x) => `“${esc(x)}”`).join(' and ')}` : ''}.</p>
        <div class="of-mid">
          <div class="of-price"><span>Suggested ${esc(f.word)}</span><b>${esc(m(f.price))}<small> / month</small></b><em>${f.discount}% less than a typical month with you (${esc(m(p.perActiveMonth))})</em></div>
          <div class="of-chart">${spendBars(o)}<span>Spend per month (last ${p.months}) · <i class="of-key"></i> plan price</span></div>
        </div>
        <dl class="ret-facts of-facts">
          <div><dt>You, per year</dt><dd class="${f.yearChange >= 0 ? 'good-t' : ''}">${f.yearChange >= 0 ? '+' : '−'}${esc(m(Math.abs(f.yearChange)))}<span> · ${f.yearChange >= 0 ? `${esc(m(f.yearNow))} → ${esc(m(f.yearPlan))}` : 'for fixed monthly income'}</span></dd></div>
          <div><dt>A typical month, for ${esc(first(o.client))}</dt><dd>${esc(m(p.perActiveMonth))} → ${esc(m(f.price))}<span> · −${f.discount}%</span></dd></div>
          ${speed}
        </dl>
        <div class="ret-acts">
          <button class="btn small" data-of="write">${o.draft ? 'View offer' : 'Write offer'}</button>
          <button class="btn ghost small" data-of="yes">${esc(first(o.client))} said yes</button>
          <button class="linkbtn small" data-of="dismiss">Not now</button>
        </div>
      </article>`;
    })
    .join('');
}
async function loadOffers() {
  const r = await api('/api/offers');
  offers = r.offers;
  word = r.word;
  renderOffers();
  if (location.hash === '#offers') document.getElementById('offers')?.scrollIntoView({ block: 'start' });
}

const od = $('offerDrawer');
const closeOffer = () => od.classList.add('hidden');
od.addEventListener('click', (e) => e.target.closest('[data-oclose]') && closeOffer());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeOffer());

async function openWrite(o, refresh = false) {
  $('odTitle').textContent = `Offer for ${o.client}`;
  $('odBody').innerHTML = '<div class="of-loading">Writing the offer…</div>';
  od.classList.remove('hidden');
  try {
    const { draft } = await api(`/api/offers/${encodeURIComponent(o.clientId)}/draft`, { body: { refresh } });
    $('odBody').innerHTML = `
      <p class="muted small" style="margin:0 0 4px">Send it from your own email. PayPilot doesn't email clients, so it sounds like you and lands in a thread they know.</p>
      <label for="odTo">To</label><input id="odTo" value="${esc(o.email)}" readonly>
      <label for="odSubj">Subject</label><input id="odSubj" value="${esc(draft.subject)}">
      <label for="odMsg">Message</label><textarea id="odMsg" rows="12">${esc(draft.message)}</textarea>
      <span class="muted small">${draft.draftedBy === 'ai' ? 'Written by AI from your invoice history. Edit anything.' : 'Written from a template (AI not available). Edit anything.'}</span>
      <div class="of-acts">
        <button class="btn small" type="button" id="odCopy">Copy message</button>
        <a class="btn ghost small" id="odMail" href="#">Open in email app</a>
        <button class="linkbtn small" type="button" id="odAgain">Rewrite</button>
      </div>
      <div class="ret-preview"><span>Sent it?</span><button class="btn ghost small" type="button" id="odSent" style="margin:0;align-self:flex-start">Mark as sent</button><em>You'll see "Offer sent" on the card until ${esc(first(o.client))} replies.</em></div>`;
    const mail = () => `mailto:${encodeURIComponent(o.email)}?subject=${encodeURIComponent($('odSubj').value)}&body=${encodeURIComponent($('odMsg').value)}`;
    $('odMail').onclick = (e) => { e.preventDefault(); location.href = mail(); };
    $('odCopy').onclick = async () => {
      const text = `Subject: ${$('odSubj').value}\n\n${$('odMsg').value}`;
      try { await navigator.clipboard.writeText(text); } catch {
        const t = Object.assign(document.createElement('textarea'), { value: text });
        document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
      }
      toast('Offer copied. Paste it into an email to your client.');
    };
    $('odAgain').onclick = () => openWrite(o, true);
    $('odSent').onclick = async () => {
      await api(`/api/offers/${encodeURIComponent(o.clientId)}/offered`, { body: {} });
      toast('Marked as sent');
      closeOffer();
      loadOffers();
    };
  } catch (err) {
    $('odBody').innerHTML = `<div class="slip-error">${esc(err.message)}</div>`;
  }
}

function openYes(o) {
  const [y, mo] = cfg.today.split('-').map(Number);
  const firstNext = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
  $('odTitle').textContent = `Start ${o.client}'s ${o.offer.word}`;
  $('odBody').innerHTML = `
    <form id="odYes" class="ret-form" style="gap:6px">
      <p class="muted small" style="margin:0 0 4px">Great news. This creates the ${esc(o.offer.word)}. On each date the invoice is drafted for you to approve, then sent through PayPal.</p>
      <div class="two">
        <div><label for="odPrice">Price per month (${esc(o.currency)})</label><input id="odPrice" type="number" min="1" step="0.01" value="${o.offer.price}" required></div>
        <div><label for="odStart">First invoice</label><input id="odStart" type="date" value="${firstNext}" min="${cfg.today}" required></div>
      </div>
      <div class="ret-preview" id="odPrev"></div>
      <div class="slip-error" id="odErr" role="alert"></div>
      <button class="btn" type="submit" style="width:100%">Create ${esc(o.offer.word)}</button>
    </form>`;
  const prev = () => {
    const p = Number($('odPrice').value) || 0;
    const change = p * 12 - o.offer.yearNow;
    $('odPrev').innerHTML = `<span>${esc(money(p * 12, o.currency))} a year from ${esc(o.client)}</span><em>${change >= 0 ? `${esc(money(change, o.currency))} more than at today's pace` : `${esc(money(-change, o.currency))} less than today's pace, in exchange for fixed, on-time income`}</em>`;
  };
  $('odPrice').addEventListener('input', prev);
  prev();
  od.classList.remove('hidden');
  $('odYes').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { action } = await api(`/api/offers/${encodeURIComponent(o.clientId)}/accept`, { body: { price: Number($('odPrice').value), startDate: $('odStart').value } });
      toast(action.result.firstDraftId ? 'Retainer created. The first invoice is waiting for your approval.' : `Retainer created. First invoice on ${fmtDate(action.payload.startDate)}.`);
      closeOffer();
      await Promise.all([loadOffers(), loadRetainers()]);
    } catch (err) {
      $('odErr').textContent = err.message;
    }
  });
}

$('offerList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-of]');
  if (!b) return;
  const o = offers.find((x) => x.clientId === b.closest('[data-cid]').dataset.cid);
  if (b.dataset.of === 'write') return openWrite(o);
  if (b.dataset.of === 'yes') return openYes(o);
  if (b.dataset.of === 'dismiss') {
    await api(`/api/offers/${encodeURIComponent(o.clientId)}/dismiss`, { body: {} });
    toast(`Hidden for 60 days`);
    loadOffers();
  }
});

await Promise.all([loadClients(), loadRetainers(), loadOffers()]);
