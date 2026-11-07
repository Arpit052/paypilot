import { api, header, md, esc, renderSlip, toast } from './common.js';

const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const tray = $('tray');
let image = null;

// One conversation per browser; it's saved on the server, so it survives tab switches and reloads.
const store = (() => {
  try {
    localStorage.setItem('pp-test', '1');
    localStorage.removeItem('pp-test');
    return localStorage;
  } catch {
    return sessionStorage;
  }
})();
let sessionId = store.getItem('pp-session');
if (!sessionId) {
  sessionId = crypto.randomUUID();
  store.setItem('pp-session', sessionId);
}
const DRAFT_KEY = 'pp-draft';

const TOOL_LABEL = {
  list_invoices: 'checked invoices',
  get_client_insights: 'looked up client history',
  get_earnings_summary: 'summarised earnings',
  forecast_cashflow: 'ran cash-flow forecast',
  propose_invoice: 'drafted invoice',
  propose_late_fee: 'drafted late fee',
  propose_reminder: 'drafted reminder',
  propose_cancel: 'drafted cancellation',
  propose_recurring: 'drafted recurring schedule',
  get_top_customers: 'ranked customers',
};

function addMsg(kind, html) {
  $('welcome')?.remove();
  const d = document.createElement('div');
  d.className = `msg ${kind}`;
  d.innerHTML = html;
  log.append(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function updateTrayCount() {
  const pending = tray.querySelectorAll('.slip:not(.done)').length;
  $('trayCount').textContent = pending ? `${pending} waiting` : '';
  $('trayEmpty').classList.toggle('hidden', tray.children.length > 0);
}

function addSlip(action, prepend = true) {
  const el = renderSlip(action, {
    onGone: () => updateTrayCount(),
    onDone: (a) => {
      updateTrayCount();
      if (a.status === 'approved')
        toast(
          { create_invoice: `Invoice #${a.result.number} sent`, send_reminder: 'Reminder sent', cancel_invoice: 'Invoice cancelled', create_schedule: 'Recurring invoice scheduled' }[a.type]
        );
    },
  });
  prepend ? tray.prepend(el) : tray.append(el);
  updateTrayCount();
}

function botHtml(text, tools = []) {
  const used = [...new Set(tools)].map((t) => TOOL_LABEL[t] || t);
  return md(text || 'Done.') + (used.length ? `<span class="tools">${esc(used.join(', '))}</span>` : '');
}

function renderStored(m) {
  if (m.role === 'user') addMsg('user', (m.image ? `<span class="att-note">Screenshot attached</span><br>` : "") + esc(m.text));
  else if (m.role === 'bot') addMsg('bot', botHtml(m.text, m.tools));
  else addMsg('err', esc(m.text));
}

let typingEl = null;
let typingTick = null;
function showTyping(since = Date.now()) {
  hideTyping();
  typingEl = document.createElement('div');
  typingEl.className = 'typing';
  typingEl.textContent = 'Working';
  typingTick = setInterval(() => {
    const secs = Math.round((Date.now() - since) / 1000);
    typingEl.textContent = secs >= 5 ? `Working (${secs}s)` : 'Working';
  }, 1000);
  log.append(typingEl);
  log.scrollTop = log.scrollHeight;
}
function hideTyping() {
  clearInterval(typingTick);
  typingEl?.remove();
  typingEl = null;
}

/** The answer is still being prepared (we left the page mid-reply): wait for it. */
async function waitForReply(shown) {
  busy = true;
  $('sendBtn').disabled = true;
  showTyping();
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const h = await api(`/api/chat/history?sessionId=${encodeURIComponent(sessionId)}`).catch(() => null);
      if (h && !h.pending) {
        hideTyping();
        h.messages.slice(shown).forEach(renderStored);
        await loadTray();
        break;
      }
    }
  } finally {
    hideTyping();
    busy = false;
    $('sendBtn').disabled = false;
  }
}

