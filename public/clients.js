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
    await Promise.all([loadClients(), loadRetainers()]);
  } catch (err) {
    $('recErr').textContent = err.message;
  }
});

await Promise.all([loadClients(), loadRetainers()]);
