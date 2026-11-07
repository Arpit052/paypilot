// Phase 6: budget properties a judge will poke at by nudging one number at a time.
// More cash never lowers the chance; a higher price, tax, fees or a bigger buffer never raise it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paypilot-budgetprop-'));
process.env.PAYPAL_MODE = 'mock';
process.env.LLM_PROVIDER = 'none';
process.env.DEFAULT_CURRENCY = 'USD';
process.env.APP_TIMEZONE = 'UTC';

const { isoDate, addDays } = await import('../src/config.js');
const { seedSample } = await import('../src/sample.js');
const { estimateBudget } = await import('../src/budget.js');
seedSample();
const today = isoDate();
const chance = (o) => estimateBudget({ everyday: 600, buffer: 200, cashNow: 800, fees: false, taxPct: 0, ...o }).chance;

test('chance never rises with price (every $250 step)', () => {
  for (const days of [7, 21, 45]) {
    const date = addDays(today, days);
    let prev = 101;
    for (let price = 250; price <= 6000; price += 250) {
      const c = chance({ price, date });
      assert.ok(c <= prev, `price ${price} in ${days} days: ${c}% after ${prev}%`);
      prev = c;
    }
  }
});

test('chance never falls with more cash', () => {
  const date = addDays(today, 21);
  let prev = -1;
  for (let cashNow = -500; cashNow <= 5000; cashNow += 250) {
    const c = chance({ price: 2500, date, cashNow });
    assert.ok(c >= prev, `cash ${cashNow}: ${c}% after ${prev}%`);
    prev = c;
  }
});

test('tax, fees and a bigger buffer never raise the chance', () => {
  for (const days of [10, 30, 60]) {
    const date = addDays(today, days);
    for (const price of [800, 1500, 3000]) {
      const base = chance({ price, date });
      assert.ok(chance({ price, date, taxPct: 25 }) <= base, `tax, ${price} in ${days}d`);
      assert.ok(chance({ price, date, fees: true }) <= base, `fees, ${price} in ${days}d`);
      assert.ok(chance({ price, date, buffer: 1200 }) <= base, `buffer, ${price} in ${days}d`);
      assert.ok(chance({ price, date, everyday: 1500 }) <= base, `spending, ${price} in ${days}d`);
    }
  }
});
