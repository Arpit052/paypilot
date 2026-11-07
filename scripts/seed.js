// Usage: npm run seed   (add --reset to wipe existing data first)
import { resetDb, listClients, listInvoices } from '../src/db.js';
import { seedSample } from '../src/sample.js';
import { applySettings } from '../src/settings.js';

applySettings(); // use the PayPal mode chosen in Settings

if (process.argv.includes('--reset')) resetDb();
seedSample(); // tracked, so Settings → Data → Remove sample data deletes exactly these
console.log(`Seeded: ${listClients().length} clients, ${listInvoices().length} invoices.`);
