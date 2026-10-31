// Tiny JSON-file datastore. Good enough for a single-user demo app,
// zero native dependencies, works on any host.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const EMPTY = () => ({ clients: [], invoices: [], actions: [], activity: [] });

let state = null;
let file = null;

function load() {
  if (state) return state;
  file = path.join(config.dataDir, 'db.json');
  try {
    state = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    state = EMPTY();
  }
  return state;
}

export function save() {
  load();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function db() {
  return load();
}

export function resetDb() {
  state = EMPTY();
  save();
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

export function logActivity(kind, text) {
  const s = load();
  s.activity.unshift({ at: new Date().toISOString(), kind, text });
  s.activity = s.activity.slice(0, 200);
  save();
}

// ---------- clients ----------
export function findClient(ref) {
  if (!ref) return null;
  const s = load();
  const q = String(ref).trim().toLowerCase();
  return (
    s.clients.find((c) => c.id === ref) ||
    s.clients.find((c) => c.email.toLowerCase() === q) ||
    s.clients.find((c) => c.name.toLowerCase() === q) ||
    s.clients.find((c) => c.name.toLowerCase().includes(q)) ||
    null
  );
}

export function upsertClient({ name, email }) {
  const s = load();
  let c = s.clients.find((x) => x.email.toLowerCase() === email.toLowerCase());
  if (c) {
    if (name) c.name = name;
  } else {
    c = { id: newId('cli'), name, email, createdAt: new Date().toISOString() };
    s.clients.push(c);
  }
  save();
  return c;
}

// ---------- invoices ----------
export function findInvoice(ref) {
  if (!ref) return null;
  const s = load();
  const q = String(ref).trim().replace(/^#/, '').toLowerCase();
  return (
    s.invoices.find((i) => i.id === ref || i.paypalId === ref) ||
    s.invoices.find((i) => String(i.number).toLowerCase() === q) ||
    null
  );
}