let busy = false;
async function send(text) {
  if (busy || (!text.trim() && !image)) return;
  busy = true;
  const userHtml = (image ? `<img src="data:${image.mediaType};base64,${image.data}" alt="Attached screenshot">` : '') + esc(text);
  addMsg('user', userHtml);
  const payload = { sessionId, message: text, image };
  input.value = '';
  saveDraft();
  clearImage();
  autosize();
  $('sendBtn').disabled = true;
  showTyping();
  try {
    const r = await api('/api/chat', { body: payload });
    hideTyping();
    addMsg('bot', botHtml(r.reply, r.tools));
    r.actions.forEach((a) => addSlip(a));
  } catch (e) {
    hideTyping();
    addMsg('err', esc(e.message));
  } finally {
    hideTyping();
    busy = false;
    $('sendBtn').disabled = false;
    input.focus();
  }
}

// ---- image attach (button, paste, drop) ----
function setImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 8 * 1024 * 1024) return toast('Image is too large (max 8 MB)');
  const reader = new FileReader();
  reader.onload = () => {
    const [head, data] = String(reader.result).split(',');
    image = { mediaType: head.match(/data:(.*?);/)[1], data };
    $('imgPreview').innerHTML = `<img src="${reader.result}" alt=""> ${esc(file.name || 'Pasted image')} <button class="btn ghost small" type="button" id="rmImg">Remove</button>`;
    $('imgPreview').classList.remove('hidden');
    $('rmImg').onclick = clearImage;
  };
  reader.readAsDataURL(file);
}
function clearImage() {
  image = null;
  $('imgPreview').classList.add('hidden');
  $('imgPreview').innerHTML = '';
  $('file').value = '';
}
$('attachBtn').onclick = () => $('file').click();
$('file').onchange = (e) => setImage(e.target.files[0]);
document.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) setImage(f);
});
document.querySelector('.chat').addEventListener('dragover', (e) => e.preventDefault());
document.querySelector('.chat').addEventListener('drop', (e) => {
  e.preventDefault();
  setImage(e.dataTransfer.files[0]);
});

// ---- composer ----
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}
function saveDraft() {
  try {
    input.value ? store.setItem(DRAFT_KEY, input.value) : store.removeItem(DRAFT_KEY);
  } catch {}
}
input.addEventListener('input', () => {
  autosize();
  saveDraft();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
});
$('composer').onsubmit = (e) => {
  e.preventDefault();
  send(input.value);
};
$('chips')?.addEventListener('click', (e) => {
  if (e.target.matches('.chip')) send(e.target.textContent);
});
$('newChat').onclick = async () => {
  await api('/api/chat/reset', { body: { sessionId } }).catch(() => {});
  sessionId = crypto.randomUUID();
  store.setItem('pp-session', sessionId);
  location.reload();
};

// ---- boot ----
const cfg = await header('chat');
// sample prompts that name demo clients only make sense while the demo data is loaded
if (!cfg.demoPersona) document.querySelectorAll('#chips [data-demo]').forEach((b) => b.remove());
else if (cfg.typeItems?.[0] && document.getElementById('billChip')) {
  const it = cfg.typeItems[0];
  document.getElementById('billChip').textContent = `Bill Rachel Adams (rachel@summitpeakconsulting.com) for ${it.name.replace(/\s*\(.*\)$/, '').toLowerCase()} at $${it.price}, due in 15 days`;
}
if (cfg.llmProvider === 'none') {
  addMsg('err', 'AI is not configured yet. Add <b>ANTHROPIC_API_KEY</b> or <b>OPENAI_API_KEY</b> to your <code>.env</code> file and restart the server.');
}
async function loadTray() {
  const trays = await Promise.all(['schedule', 'form', 'chat'].map((o) => api(`/api/actions?status=pending&origin=${o}`)));
  tray.innerHTML = '';
  trays.flatMap((t) => t.actions).forEach((a) => addSlip(a, false));
  updateTrayCount();
}
await loadTray();

// bring back the conversation (and a half-typed message) from before
const saved = await api(`/api/chat/history?sessionId=${encodeURIComponent(sessionId)}`).catch(() => ({ messages: [], pending: false }));
saved.messages.forEach(renderStored);
try {
  const draft = store.getItem(DRAFT_KEY);
  if (draft && !input.value) {
    input.value = draft;
    autosize();
  }
} catch {}
if (saved.pending) waitForReply(saved.messages.length);
// "/?ask=..." (e.g. from an invoice's timeline): pre-fill the question so the user can send it
const ask = new URLSearchParams(location.search).get('ask');
if (ask) {
  input.value = ask.slice(0, 500);
  autosize();
  input.focus();
  history.replaceState(null, '', '/assistant');
}
