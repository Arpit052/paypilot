// Time tracking: a live start/stop timer (one at a time) plus manual entries.
// Unbilled hours turn into a normal invoice draft that still needs approval.
import { config, isoDate } from './config.js';
import {
  insertTimeEntry,
  getRunningTimer,
  finishTimeEntry,
  listTimeEntries,
  getTimeEntry,
  markTimeBilled,
  deleteTimeEntry,
  getClient,
  findClient,
  upsertClient,
  kvGet,
  kvSet,
  logActivity,
} from './db.js';
import { createAction, normaliseInvoiceDraft } from './actions.js';

const DEFAULT_RATE = Number(process.env.DEFAULT_HOURLY_RATE || 50);
const r2 = (n) => Math.round(n * 100) / 100;
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Resolve a client by id, name or email; create one if a new name + email is given. */
function resolveClient({ clientId, clientName, clientEmail }) {
  const c = (clientId && getClient(clientId)) || findClient(clientEmail) || findClient(clientName);
  if (c) return c;
  if (clientName && clientEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clientEmail)) return upsertClient({ name: clientName.trim(), email: clientEmail.trim() });
  throw httpError(400, 'Pick a client (or give a new client name and email).');
}

export function rateFor(clientId) {
  return kvGet(`rate:${clientId}`, DEFAULT_RATE);
}

function withClient(e) {
  return e && { ...e, client: getClient(e.clientId)?.name || 'Unknown', value: e.minutes ? r2((e.minutes / 60) * e.hourlyRate) : null };
}

export function runningTimer() {
  return withClient(getRunningTimer());
}

/** Start a timer (stops any timer that's already running). */
export function startTimer(input) {
  const client = resolveClient(input);
  const task = String(input.task || '').trim().slice(0, 200) || 'Client work';
  const hourlyRate = Number(input.hourlyRate) > 0 ? r2(Number(input.hourlyRate)) : rateFor(client.id);
  const stopped = getRunningTimer() ? stopTimer() : null;
  kvSet(`rate:${client.id}`, hourlyRate);
  const e = insertTimeEntry({ clientId: client.id, task, startedAt: new Date().toISOString(), hourlyRate });
  return { running: withClient(e), stopped };
}

export function stopTimer() {
  const e = getRunningTimer();
  if (!e) throw httpError(409, 'No timer is running.');
  const end = new Date();
  const minutes = Math.max(1, Math.ceil((end - new Date(e.startedAt)) / 60000));
  const done = withClient(finishTimeEntry(e.id, end.toISOString(), minutes));
  logActivity('time_tracked', `Tracked ${fmtHours(minutes)} for ${done.client} (${done.task})`);
  return done;
}

export function addManualEntry(input) {
  const client = resolveClient(input);
  const hours = Number(input.hours);
  if (!(hours > 0 && hours <= 24)) throw httpError(400, 'Hours must be between 0 and 24.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : isoDate();
  const hourlyRate = Number(input.hourlyRate) > 0 ? r2(Number(input.hourlyRate)) : rateFor(client.id);
  kvSet(`rate:${client.id}`, hourlyRate);
  const minutes = Math.round(hours * 60);
  const start = new Date(`${date}T09:00:00Z`);
  const e = insertTimeEntry({
    clientId: client.id,
    task: String(input.task || '').trim().slice(0, 200) || 'Client work',
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + minutes * 60000).toISOString(),
    minutes,
    hourlyRate,
  });
  return withClient(e);
}

export function listEntries(limit = 50) {
  return listTimeEntries({ limit }).map(withClient);
}

export function removeEntry(id) {
  const e = getTimeEntry(id);
  if (!e) throw httpError(404, 'Entry not found');
  if (e.billedInvoiceId) throw httpError(409, 'This time is already on an invoice.');
  deleteTimeEntry(id);
  return { ok: true };
}

export function fmtHours(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Group entries into invoice lines (task + rate), hours rounded to 2 decimals. */
function toLines(entries) {
  const lines = new Map();
  for (const e of entries) {
    const key = `${e.task}|${e.hourlyRate}`;
    const l = lines.get(key) || { name: e.task, minutes: 0, unitPrice: e.hourlyRate };
    l.minutes += e.minutes;
    lines.set(key, l);
  }
  return [...lines.values()].map((l) => ({ name: `${l.name} (hours)`, quantity: r2(l.minutes / 60), unitPrice: l.unitPrice }));
}

/** Unbilled time grouped by client (value uses the same rounding as the invoice). */
export function unbilledTime() {
  const groups = new Map();
  for (const e of listTimeEntries({ limit: 1000, unbilledOnly: true })) {
    const g = groups.get(e.clientId) || { clientId: e.clientId, client: getClient(e.clientId)?.name || 'Unknown', minutes: 0, list: [], entries: [] };
    g.minutes += e.minutes;
    g.list.push(e);
    g.entries.push(e.id);
    groups.set(e.clientId, g);
  }
  return [...groups.values()]
    .map(({ list, ...g }) => ({
      ...g,
      hours: r2(g.minutes / 60),
      value: r2(toLines(list).reduce((s, l) => s + r2(l.quantity * l.unitPrice), 0)),
      currency: config.currency,
    }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Turn a client's unbilled time into an invoice draft (pending approval).
 * Lines are grouped by task and rate; quantity = hours.
 */
export function proposeInvoiceFromTime({ clientId, clientName, dueInDays, origin = 'chat' }) {
  const client = resolveClient({ clientId, clientName });
  const entries = listTimeEntries({ limit: 1000, unbilledOnly: true, clientId: client.id });
  if (!entries.length) throw httpError(400, `There is no unbilled time for ${client.name}.`);
  const items = toLines(entries);
  const draft = normaliseInvoiceDraft({ clientName: client.name, clientEmail: client.email, items, dueInDays });
  draft.timeEntryIds = entries.map((e) => e.id);
  draft.note = `Hours tracked with PayPilot (${entries.length} session${entries.length > 1 ? 's' : ''}).`;
  const action = createAction('create_invoice', draft, { origin, summary: `Time invoice ${client.name} · ${draft.currency} ${draft.total}` });
  return { action, hours: r2(entries.reduce((s, e) => s + e.minutes, 0) / 60), total: draft.total };
}

/** Called after the invoice is sent: lock the time entries to that invoice. */
export function billTimeEntries(ids, invoiceId) {
  return markTimeBilled(ids || [], invoiceId);
}
