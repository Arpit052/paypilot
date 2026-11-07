import { api, header, esc, money, fmtDate } from './common.js';

await header('tax');
const $ = (id) => document.getElementById(id);
let year = Number(new URLSearchParams(location.search).get('year')) || null;

const long = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

async function load() {
  const r = await api(`/api/tax${year ? `?year=${year}` : ''}`);
  year = r.year;
  $('year').innerHTML = r.years.map((y) => `<option value="${y}" ${y === r.year ? 'selected' : ''}>Tax year ${y}</option>`).join('');
  $('csv').href = `/api/tax.csv?year=${r.year}`;
  history.replaceState(null, '', `?year=${r.year}`);
  const m = (v) => money(v, r.currency);
  const t = r.totals;
  const maxQ = Math.max(1, ...r.periods.map((p) => p.income));
  $('report').innerHTML = `
    <section class="panel tx-head">
      <div><span class="tx-k">Prepared for</span><b>${esc(r.business || 'Your business')}</b>${r.owner ? `<span>${esc(r.owner)}</span>` : ''}</div>
      <div><span class="tx-k">Period</span><b>Jan 1 – Dec 31, ${r.year}</b><span>Cash basis: income counted on the day it was paid</span></div>
      <div><span class="tx-k">Generated</span><b>${esc(long(r.generatedAt.slice(0, 10)))}</b><span>${t.invoices} paid invoice${t.invoices === 1 ? '' : 's'} · amounts in ${esc(r.currency)}</span></div>
    </section>
    ${r.hasDemo ? '<p class="tx-note">This year includes demo history, so these are sample numbers.</p>' : ''}

    <section class="tx-sum">
      <div><span>Gross received</span><b>${esc(m(t.gross))}</b><em>everything clients paid you</em></div>
      <div><span>Sales tax collected</span><b>${esc(m(t.salesTax))}</b><em>owed to the state, not income</em></div>
      <div><span>PayPal fees</span><b>−${esc(m(t.fees))}</b><em>estimated at ${r.feeRate.pct}%${r.feeRate.fixed ? ` + ${esc(money(r.feeRate.fixed, r.currency))}` : ''}, deductible</em></div>
      <div class="hl"><span>Net income</span><b>${esc(m(t.net))}</b><em>before your other business expenses</em></div>
    </section>

    <div class="tx-grid">
      <section class="panel">
        <h2>By estimated-tax quarter</h2>
        <p class="muted small tx-help">The IRS periods for quarterly estimated payments, with each payment's due date.</p>
        <table class="data tx-table"><thead><tr><th>Period</th><th></th><th class="r">Income</th><th class="r">Fees</th><th class="r">Net</th><th>Payment due</th></tr></thead><tbody>
          ${r.periods
            .map((p) => `<tr><td><b>${p.key}</b><br><span class="muted small">${esc(p.label)}</span></td><td class="tx-barcell"><i style="width:${(p.income / maxQ) * 100}%"></i></td><td class="r num">${esc(m(p.income))}</td><td class="r num muted">${p.fees ? `−${esc(m(p.fees))}` : "—"}</td><td class="r num"><b>${esc(m(p.net))}</b></td><td>${esc(long(p.due))}</td></tr>`)
            .join('')}
        </tbody></table>
      </section>
      <section class="panel">
        <h2>Rough tax to plan for</h2>
        <p class="muted small tx-help">Planning numbers only. Your accountant will work out the real figures.</p>
        <dl class="tx-est">
          <div><dt>Self-employment tax</dt><dd>${esc(m(r.estimates.selfEmploymentTax))}</dd><p>15.3% on 92.35% of net income (Social Security and Medicare). Income tax comes on top.</p></div>
          <div><dt>Your set-aside${r.estimates.setAsidePct ? ` (${r.estimates.setAsidePct}%)` : ''}</dt><dd>${r.estimates.setAsidePct ? esc(m(r.estimates.setAside)) : '—'}</dd><p>${r.estimates.setAsidePct ? 'From the percentage you set in Budget.' : 'Set a tax percentage in Budget to see how much you should have put aside.'}</p></div>
          <div><dt>Late fees collected</dt><dd>${esc(m(t.lateFees))}</dd><p>Already included in income.</p></div>
        </dl>
      </section>
    </div>

    <section class="panel">
      <h2>1099 forms to expect</h2>
      <div class="tx-forms">
        <div><b>Form 1099-K from PayPal</b><p>PayPal reports payments it processed once you pass $${r.forms.k.amount.toLocaleString('en-US')} and ${r.forms.k.count} transactions in a year. This year through PayPal: <b>${esc(m(r.forms.k.paypalGross))}</b> in ${r.forms.k.paypalCount} payment${r.forms.k.paypalCount === 1 ? '' : 's'}, so ${r.forms.k.likely ? '<b>expect a 1099-K</b>' : 'you <b>probably won\'t get one</b>'}. The income is taxable either way.</p></div>
        <div><b>Form 1099-NEC from clients</b><p>A business client who paid you $${r.forms.necThreshold.toLocaleString('en-US')} or more ${r.year >= 2026 ? '(the threshold from 2026)' : ''} outside PayPal (bank transfer, cheque) usually sends one. Card and PayPal payments are reported on 1099-K instead. ${r.forms.necClients.length ? `Expect one from: <b>${r.forms.necClients.map(esc).join(', ')}</b>.` : 'None of your clients reach that this year.'}</p></div>
      </div>
    </section>

    <section class="panel" style="padding:0!important">
      <div class="sec-pad"><div><h2>By client</h2><p class="muted small" style="margin:2px 0 0">Income excludes sales tax. "Paid by bank / cash" means payments you recorded with Mark paid: they did not go through PayPal, so a business client may send you a 1099-NEC for them.</p></div></div>
      ${r.clients.length ? `<div class="table-wrap"><table class="data tx-table"><thead><tr><th>Client</th><th class="r">Invoices</th><th class="r">Paid via PayPal</th><th class="r" title="Bank transfer, cash or cheque, recorded with Mark paid">Paid by bank / cash</th><th class="r">Total income</th><th>1099-NEC</th></tr></thead><tbody>
        ${r.clients.map((c) => `<tr><td><b>${esc(c.client)}</b>${c.company ? `<br><span class="muted small">${esc(c.company)}</span>` : ''}</td><td class="r num">${c.invoices}</td><td class="r num">${esc(m(c.viaPaypal))}</td><td class="r num">${c.outside ? esc(m(c.outside)) : '<span class="muted">—</span>'}</td><td class="r num"><b>${esc(m(c.total))}</b></td><td>${c.expect1099NEC ? '<span class="pill low">Expected</span>' : '<span class="muted small">No</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="list-empty"><b>No payments this year</b><span>Paid invoices will appear here.</span></div>'}
    </section>

    <section class="panel" style="padding:0!important">
      <div class="sec-pad"><div><h2>Every payment</h2><p class="muted small" style="margin:2px 0 0">The same rows are in the CSV download.</p></div></div>
      ${r.rows.length ? `<div class="table-wrap"><table class="data tx-table"><thead><tr><th>Paid</th><th>Invoice</th><th>Client</th><th>Via</th><th class="r">Gross</th><th class="r">Sales tax</th><th class="r">PayPal fee</th><th class="r">Net</th></tr></thead><tbody>
        ${r.rows.map((x) => `<tr><td>${esc(fmtDate(x.paidDate))}</td><td>#${esc(x.number)}</td><td>${esc(x.client)}</td><td>${esc(x.via === 'PayPal' ? 'PayPal' : x.via.charAt(0).toUpperCase() + x.via.slice(1))}</td><td class="r num">${esc(m(x.gross))}</td><td class="r num">${x.salesTax ? esc(m(x.salesTax)) : '—'}</td><td class="r num muted">${x.fee ? `−${esc(m(x.fee))}` : '—'}</td><td class="r num"><b>${esc(m(x.income - x.fee))}</b></td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="4"><b>Total</b></td><td class="r num"><b>${esc(m(t.gross))}</b></td><td class="r num">${esc(m(t.salesTax))}</td><td class="r num">−${esc(m(t.fees))}</td><td class="r num"><b>${esc(m(t.net))}</b></td></tr></tfoot></table></div>` : ''}
    </section>
    ${r.otherCurrency.length ? `<p class="tx-note">Not included (other currencies): ${r.otherCurrency.map((o) => `#${esc(o.number)} ${esc(money(o.total, o.currency))}`).join(', ')}.</p>` : ''}
    <p class="tx-disc">PayPilot prepares this summary from your invoices. It is not tax advice and not an IRS form. PayPal fees are estimated at the standard US invoicing rate; your PayPal annual statement has the exact figures. Other business expenses (software, equipment, home office) are not included.</p>`;
}

$('year').addEventListener('change', () => {
  year = Number($('year').value);
  load();
});
$('print').onclick = () => window.print();
await load();
