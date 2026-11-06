// Forgot the passcode? Run this on the computer where PayPilot runs: it removes the
// passcode set in the app (a passcode from APP_PASSWORD in .env must be changed there).
import { kvSet } from '../src/db.js';
kvSet('settings:security', null);
console.log('\n  Passcode removed. Open PayPilot and set a new one in Settings -> Security.\n');
