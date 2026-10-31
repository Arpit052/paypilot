// Usage: npm run seed   (add --reset to wipe existing data first)
import { resetDb, db } from '../src/db.js';
import { seedDemo } from '../src/seed.js';

if (process.argv.includes('--reset')) resetDb();
seedDemo();
console.log(`Seeded: ${db().clients.length} clients, ${db().invoices.length} invoices.`);
