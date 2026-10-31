import { api, header, esc, money, moneyMap, fmtDate, toast } from './common.js';

const $ = (id) => document.getElementById(id);
const cfg = await header('dashboard');
const cur = cfg.currency;

function chartSvg({ months, weeks }) {
  const bars = [...months, ...weeks];
  const W = 640, H = 240, padL = 8, padB = 28, padT = 22, gap = 14, sepGap = 26;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const bw = (W - padL * 2 - gap * (bars.length - 1) - sepGap) / bars.length;
  let x = padL;
  let out = '';
  bars.forEach((b, i) => {
    if (i === months.length) {
      out += `<line x1="${x + sepGap / 2 - gap / 2}" x2="${x + sepGap / 2 - gap / 2}" y1="${padT - 10}" y2="${H - padB}" stroke="#cfd6e4" stroke-dasharray="3 4"/>`;
      out += `<text x="${x + sepGap / 2 - gap / 2 + 6}" y="${padT - 2}" font-size="11" fill="#7c86a2">today</text>`;
      x += sepGap;
    }
    const h = ((H - padB - padT) * b.value) / max;
    const y = H - padB - h;
    const fill = b.kind === 'actual' ? '#18213d' : '#9fb1f0';
    out += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(h, 1)}" rx="3" fill="${fill}"><title>${b.label}: ${money(b.value, cur)}</title></rect>`;
    if (b.value) out += `<text x="${x + bw / 2}" y="${y - 6}" text-anchor="middle" font-size="11" fill="#4a5575">${money(b.value, cur)}</text>`;
    out += `<text x="${x + bw / 2}" y="${H - 9}" text-anchor="middle" font-size="12" fill="#7c86a2">${b.label}</text>`;
    x += bw + gap;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly earnings and forecast">${out}</svg>`;
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return fmtDate(iso.slice(0, 10));
}

async function load() {
  const [d, { invoices }] = await Promise.all([api('/api/dashboard'), api('/api/invoices')]);
  const s = d.summary;
  $('asof').textContent = `As of ${fmtDate(d.today)}${d.pendingApprovals ? ` · ${d.pendingApprovals} draft${d.pendingApprovals > 1 ? 's' : ''} waiting for your approval` : ''}`;

  $('figures').innerHTML = `
    <div class="fig"><div class="k">Earned this month</div><div class="v num">${moneyMap(s.earned, cur)}</div><div class="s">${s.paidInvoices} paid invoice${s.paidInvoices === 1 ? '' : 's'}</div></div>
    <div class="fig"><div class="k">Waiting to be paid</div><div class="v num">${moneyMap(s.outstanding, cur)}</div><div class="s">${s.openInvoices} open</div></div>
    <div class="fig ${s.overdueInvoices ? 'late' : ''}"><div class="k">Overdue</div><div class="v num">${moneyMap(s.overdue, cur)}</div><div class="s">${s.overdueInvoices ? `${s.overdueInvoices} invoice${s.overdueInvoices > 1 ? 's' : ''} · <a href="/followups">chase them</a>` : 'Nothing late'}</div></div>
    <div class="fig"><div class="k">Expected in 30 days</div><div class="v num">${moneyMap(d.forecast.expected, cur)}</div><div class="s">Weighted by each client's habits</div></div>`;

  $('chart').innerHTML = chartSvg(d.chart);

  $('feed').innerHTML = d.activity.length
    ? d.activity.map((a) => `<li><time datetime="${a.at}">${timeAgo(a.at)}</time><span>${esc(a.text)}</span></li>`).join('')
    : '<li class="muted">Nothing yet. Send your first invoice from the Assistant.</li>';

  if (!invoices.length) {
    $('invoices').innerHTML = `<div class="empty">No invoices yet.<br><a class="btn" href="/">Create one with the Assistant</a> <button class="btn ghost" id="seedBtn">Load demo history</button></div>`;
    $('seedBtn').onclick = async () => { await api('/api/demo/seed', { body: {} }); load(); };
    return;
  }
  const mock = cfg.paypalMode === 'mock';
  $('invoices').innerHTML = `
    <table class="data">
      <thead><tr><th>#</th><th>Client</th><th>Work</th><th>Issued</th><th>Due</th><th>Status</th><th class="r">Amount</th><th></th></tr></thead>
      <tbody>${invoices
        .map(
          (i) => `<tr>
            <td class="num">${esc(i.number)}</td>
            <td>${esc(i.client)}</td>
            <td class="muted">${esc(i.items.map((x) => x.name).join(', ')).slice(0, 60)}</td>
            <td>${fmtDate(i.issueDate)}</td>
            <td>${fmtDate(i.dueDate)}</td>
            <td><span class="pill ${i.displayStatus}">${i.displayStatus === 'OVERDUE' ? 'Overdue' : i.displayStatus.charAt(0) + i.displayStatus.slice(1).toLowerCase().replace(/_/g, ' ')}</span>${i.source === 'seed' ? ' <span class="muted" title="Demo history, not on PayPal">demo</span>' : ''}</td>
            <td class="r num">${money(i.total, i.currency)}</td>
            <td class="r">${
              i.payerUrl && ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(i.status)
                ? mock
                  ? `<button class="btn ghost small" data-pay="${esc(i.paypalId)}" title="Simulate the client paying">Simulate payment</button>`
                  : `<a href="${esc(i.payerUrl)}" target="_blank" rel="noopener">Payment page</a>`
                : ''
            }</td>
          </tr>`
        )
        .join('')}</tbody>
    </table>`;
}

$('invoices').addEventListener('click', async (e) => {
  const id = e.target.dataset?.pay;
  if (!id) return;
  e.target.disabled = true;
  await api(`/api/mock/pay/${id}`, { body: {} });
  toast('Payment received');
  load();
});

$('syncBtn').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const r = await api('/api/sync', { body: {} });
    toast(r.changed ? `${r.changed} invoice${r.changed > 1 ? 's' : ''} updated from PayPal` : `Checked ${r.checked} open invoice${r.checked === 1 ? '' : 's'}. No new payments.`);
    load();
  } catch (err) {
    toast(err.message);
  } finally {
    e.target.disabled = false;
  }
};

await load();
// keep the board live while it's open (webhooks update the server; this picks them up)
setInterval(() => document.visibilityState === 'visible' && load().catch(() => {}), 15000);
