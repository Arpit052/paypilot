// PayPal status updates arriving twice, late, or at the same time as a poll.
// A payment must produce exactly one "Payment received" and a paid invoice must never go back to unpaid.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-sync-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.APP_TIMEZONE = 'UTC';

const { listInvoices, getInvoice, listNotifications } = await import('../src/db.js');
const { applyWebhookEvent, applyStatus } = await import('../src/sync.js');
const { seedSample } = await import('../src/sample.js');
const { isOpen } = await import('../src/analytics.js');

seedSample();
const open = listInvoices().filter((i) => i.paypalId && isOpen(i));
const payments = (inv) => listNotifications(500).filter((n) => n.kind === 'payment' && n.invoiceId === inv.id).length;
const paid = (id) => ({ event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id, status: 'PAID' } } });

test('duplicate PAID webhook gives one notification', () => {
  const inv = open[0];
  assert.equal(applyWebhookEvent(paid(inv.paypalId)).changed, true);
  assert.equal(applyWebhookEvent(paid(inv.paypalId)).changed, false);
  assert.equal(payments(inv), 1);
});

test('a poll that read the invoice before the webhook landed does not notify again', () => {
  const inv = open[1];
  const stale = { ...getInvoice(inv.id) }; // poll loaded it, then awaited PayPal…
  applyWebhookEvent(paid(inv.paypalId)); // …while the webhook marked it paid
  assert.equal(applyStatus(stale, 'PAID', null), false);
  assert.equal(payments(inv), 1);
});

test('a late SENT / UPDATED event never turns a paid invoice back to unpaid', () => {
  const inv = open[0];
  applyWebhookEvent({ event_type: 'INVOICING.INVOICE.UPDATED', resource: { invoice: { id: inv.paypalId, status: 'SENT' } } });
  applyWebhookEvent({ event_type: 'INVOICING.INVOICE.UPDATED', resource: { invoice: { id: inv.paypalId, status: 'PARTIALLY_PAID' } } });
  assert.equal(getInvoice(inv.id).status, 'PAID');
});

test('a refund after payment is still recorded', () => {
  const inv = open[1];
  applyWebhookEvent({ event_type: 'INVOICING.INVOICE.REFUNDED', resource: { invoice: { id: inv.paypalId, status: 'REFUNDED' } } });
  assert.equal(getInvoice(inv.id).status, 'REFUNDED');
});

test('a cancelled invoice is not reopened by a stale SENT event', () => {
  const inv = open[2];
  applyWebhookEvent({ event_type: 'INVOICING.INVOICE.CANCELLED', resource: { invoice: { id: inv.paypalId, status: 'CANCELLED' } } });
  applyWebhookEvent({ event_type: 'INVOICING.INVOICE.UPDATED', resource: { invoice: { id: inv.paypalId, status: 'SENT' } } });
  assert.equal(getInvoice(inv.id).status, 'CANCELLED');
});

test('webhooks for unknown invoices and other event types are ignored', () => {
  assert.equal(applyWebhookEvent(paid('INV2-NOPE')).ignored, true);
  assert.equal(applyWebhookEvent({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }).ignored, true);
  assert.equal(applyWebhookEvent(null).ignored, true);
});
