// Sample data: what PayPilot loads so a new account isn't empty, tracked so it can be removed
// in one click without touching anything the owner created themselves.
//
// Demo mode loads the full sample book. A real (PayPal-connected) account starts empty unless
// the owner ticks "Add a few sample invoices" at setup.
import { listInvoices, listClients, listSchedules, listActions, kvGet, kvSet, kvDel, kvList, transaction, deleteClient, deleteInvoice, deleteSchedule, deleteAction, logActivity } from './db.js';
import { seedDemo } from './seed.js';

const KEY = 'sample:ids';

/** Load the sample book and remember exactly which rows it created. */
export function seedSample() {
  const before = { inv: new Set(listInvoices().map((i) => i.id)), cli: new Set(listClients().map((c) => c.id)), sch: new Set(listSchedules().map((s) => s.id)) };
  seedDemo();
  const ids = {
    invoices: listInvoices().filter((i) => !before.inv.has(i.id)).map((i) => i.id),
    clients: listClients().filter((c) => !before.cli.has(c.id)).map((c) => c.id),
    schedules: listSchedules().filter((s) => !before.sch.has(s.id)).map((s) => s.id),
    at: new Date().toISOString(),
  };
  kvSet(KEY, ids);
  return ids;
}

/** How much sample data is still there. Older installs (before tracking) are found by source. */
export function sampleInfo() {
  const ids = kvGet(KEY);
  const inv = new Set(listInvoices().map((i) => i.id));
  if (ids) {
    const left = ids.invoices.filter((id) => inv.has(id));
    const cli = new Set(listClients().map((c) => c.id));
    return { count: left.length, clients: ids.clients.filter((id) => cli.has(id)).length, tracked: true };
  }
  const seeded = listInvoices().filter((i) => i.source === 'seed');
  return { count: seeded.length, clients: new Set(seeded.map((i) => i.clientId)).size, tracked: false };
}

/**
 * Remove the sample invoices, and the sample clients and retainers once nothing of yours uses
 * them. A sample client you have since billed for real is kept, with only your invoices.
 */
export function removeSample() {
  const ids = kvGet(KEY) || { invoices: listInvoices().filter((i) => i.source === 'seed').map((i) => i.id), clients: [], schedules: [] };
  const drop = new Set(ids.invoices);
  let invoices = 0, clients = 0;
  transaction(() => {
    for (const i of listInvoices()) {
      if (!drop.has(i.id)) continue;
      deleteInvoice(i.id);
      for (const k of ['receipt', 'delivery', 'earlypay', 'paidVia']) {
        const v = kvGet(`${k}:${i.id}`);
        if (k === 'receipt' && v?.token) kvDel(`rtoken:${v.token}`);
        if (k === 'delivery' && v?.token) kvDel(`dtoken:${v.token}`);
        kvDel(`${k}:${i.id}`);
      }
      invoices++;
    }
    for (const sid of ids.schedules || []) deleteSchedule(sid);
    const stillUsed = new Set(listInvoices().map((i) => i.clientId));
    for (const cid of ids.clients || []) {
      if (stillUsed.has(cid)) continue;
      deleteClient(cid);
      clients++;
    }
    // drafts about invoices that no longer exist
    const alive = new Set(listInvoices().map((i) => i.id));
    for (const a of listActions({ status: 'pending' })) if (a.payload?.invoiceId && !alive.has(a.payload.invoiceId)) deleteAction(a.id);
  });
  kvDel(KEY);
  for (const k of kvList('growth:')) kvDel(k.key);
  logActivity('sample_removed', `Sample data removed: ${invoices} invoices, ${clients} clients`);
  return { ok: true, invoices, clients };
}
