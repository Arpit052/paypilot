// A business describes what it sells in its own words; PayPilot reads it into a profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-biz-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.DEFAULT_CURRENCY = 'USD';
process.env.SCHEDULER_INTERVAL_MIN = '0';
process.env.APP_TIMEZONE = 'UTC';

const { start } = await import('../server.js');
const { setLlmOverride } = await import('../src/llm.js');
const { ruleProfile, cleanProfile } = await import('../src/bizprofile.js');
const { areaOf } = await import('../src/growth.js');
const { listInvoices, resetDb } = await import('../src/db.js');
const server = await start(0);
const base = `http://localhost:${server.address().port}`;
const call = async (p, body) => {
  const res = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: res.status, data: await res.json() };
};
test.after(() => server.close());

const DESC = 'Commercial cleaning, deep cleans and window washing for offices and clinics in Austin';
const AI = {
  label: 'Commercial cleaning company',
  summary: 'Cleans offices and clinics in Austin on a schedule or as one-off deep cleans.',
  customers: 'offices and medical clinics',
  preset: 'other',
  areas: [
    { name: 'Office cleaning', keywords: ['office clean', 'janitorial', 'nightly'] },
    { name: 'Deep cleans', keywords: ['deep clean', 'move-out', 'post-construction'] },
    { name: 'Windows', keywords: ['window', 'glass'] },
  ],
  items: [{ name: 'Nightly office clean (per visit)', price: 140 }, { name: 'Deep clean (per 1,000 sq ft)', price: 180 }, { name: 'Window washing', price: 260 }, { name: 'Supplies and consumables', price: 60 }],
  retainer: 'Monthly cleaning contract',
  demo: {
    retainer: ['Monthly cleaning contract, 3 visits a week', 1, 1850],
    frequent: [[['Deep clean (per 1,000 sq ft)', 3, 180]], [['Window washing', 1, 260]], [['Carpet shampoo', 1, 320], ['Supplies and consumables', 1, 60]], [['Post-event clean', 1, 410]]],
    marcus: [[['Post-construction clean', 1, 2400]], [['Office deep clean', 1, 980]], [['Window washing, 3 floors', 1, 760]], [['Nightly office clean (per visit)', 12, 140]]],
    william: [[['Clinic disinfection', 1, 1200]], [['Window washing', 1, 260]], [['Deep clean (per 1,000 sq ft)', 4, 180]], [['Floor strip and wax', 1, 690]]],
    sofia: [[['Exam room clean', 6, 45]], [['Window washing', 1, 260]], [['Waiting room deep clean', 1, 380]]],
    daniel: [[['Move-out clean', 1, 340]]],
  },
};

test('without AI, the sentence is split into the kinds of work it lists', () => {
  const p = ruleProfile(DESC);
  assert.equal(p.by, 'rules');
  assert.deepEqual(p.areas.map((a) => a.name), ['Commercial cleaning', 'Deep cleans', 'Window washing']);
  assert.match(p.customers, /offices and clinics/);
  assert.ok(p.items.length >= 2);
});

test('bad or partial AI output falls back to the rules, never breaks', () => {
  assert.equal(cleanProfile(null, DESC).by, 'rules');
  const p = cleanProfile({ label: 'Cleaning', areas: 'nope', items: [{ name: 'x', price: -5 }], demo: { retainer: 'x' } }, DESC);
  assert.equal(p.label, 'Cleaning');
  assert.equal(p.areas.length, 3, 'rule areas kept');
  assert.equal(p.demo, null, 'no half-made demo');
});

test('a business onboarding with its own description gets an AI profile used across the app', async () => {
  resetDb();
  let asked = '';
  setLlmOverride(async ({ messages }) => {
    asked = messages[0].content[0].text;
    return { content: [{ type: 'text', text: JSON.stringify(AI) }] };
  });
  const r = await call('/api/settings/paypal/demo', { businessName: 'Brightline Facility Care', accountType: 'business', teamSize: '11-50', businessDescription: DESC });
  setLlmOverride(null);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(asked.includes('Commercial cleaning'), 'the AI read the owner\'s own words');
  const cfg = (await call('/api/config')).data;
  assert.equal(cfg.businessTypeLabel, 'Commercial cleaning company');
  assert.equal(cfg.retainerWord, 'monthly cleaning contract');
  assert.deepEqual(cfg.typeItems.map((i) => i.name).slice(0, 2), ['Nightly office clean (per visit)', 'Deep clean (per 1,000 sq ft)']);
  // the demo book is this business's work, not a designer's
  const names = listInvoices().flatMap((i) => i.items.map((x) => x.name));
  assert.ok(names.includes('Post-construction clean'));
  assert.ok(!names.some((n) => /logo|brand identity/i.test(n)));
  // the Growth page groups lines by the business's own kinds of work
  assert.equal(areaOf('Office deep clean'), 'Deep cleans');
  assert.equal(areaOf('Window washing, 3 floors'), 'Windows');
  const s = (await call('/api/settings')).data.business;
  assert.equal(s.businessDescription, DESC);
  assert.equal(s.profile.by, 'ai');
});

test('editing the description in Settings reads it again; switching to freelancer drops it', async () => {
  setLlmOverride(async () => ({ content: [{ type: 'text', text: JSON.stringify({ ...AI, label: 'Office cleaning company' }) }] }));
  const r = await call('/api/settings/business', { businessDescription: 'Office cleaning for law firms' });
  setLlmOverride(null);
  assert.equal(r.status, 200);
  assert.equal(r.data.profile.label, 'Office cleaning company');
  assert.equal((await call('/api/config')).data.businessTypeLabel, 'Office cleaning company');
  await call('/api/settings/business', { accountType: 'freelancer', businessType: 'web_developer', applyPreset: true, businessDescription: '' });
  const cfg = (await call('/api/config')).data;
  assert.equal(cfg.businessTypeLabel, 'Web Developer');
  assert.equal((await call('/api/settings')).data.business.profile, null);
});

test('a slow AI does not hold up onboarding; the sample book is redone when it answers', async () => {
  resetDb();
  process.env.BUSINESS_AI_WAIT_MS = '60';
  setLlmOverride(async ({ messages }) => {
    await new Promise((r) => setTimeout(r, 250));
    const t = messages[0].content[0].text;
    return { content: [{ type: 'text', text: JSON.stringify(t.includes('sample invoice lines') ? AI.demo : { ...AI, demo: undefined }) }] };
  });
  const t0 = Date.now();
  const r = await call('/api/settings/paypal/demo', { businessName: 'Brightline', accountType: 'business', businessDescription: 'Pool cleaning, repairs and chemical balancing for homes and hotels' });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 1500, 'answered without waiting for the AI');
  const before = listInvoices().flatMap((i) => i.items.map((x) => x.name));
  assert.ok(before.some((n) => /Pool cleaning|Repairs|Chemical balancing/.test(n)), `placeholder work from the sentence: ${before.slice(0, 3)}`);
  await new Promise((r) => setTimeout(r, 1200));
  setLlmOverride(null);
  delete process.env.BUSINESS_AI_WAIT_MS;
  const after = listInvoices().flatMap((i) => i.items.map((x) => x.name));
  assert.ok(after.includes('Post-construction clean'), 'AI sample work swapped in');
  const notes = (await call('/api/notifications')).data;
  assert.ok(JSON.stringify(notes).includes('Sample invoices now fit your business'));
});
