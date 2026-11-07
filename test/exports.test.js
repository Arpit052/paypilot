// Phase 7/9: exports a user opens in Excel or Google Sheets must not run formulas from client data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-csv-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.APP_TIMEZONE = 'UTC';

const { upsertClient, insertInvoice } = await import('../src/db.js');
const { invoicesCsv } = await import('../src/analytics.js');
const { taxCsv } = await import('../src/tax.js');
const { isoDate } = await import('../src/config.js');

const evil = ['=HYPERLINK("http://x.example","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=1'];
const today = isoDate();
evil.forEach((name, k) => {
  const c = upsertClient({ name: `${name}`, email: `e${k}@example.com`, company: name });
  insertInvoice({ paypalId: null, number: `E${k}`, clientId: c.id, items: [{ name, quantity: 1, unitPrice: 10 }], currency: 'USD', total: 10, status: 'PAID', issueDate: today, dueDate: today, paidDate: today, note: name, reminders: [], source: 'manual' });
});

const cells = (csv) => csv.trim().split(/\r?\n/).slice(1).flatMap((line) => line.match(/("([^"]|"")*"|[^,]*)/g).filter((x, i, a) => !(x === '' && a[i - 1] !== undefined && a[i - 1] !== '')));
const unquote = (c) => (c.startsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c);

for (const [name, make] of [['invoices.csv', () => invoicesCsv()], ['tax.csv', () => taxCsv(Number(today.slice(0, 4)))]]) {
  test(`${name}: no cell starts with a formula character`, () => {
    for (const c of cells(make()).map(unquote)) {
      if (/^-?\d+(\.\d+)?$/.test(c)) continue; // plain numbers stay numbers
      assert.doesNotMatch(c, /^[=+\-@\t\r]/, `dangerous cell: ${c}`);
    }
  });
}
