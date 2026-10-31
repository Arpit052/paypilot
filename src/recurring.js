// Recurring invoices. A due schedule never sends anything on its own: it creates a normal
// invoice draft (pending action) that lands in the approval tray, like everything else.
import { isoDate, addDays, addMonths } from './config.js';
import { listSchedules, updateSchedule, getClient, logActivity } from './db.js';
import { createAction, normaliseInvoiceDraft } from './actions.js';

export function nextRunAfter(date, frequency, today) {
  let next = date;
  do next = frequency === 'weekly' ? addDays(next, 7) : addMonths(next, 1);
  while (next <= today);
  return next;
}

/** Create drafts for every active schedule that is due. Returns the created actions. */
export function runRecurring(today = isoDate()) {
  const created = [];
  for (const sc of listSchedules()) {
    if (!sc.active || sc.nextRun > today) continue;
    const client = getClient(sc.clientId);
    if (!client) continue;
    const draft = normaliseInvoiceDraft({
      clientName: client.name,
      clientEmail: client.email,
      items: sc.items,
      currency: sc.currency,
      taxPercent: sc.taxPercent,
      dueInDays: sc.dueInDays,
      note: sc.note,
    });
    draft.scheduleId = sc.id;
    created.push(
      createAction('create_invoice', draft, {
        origin: 'schedule',
        summary: `Recurring invoice ${client.name} · ${draft.currency} ${draft.total}`,
      })
    );
    // missed periods are skipped, not back-filled: one draft per run
    updateSchedule(sc.id, { nextRun: nextRunAfter(sc.nextRun, sc.frequency, today), lastRun: today });
    logActivity('schedule_run', `Recurring invoice for ${client.name} is ready for your approval`);
  }
  return created;
}
