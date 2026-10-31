import { api, header, md, esc, renderSlip, toast } from './common.js';

const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const tray = $('tray');
let image = null;

let sessionId = sessionStorage.getItem('pp-session');
if (!sessionId) {
  sessionId = crypto.randomUUID();
  sessionStorage.setItem('pp-session', sessionId);
}

const TOOL_LABEL = {
  list_invoices: 'checked invoices',
  get_client_insights: 'looked up client history',
  get_earnings_summary: 'summarised earnings',
  forecast_cashflow: 'ran cash-flow forecast',
  propose_invoice: 'drafted invoice',
  propose_reminder: 'drafted reminder',
  propose_cancel: 'drafted cancellation',
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
    onDone: (a) => {
      updateTrayCount();
      if (a.status === 'approved') toast(a.type === 'create_invoice' ? `Invoice #${a.result.number} sent` : a.type === 'send_reminder' ? 'Reminder sent' : 'Invoice cancelled');
    },
  });
  prepend ? tray.prepend(el) : tray.append(el);
  updateTrayCount();
}

let busy = false;
async function send(text) {
  if (busy || (!text.trim() && !image)) return;
  busy = true;
  const userHtml = (image ? `<img src="data:${image.mediaType};base64,${image.data}" alt="Attached screenshot">` : '') + esc(text);
  addMsg('user', userHtml);
  const payload = { sessionId, message: text, image };
  input.value = '';
  clearImage();
  autosize();
  $('sendBtn').disabled = true;
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.textContent = 'Working';
  const started = Date.now();
  const tick = setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    typing.textContent = secs >= 5 ? `Working (${secs}s)` : 'Working';
  }, 1000);
  log.append(typing);
  log.scrollTop = log.scrollHeight;
  try {
    const r = await api('/api/chat', { body: payload });
    typing.remove();
    const used = [...new Set(r.tools)].map((t) => TOOL_LABEL[t] || t);
    addMsg('bot', md(r.reply || 'Done.') + (used.length ? `<span class="tools">${esc(used.join(', '))}</span>` : ''));
    r.actions.forEach((a) => addSlip(a));
  } catch (e) {
    typing.remove();
    addMsg('err', esc(e.message));
  } finally {
    clearInterval(tick);
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
input.addEventListener('input', autosize);
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
  location.reload();
};

// ---- boot ----
const cfg = await header('chat');
if (cfg.llmProvider === 'none') {
  addMsg('err', 'AI is not configured yet. Add <b>ANTHROPIC_API_KEY</b> or <b>OPENAI_API_KEY</b> to your <code>.env</code> file and restart the server.');
}
const { actions } = await api('/api/actions?status=pending&origin=chat');
actions.forEach((a) => addSlip(a, false));
updateTrayCount();
