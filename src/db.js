// SQLite data layer (Node's built-in node:sqlite - no native modules to compile).
// Small repository API so the rest of the app never writes SQL.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { config } from './config.js';

// node:sqlite prints an "experimental" warning on some Node versions - keep the console clean.
const origEmit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...rest));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
process.emitWarning = origEmit;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  paypal_id TEXT UNIQUE,
  number TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id),
  items TEXT NOT NULL,
  currency TEXT NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  paid_date TEXT,
  note TEXT,
  payer_url TEXT,
  reminders TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'paypal',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  summary TEXT,
  payload TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

let conn = null;
function sql() {
  if (conn) return conn;
  fs.mkdirSync(config.dataDir, { recursive: true });
  conn = new DatabaseSync(path.join(config.dataDir, 'paypilot.db'));
  conn.exec(SCHEMA);
  return conn;
}

const nowIso = () => new Date().toISOString();
const j = (v) => (v === undefined ? null : JSON.stringify(v));
const pj = (v, d = null) => {
  if (v == null) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

export function transaction(fn) {
  const d = sql();
  d.exec('BEGIN');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function resetDb() {
  sql().exec('DELETE FROM actions; DELETE FROM invoices; DELETE FROM clients; DELETE FROM activity; DELETE FROM kv;');
}

// ---------------- clients ----------------
const rowClient = (r) => r && { id: r.id, name: r.name, email: r.email, createdAt: r.created_at };

export function listClients() {
  return sql().prepare('SELECT * FROM clients ORDER BY name').all().map(rowClient);
}

export function getClient(id) {
  return rowClient(sql().prepare('SELECT * FROM clients WHERE id = ?').get(id));
}

export function findClient(ref) {
  if (!ref) return null;
  const q = String(ref).trim();
  const d = sql();
  return rowClient(
    d.prepare('SELECT * FROM clients WHERE id = ? OR email = ? COLLATE NOCASE OR name = ? COLLATE NOCASE LIMIT 1').get(q, q, q) ||
      d.prepare("SELECT * FROM clients WHERE name LIKE '%' || ? || '%' COLLATE NOCASE ORDER BY length(name) LIMIT 1").get(q)
  );
}

export function upsertClient({ name, email }) {
  const d = sql();
  const existing = d.prepare('SELECT * FROM clients WHERE email = ? COLLATE NOCASE').get(email);
  if (existing) {
    if (name && name !== existing.name) d.prepare('UPDATE clients SET name = ? WHERE id = ?').run(name, existing.id);
    return getClient(existing.id);
  }
  const id = newId('cli');
  d.prepare('INSERT INTO clients (id, name, email, created_at) VALUES (?, ?, ?, ?)').run(id, name, email, nowIso());
  return getClient(id);
}

// ---------------- invoices ----------------
const rowInvoice = (r) =>
  r && {
    id: r.id,
    paypalId: r.paypal_id,
    number: r.number,
    clientId: r.client_id,
    items: pj(r.items, []),
    currency: r.currency,
    total: r.total,
    status: r.status,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    paidDate: r.paid_date,
    note: r.note || '',
    payerUrl: r.payer_url,
    reminders: pj(r.reminders, []),
    source: r.source,
  };

const INV_COLS = {
  paypalId: 'paypal_id', number: 'number', clientId: 'client_id', items: 'items', currency: 'currency', total: 'total',
  status: 'status', issueDate: 'issue_date', dueDate: 'due_date', paidDate: 'paid_date', note: 'note',
  payerUrl: 'payer_url', reminders: 'reminders', source: 'source',
};
const JSON_FIELDS = new Set(['items', 'reminders', 'payload', 'result']);

export function listInvoices({ clientId } = {}) {
  const d = sql();
  const rows = clientId
    ? d.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY issue_date DESC, created_at DESC').all(clientId)
    : d.prepare('SELECT * FROM invoices ORDER BY issue_date DESC, created_at DESC').all();
  return rows.map(rowInvoice);
}

export function getInvoice(id) {
  return rowInvoice(sql().prepare('SELECT * FROM invoices WHERE id = ?').get(id));
}

export function getInvoiceByPaypalId(paypalId) {
  return rowInvoice(sql().prepare('SELECT * FROM invoices WHERE paypal_id = ?').get(paypalId));
}

export function findInvoice(ref) {
  if (!ref) return null;
  const q = String(ref).trim().replace(/^#/, '');
  return rowInvoice(
    sql().prepare('SELECT * FROM invoices WHERE id = ? OR paypal_id = ? OR number = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1').get(ref, ref, q)
  );
}

export function insertInvoice(inv) {
  const id = inv.id || newId('inv');
  sql()
    .prepare(
      `INSERT INTO invoices (id, paypal_id, number, client_id, items, currency, total, status, issue_date, due_date,
        paid_date, note, payer_url, reminders, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, inv.paypalId ?? null, String(inv.number), inv.clientId, j(inv.items), inv.currency, inv.total, inv.status,
      inv.issueDate, inv.dueDate, inv.paidDate ?? null, inv.note ?? '', inv.payerUrl ?? null, j(inv.reminders || []),
      inv.source || 'paypal', nowIso()
    );
  return getInvoice(id);
}

function update(table, cols, id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = cols[k];
    if (!col) throw new Error(`Unknown field ${k}`);
    sets.push(`${col} = ?`);
    vals.push(JSON_FIELDS.has(k) ? j(v) : v ?? null);
  }
  if (sets.length) sql().prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

export function updateInvoice(id, patch) {
  update('invoices', INV_COLS, id, patch);
  return getInvoice(id);
}

// ---------------- actions ----------------
const rowAction = (r) =>
  r && {
    id: r.id,
    type: r.type,
    status: r.status,
    origin: r.origin,
    summary: r.summary,
    payload: pj(r.payload, {}),
    result: pj(r.result),
    error: r.error,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
const ACT_COLS = { status: 'status', payload: 'payload', result: 'result', error: 'error', decidedAt: 'decided_at', summary: 'summary' };

export function insertAction({ type, origin = 'chat', summary, payload }) {
  const id = newId('act');
  sql()
    .prepare('INSERT INTO actions (id, type, status, origin, summary, payload, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, type, 'pending', origin, summary ?? null, j(payload), nowIso());
  return getAction(id);
}

export function getAction(id) {
  return rowAction(sql().prepare('SELECT * FROM actions WHERE id = ?').get(id));
}

export function listActions({ status, origin, type } = {}) {
  const where = [];
  const vals = [];
  if (status) where.push('status = ?') && vals.push(status);
  if (origin) where.push('origin = ?') && vals.push(origin);
  if (type) where.push('type = ?') && vals.push(type);
  return sql()
    .prepare(`SELECT * FROM actions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC`)
    .all(...vals)
    .map(rowAction);
}

export function updateAction(id, patch) {
  update('actions', ACT_COLS, id, patch);
  return getAction(id);
}

/** Atomically move an action from one status to another. Returns false if it wasn't in `from`. */
export function transitionAction(id, from, to) {
  const r = sql().prepare('UPDATE actions SET status = ? WHERE id = ? AND status = ?').run(to, id, from);
  return r.changes === 1;
}

// ---------------- activity ----------------
export function logActivity(kind, text) {
  sql().prepare('INSERT INTO activity (at, kind, text) VALUES (?,?,?)').run(nowIso(), kind, text);
}

export function listActivity(limit = 15) {
  return sql().prepare('SELECT at, kind, text FROM activity ORDER BY id DESC LIMIT ?').all(limit);
}

// ---------------- key/value (mock PayPal state etc.) ----------------
export function kvGet(key, fallback = null) {
  const r = sql().prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return r ? pj(r.value, fallback) : fallback;
}

export function kvSet(key, value) {
  sql().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, j(value));
}
