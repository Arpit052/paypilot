import { api, header, esc, money, fmtDate, toast } from './common.js';

const cfg = await header('receipts');
const $ = (id) => document.getElementById(id);
const focusId = new URLSearchParams(location.search).get('inv');
let data = null;
let filter = focusId ? 'all' : 'all';

const STATUS = {
  needed: ['rx-needed', 'To send'],
  auto: ['rx-auto', 'PayPal sent it'],
  sent: ['rx-sent', 'Sent'],
  viewed: ['rx-viewed', 'Opened'],
};

async function load() {
  data = await api('/api/receipts');
  const s = data.summary;
  $('stats').innerHTML = `
    <div><span>Receipts</span><b>${s.total}</b><em>${s.thisMonth} this month</em></div>
    <div class="${s.needed ? 'warn' : ''}"><span>To send</span><b>${s.needed}</b><em>paid by bank, cash or cheque</em></div>
    <div><span>Sent by you</span><b>${s.sent}</b><em>${s.viewed} opened by the client</em></div>
    <div><span>PayPal sent them</span><b>${s.auto}</b><em>paid through PayPal</em></div>`;
  if (s.needed && !focusId && filter === 'all') filter = 'needed';
  render();
}

function render() {
  document.querySelectorAll('#filter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === filter)));
  const q = $('q').value.trim().toLowerCase();
  const rows = data.receipts.filter((r) => (filter === 'all' || (filter === 'needed' ? r.status === 'needed' : ['sent', 'viewed'].includes(r.status))) && (!q || [r.client, r.company, r.invoice, r.receipt].some((x) => String(x).toLowerCase().includes(q))));
  if (!rows.length) {
    $('list').innerHTML = `<div class="list-empty"><b>${filter === 'needed' ? 'Every receipt is sent' : 'No receipts yet'}</b><span>${filter === 'needed' ? 'Payments by bank transfer, cash or cheque show up here until you send their receipt.' : 'They appear as soon as an invoice is paid.'}</span></div>`;
    return;
  }
  $('list').innerHTML = `<table class="data rx-table"><thead><tr><th>Receipt</th><th>Client</th><th>Paid</th><th>Via</th><th class="r">Amount</th><th>Status</th><th></th></tr></thead><tbody>${rows
    .map((r) => {
      const [tone, label] = STATUS[r.status];
      const subject = `Receipt ${r.receipt} from ${cfg.businessName || 'us'}`;
      const body = `Hi ${r.client.split(' ')[0]},\n\nThank you for your payment of ${money(r.amount, r.currency)} for invoice #${r.invoice}. Your receipt is here:\n${r.link}\n\n${cfg.businessName || ''}`;
      return `<tr class="${r.invoiceId === focusId ? 'rx-focus' : ''}" data-id="${esc(r.invoiceId)}">
        <td><b>${esc(r.receipt)}</b><br><span class="muted small">invoice #${esc(r.invoice)}</span></td>
        <td>${esc(r.client)}${r.company ? `<br><span class="muted small">${esc(r.company)}</span>` : ''}</td>
        <td>${esc(fmtDate(r.paidDate))}</td>
        <td>${esc(r.via === 'PayPal' ? 'PayPal' : r.via.charAt(0).toUpperCase() + r.via.slice(1))}</td>
        <td class="r num">${esc(money(r.amount, r.currency))}</td>
        <td><span class="pill ${tone}">${label}</span>${r.sentAt ? `<br><span class="muted small">${esc(fmtDate(r.sentAt.slice(0, 10)))}${r.viewedAt ? ` · opened ${esc(fmtDate(r.viewedAt.slice(0, 10)))}` : ''}</span>` : ''}</td>
        <td class="r rx-acts"><a class="btn ghost small" href="${esc(r.link)}?preview=1" target="_blank" rel="noopener">View</a>
          <a class="btn ghost small" data-mail href="mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}">Email</a>
          <button class="btn ghost small" data-copy="${esc(r.link)}">Copy link</button>
          ${r.status === 'needed' || r.status === 'auto' ? `<button class="btn small" data-sent>Mark sent</button>` : ''}</td></tr>`;
    })
    .join('')}</tbody></table>`;
  document.querySelector('.rx-focus')?.scrollIntoView({ block: 'center' });
}

$('filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  filter = b.dataset.f;
  render();
});
$('q').addEventListener('input', render);
$('list').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  if (e.target.closest('[data-copy]')) {
    const link = e.target.closest('[data-copy]').dataset.copy;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const t = Object.assign(document.createElement('textarea'), { value: link });
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    toast(/localhost|127\.0\.0\.1/.test(link) ? 'Receipt link copied. It opens on this computer only until PayPilot is deployed.' : 'Receipt link copied.');
  }
  if (e.target.closest('[data-sent]') || e.target.closest('[data-mail]')) {
    await api(`/api/receipts/${encodeURIComponent(tr.dataset.id)}/sent`, { body: { via: e.target.closest('[data-mail]') ? 'email' : 'manual' } });
    if (e.target.closest('[data-sent]')) toast('Marked as sent');
    load();
  }
});

await load();
