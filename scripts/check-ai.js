// AI doctor: finds a Gemini model + thinking setting that works with tool calling
// on THIS machine and writes it into .env.  Usage: node scripts/check-ai.js
import fs from 'node:fs';
import path from 'node:path';
import { config, envFile } from '../src/config.js';

const log = (...a) => console.log(...a);
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function bye(code = 0) {
  log('');
  process.exit(code);
}

async function call(url, opts = {}, timeoutMs = 45000) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, secs: (Date.now() - t0) / 1000 };
  } catch (e) {
    const secs = (Date.now() - t0) / 1000;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { status: 'TIMEOUT', secs };
    return { status: 'NETWORK', error: e.cause?.code || e.message, secs };
  }
}

function versionScore(name) {
  const m = name.match(/gemini-(\d+)(?:\.(\d+))?/);
  return m ? Number(m[1]) * 100 + Number(m[2] || 0) : 0;
}

function updateEnv(values) {
  const file = path.join(config.root, envFile || '.env');
  let text = '';
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
    else text = buf.toString('utf8');
    text = text.replace(/^﻿/, '');
  }
  const drop = new Set([...Object.keys(values), 'OPENAI_MODEL', 'OPENAI_BASE_URL']);
  const kept = text
    .split(/\r?\n/)
    .filter((l) => {
      const k = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
      return !(k && drop.has(k)) && l.trim() !== '';
    });
  for (const [k, v] of Object.entries(values)) kept.push(`${k}=${v}`);
  fs.writeFileSync(file, kept.join('\r\n') + '\r\n', 'utf8');
  return file;
}

log('\n  PayPilot AI check');
log('  =================\n');

// 1. settings file + key
log(`  .env file:  ${envFile ? 'found (' + envFile + ')' : 'NOT FOUND in ' + config.root}`);
const key = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '';
if (!key) {
  log('  API key:    NOT FOUND\n');
  log('  Fix: .env file mein yeh line daalo (apni Google AI Studio key ke saath):');
  log('       GEMINI_API_KEY=AIza...');
  bye(1);
}
if (key.startsWith('sk-')) {
  log('  API key:    found, but it is an OpenAI key (starts with "sk-"), not a Google key\n');
  log('  Fix: aistudio.google.com se key copy karke .env mein daalo:  GEMINI_API_KEY=...');
  bye(1);
}
log(`  API key:    found (${key.slice(0, 4)}...${key.slice(-4)})`);

// 2. list models (also validates the key + network)
log('\n  Google se baat kar raha hoon...');
const list = await call(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } }, 25000);
if (list.status !== 200) {
  if (list.status === 'TIMEOUT' || list.status === 'NETWORK') {
    log(`  Google tak nahi pahunch paya (${list.status}${list.error ? ': ' + list.error : ''}).`);
    log('  Fix: internet check karo, ya phone hotspot se try karo.');
  } else {
    log(`  Google ne key reject ki (HTTP ${list.status}): ${list.json?.error?.message || ''}`);
    log('  Fix: aistudio.google.com par nayi API key banao aur .env mein daalo.');
  }
  bye(1);
}
const available = (list.json.models || [])
  .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
  .map((m) => m.name.replace(/^models\//, ''))
  .filter((n) => /flash/.test(n) && !/(image|tts|live|audio|embedding|native|thinking-exp|robotics|computer)/.test(n));
log(`  Key sahi hai. ${available.length} flash models mile.`);

const preferred = config.llm.geminiModel;
const candidates = [...new Set([preferred, ...available.sort((a, b) => versionScore(b) - versionScore(a) || a.length - b.length)])]
  .filter((n) => available.includes(n) || n === preferred)
  .slice(0, 6);

// 3. try a real tool call with each model / thinking setting
const tool = {
  functionDeclarations: [
    { name: 'ping', description: 'Health check. Always call this when asked to ping.', parametersJsonSchema: { type: 'object', properties: { note: { type: 'string' } } } },
  ],
};
log('\n  Har model ko ek chhota test bhej raha hoon (har test max 45 sec)...\n');
let winner = null;
for (const model of candidates) {
  for (const thinking of ['low', 'off']) {
    const generationConfig = { maxOutputTokens: 512 };
    if (thinking !== 'off') generationConfig.thinkingConfig = { thinkingLevel: thinking };
    process.stdout.write(`  ${model.padEnd(28)} thinking=${thinking.padEnd(4)} ... `);
    const r = await call(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You are a test bot.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Please ping.' }] }],
        tools: [tool],
        generationConfig,
      }),
    });
    const parts = r.json?.candidates?.[0]?.content?.parts || [];
    const gotTool = parts.some((p) => p.functionCall);
    const gotText = parts.some((p) => p.text && !p.thought);
    if (r.status === 200 && (gotTool || gotText)) {
      log(`OK (${r.secs.toFixed(1)}s${gotTool ? ', tools work' : ''})`);
      if (gotTool) {
        winner = { model, thinking };
        break;
      }
    } else if (r.status === 200) {
      log(`empty reply (${r.json?.candidates?.[0]?.finishReason || 'no candidates'})`);
    } else if (r.status === 'TIMEOUT') {
      log('no answer in 45s');
    } else {
      log(`error ${r.status}: ${(r.json?.error?.message || r.error || '').slice(0, 90)}`);
    }
  }
  if (winner) break;
}

if (!winner) {
  log('\n  Koi bhi model tool-calling ke saath kaam nahi kiya.');
  log('  Is window ka screenshot bhej do (isme key nahi dikhti).');
  bye(1);
}

const file = updateEnv({ GEMINI_API_KEY: key, GEMINI_MODEL: winner.model, GEMINI_REASONING: winner.thinking });
log(`\n  ✔ Kaam karne wala setup mil gaya: ${winner.model} (thinking=${winner.thinking})`);
log(`  ✔ ${path.basename(file)} update kar di.`);
log('\n  Ab start-windows.bat chalao. AI kaam karega.');
bye(0);
