// Usage: npm run seed   (add --reset to wipe existing data first)
import { resetDb, listClients, listInvoices } from '../src/db.js';
import { seedDemo } from '../src/seed.js';

if (process.argv.includes('--reset')) resetDb();
seedDemo();
console.log(`Seeded: ${listClients().length} clients, ${listInvoices().length} invoices.`);
